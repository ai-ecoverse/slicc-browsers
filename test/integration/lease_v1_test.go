package integration

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	sliccbrowsers "github.com/ai-ecoverse/slicc-browsers"
)

func TestLeaseV1KnownAnswers(t *testing.T) {
	type stream struct {
		Opened         struct{ Nonce string }
		Proof          struct{ Sig string }
		TranscriptHex  string
		ProofRecordHex string
	}
	var v struct {
		JWT           string
		IssuerJwk     struct{ X string }
		HolderJwk     struct{ X string }
		Claims        struct{ Cnf struct{ Jkt string } }
		RequestStream stream
		DataStream    stream
	}
	for _, get := range []func() []byte{sliccbrowsers.LeaseV1JSON, sliccbrowsers.LeaseScopeV1JSON, sliccbrowsers.LeaseV1SchemaJSON} {
		data := get()
		if !json.Valid(data) {
			t.Fatal("invalid embedded fixture")
		}
		data[0] = 0
		if !json.Valid(get()) {
			t.Fatal("shared mutable fixture")
		}
	}
	if err := json.Unmarshal(sliccbrowsers.LeaseV1JSON(), &v); err != nil {
		t.Fatal(err)
	}
	raw := func(s string, n int) []byte {
		t.Helper()
		b, err := base64.RawURLEncoding.Strict().DecodeString(s)
		if err != nil || len(b) != n {
			t.Fatal("invalid fixture encoding")
		}
		return b
	}
	jwt := strings.Split(v.JWT, ".")
	if len(jwt) != 3 || !ed25519.Verify(raw(v.IssuerJwk.X, 32), []byte(strings.Join(jwt[:2], ".")), raw(jwt[2], 64)) {
		t.Fatal("invalid issuer signature")
	}
	canonical, err := json.Marshal(map[string]string{"x": v.HolderJwk.X, "kty": "OKP", "crv": "Ed25519"})
	if err != nil {
		t.Fatal(err)
	}
	thumb := sha256.Sum256(canonical)
	if !bytes.Equal(raw(v.Claims.Cnf.Jkt, 32), thumb[:]) {
		t.Fatal("thumbprint differs")
	}
	for mode, s := range map[string]stream{"request": v.RequestStream, "data": v.DataStream} {
		t.Run(mode, func(t *testing.T) {
			binding := thumb
			if mode == "data" {
				binding = sha256.Sum256([]byte(v.JWT))
			}
			msg := []byte("slicc-cdp-lease-v1:" + mode + "\x00")
			msg = append(msg, raw(s.Opened.Nonce, 32)...)
			msg = append(msg, binding[:]...)
			if hex.EncodeToString(msg) != s.TranscriptHex || !ed25519.Verify(raw(v.HolderJwk.X, 32), msg, raw(s.Proof.Sig, 64)) {
				t.Fatal("invalid holder transcript")
			}
			body, err := json.Marshal(map[string]string{"type": "proof", "sig": s.Proof.Sig})
			if err != nil {
				t.Fatal(err)
			}
			framed, err := hex.DecodeString(s.ProofRecordHex)
			if err != nil || len(framed) < 4 || int(binary.BigEndian.Uint32(framed)) != len(body) {
				t.Fatal("invalid proof record length")
			}
			var result struct {
				Type string
				Sig  string
			}
			if err := json.Unmarshal(framed[4:], &result); err != nil || result.Type != "proof" || result.Sig != s.Proof.Sig {
				t.Fatal("wrong framed proof")
			}
		})
	}
}
