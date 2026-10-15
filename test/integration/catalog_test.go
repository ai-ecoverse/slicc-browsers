package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	sliccbrowsers "github.com/ai-ecoverse/slicc-browsers"
)

func decode(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestIsSevenLabel(t *testing.T) {
	seven := sliccbrowsers.Default().Seven
	for _, label := range []string{"seven", "link-websockets"} {
		if !seven.IsSevenLabel(label) {
			t.Errorf("IsSevenLabel(%q) = false, want true", label)
		}
	}
	for _, label := range []string{"", "www", "vault", "vault-preview", "get", "mcpcat", "vault-feature-x"} {
		if seven.IsSevenLabel(label) {
			t.Errorf("IsSevenLabel(%q) = true, want false", label)
		}
	}
}

func TestSevenWithoutPrefixesRoundTrips(t *testing.T) {
	original := []byte(`{"originScheme":"https","originHostPattern":"^x$","excludedLabels":["www"],"sitePattern":"s","switches":[],"disabledFeatures":[],"prefs":[],"discardExceptions":[],"cleanExit":[]}`)
	var s sliccbrowsers.Seven
	if err := json.Unmarshal(original, &s); err != nil {
		t.Fatal(err)
	}
	if len(s.ExcludedLabelPrefixes) != 0 {
		t.Fatalf("expected nil/empty prefixes, got %v", s.ExcludedLabelPrefixes)
	}
	back, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decode(t, back), decode(t, original)) {
		t.Fatalf("round-trip failed:\n  got  %s\n  want %s", back, original)
	}
	if s.IsSevenLabel("vault") != true {
		t.Error("IsSevenLabel(vault) should be true without excludedLabelPrefixes")
	}
}

func TestTheTypedCatalogCoversEveryField(t *testing.T) {
	d := json.NewDecoder(bytes.NewReader(sliccbrowsers.CatalogJSON()))
	d.DisallowUnknownFields()
	var c sliccbrowsers.Catalog
	if err := d.Decode(&c); err != nil {
		t.Fatal(err)
	}
	back, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decode(t, back), decode(t, sliccbrowsers.CatalogJSON())) {
		t.Fatal("catalog.json does not round-trip through the Go types")
	}
	def := sliccbrowsers.Default()
	if def.Schema != sliccbrowsers.Schema || len(def.Browsers) != len(c.Browsers) {
		t.Fatalf("Default: schema %d, %d browsers", def.Schema, len(def.Browsers))
	}
	if def.Priority("chrome") != 0 || def.Priority("edge") != 1 || def.Priority("nope") != len(def.Browsers) {
		t.Fatal("Priority follows the catalog order")
	}
	if b, ok := def.Browser("chromium"); !ok || b.Linux.Snap != "chromium" {
		t.Fatalf("Browser(chromium) = %+v, %v", b, ok)
	}
	if _, err := sliccbrowsers.Parse([]byte(`{"schema":2}`)); err == nil {
		t.Fatal("Parse accepts schema 2")
	}
}

func TestTheSchemasAreEmbedded(t *testing.T) {
	for name, b := range map[string][]byte{"catalog": sliccbrowsers.CatalogSchemaJSON(), "browsers": sliccbrowsers.BrowsersSchemaJSON()} {
		v, ok := decode(t, b).(map[string]any)
		if !ok || !strings.HasSuffix(v["$id"].(string), "/schema/"+name+".schema.json") {
			t.Fatalf("%s schema: %v", name, v["$id"])
		}
	}
}

type layoutVector struct {
	OS           string              `json:"os"`
	Home         string              `json:"home"`
	Env          map[string]string   `json:"env"`
	Tokens       map[string]*string  `json:"tokens"`
	UserDataDirs map[string][]string `json:"userDataDirs"`
	Expand       map[string]string   `json:"expand"`
}

func TestLayoutsMatchTheSharedVectors(t *testing.T) {
	b, err := os.ReadFile("layout.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []layoutVector
	if err := json.Unmarshal(b, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		l := sliccbrowsers.Layout{OS: v.OS, Home: v.Home, Getenv: func(k string) string { return v.Env[k] }}
		for tok, want := range v.Tokens {
			got, ok := l.Token(tok)
			if want == nil {
				if ok {
					t.Errorf("%s %s = %q, want none", v.OS, tok, got)
				}
				continue
			}
			if !ok || got != *want {
				t.Errorf("%s %s = %q, want %q", v.OS, tok, got, *want)
			}
		}
		for id, want := range v.UserDataDirs {
			if got := l.UserDataDirs(id); !slices.Equal(got, want) {
				t.Errorf("%s %s dirs = %q, want %q", v.OS, id, got, want)
			}
		}
		for in, want := range v.Expand {
			if got := l.Expand(in); got != want {
				t.Errorf("%s Expand(%q) = %q, want %q", v.OS, in, got, want)
			}
		}
	}
}

func TestEveryCaseExpandsOnEveryOSItRunsOn(t *testing.T) {
	cases, err := sliccbrowsers.Corpus()
	if err != nil || len(cases) == 0 {
		t.Fatalf("corpus: %v, %d cases", err, len(cases))
	}
	all := []string{
		sliccbrowsers.NeedUserDataDirs, sliccbrowsers.NeedProfiles, sliccbrowsers.NeedFlag, sliccbrowsers.NeedProcess,
		sliccbrowsers.NeedProbe, sliccbrowsers.NeedOrigins, sliccbrowsers.NeedInstalled, sliccbrowsers.NeedSix,
	}
	for _, c := range cases {
		for _, goos := range []string{"darwin", "linux", "windows"} {
			if !c.Runs(goos, all...) {
				continue
			}
			home := "/h"
			if goos == "windows" {
				home = `C:\h`
			}
			l := sliccbrowsers.Layout{OS: goos, Home: home}
			for path := range c.Files(l) {
				if strings.Contains(path, "{") || !strings.HasPrefix(path, home) {
					t.Errorf("%s %s: file %q", c.Name, goos, path)
				}
			}
			exp, err := c.ExpectedJSON(l)
			if err != nil || bytes.Contains(exp, []byte("{home}")) || bytes.Contains(exp, []byte("{sevenProfiles}")) || bytes.Contains(exp, []byte("{sixProfiles}")) {
				t.Errorf("%s %s: expected %s, %v", c.Name, goos, exp, err)
			}
			if n := strings.Count(c.PSOutput(l, 77), "\n"); n != len(c.Input.Processes) {
				t.Errorf("%s: %d ps lines", c.Name, n)
			}
			var rows []map[string]any
			if err := json.Unmarshal([]byte(c.CIMOutput(l, 77)), &rows); err != nil || len(rows) != len(c.Input.Processes)+1 {
				t.Errorf("%s: CIM %v, %d rows", c.Name, err, len(rows))
			}
		}
	}
}

func TestTheFakeServesOnlyItsPorts(t *testing.T) {
	cases, _ := sliccbrowsers.Corpus()
	i := slices.IndexFunc(cases, func(c sliccbrowsers.Case) bool { return c.Name == "dedupe" })
	if i < 0 {
		t.Fatal("no dedupe case")
	}
	c := cases[i]
	client := &http.Client{Transport: c.Transport()}
	get := func(url string) (int, string, error) {
		resp, err := client.Get(url)
		if err != nil {
			return 0, "", err
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), nil
	}
	if code, body, err := get("http://localhost:9391/json/version"); err != nil || code != 200 || !strings.Contains(body, "/devtools/browser/d1") {
		t.Fatalf("version: %d %q %v", code, body, err)
	}
	if code, _, err := get("http://127.0.0.1:9391/json/new"); err != nil || code != 404 {
		t.Fatalf("other path: %d %v", code, err)
	}
	if _, _, err := get("http://127.0.0.1:1/json/version"); err == nil {
		t.Fatal("an unlisted port answers")
	}
	if conn, err := c.DialContext(context.Background(), "tcp", "127.0.0.1:9392"); err != nil {
		t.Fatal(err)
	} else {
		_ = conn.Close()
	}
	if _, err := c.DialContext(context.Background(), "tcp", "127.0.0.1:9222"); err == nil {
		t.Fatal("9222 is never fake")
	}
}

func TestTheProtectedVectorsParse(t *testing.T) {
	d := json.NewDecoder(bytes.NewReader(sliccbrowsers.ProtectedJSON()))
	d.DisallowUnknownFields()
	var raw sliccbrowsers.ProtectedVectors
	if err := d.Decode(&raw); err != nil {
		t.Fatal(err)
	}
	v, err := sliccbrowsers.Protected()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*v, raw) || len(v.Origins) == 0 || len(v.URLs) == 0 || len(v.Targets) == 0 || len(v.CookieDomains) == 0 || len(v.StorageKeys) == 0 {
		t.Fatalf("vectors: %+v", v)
	}
	openers := []string{"", sliccbrowsers.OpenerProtected, sliccbrowsers.OpenerUnprotected, sliccbrowsers.OpenerUnknown}
	for _, tv := range v.Targets {
		if !slices.Contains(openers, tv.Opener) {
			t.Fatalf("target vector %+v has opener %q", tv, tv.Opener)
		}
	}
	po := sliccbrowsers.Default().ProtectedOrigins
	if !slices.Contains(po.Domains, "sliccy.ai") || !slices.Contains(po.Hosts, "vault.sliccy.ai") || !slices.Contains(po.Schemes, "https") || po.Refusal != "slicc: refused: target is on seven's origin" {
		t.Fatalf("protectedOrigins: %+v", po)
	}
	s, ok := decode(t, sliccbrowsers.ProtectedSchemaJSON()).(map[string]any)
	if !ok || !strings.HasSuffix(s["$id"].(string), "/schema/protected.schema.json") {
		t.Fatalf("protected schema: %v", s["$id"])
	}
}

func TestTheGuardVectorsParse(t *testing.T) {
	d := json.NewDecoder(bytes.NewReader(sliccbrowsers.GuardVectorsJSON()))
	d.DisallowUnknownFields()
	var raw sliccbrowsers.GuardVectors
	if err := d.Decode(&raw); err != nil {
		t.Fatal(err)
	}
	v, err := sliccbrowsers.Guard()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*v, raw) || len(v.Vectors) == 0 {
		t.Fatalf("guard vectors: %d", len(v.Vectors))
	}
	back, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decode(t, back), decode(t, sliccbrowsers.GuardVectorsJSON())) {
		t.Fatal("guard vectors don't round-trip")
	}
	targets := []string{sliccbrowsers.GuardTargetSeven, sliccbrowsers.GuardTargetVault, sliccbrowsers.GuardTargetVaultX, sliccbrowsers.GuardTargetApex, sliccbrowsers.GuardTargetOwn}
	for _, tg := range append([]string{sliccbrowsers.GuardOrdinary, sliccbrowsers.GuardSameSite}, targets...) {
		if v.Targets[tg].Description == "" {
			t.Fatalf("target %s: %+v", tg, v.Targets)
		}
	}
	if v.Variants["prompt"] != 0 || v.Variants["lagging"] != 8000 {
		t.Fatalf("variants: %v", v.Variants)
	}
	ids := map[string]bool{}
	for _, g := range v.Vectors {
		kind := g.Kind == sliccbrowsers.GuardKindCDP || g.Kind == sliccbrowsers.GuardKindText
		via := g.Control.Via == sliccbrowsers.GuardViaGuard || g.Control.Via == sliccbrowsers.GuardViaUnguarded
		if ids[g.ID] || g.Control.Origin != sliccbrowsers.GuardOrdinary || !kind || !via {
			t.Fatalf("vector %s", g.ID)
		}
		ids[g.ID] = true
		for _, tg := range g.Targets {
			if !slices.Contains(targets, tg) {
				t.Fatalf("vector %s targets %s", g.ID, tg)
			}
		}
	}
	for _, id := range []string{"C1.script-nav", "C5.guessed-id", "C6.storage", "C1.href", "C6.clearDataForOrigin", "E6.headers", "E6.locale", "C5.guessed-id.continue-with-auth", "B7"} {
		if !ids[id] {
			t.Fatalf("no vector %s", id)
		}
	}
	for _, c := range []string{sliccbrowsers.GuardCapAutoAttach, sliccbrowsers.GuardCapBrowserSession, sliccbrowsers.GuardCapBrowserContexts} {
		if v.Capabilities[c] == "" {
			t.Fatalf("capability %s: %v", c, v.Capabilities)
		}
	}
	for _, g := range v.Vectors {
		switch g.ID {
		case "C3.popup":
			if !slices.Contains(g.Requires, sliccbrowsers.GuardCapAutoAttach) || !slices.Contains(g.Observe["attached"].Requires, sliccbrowsers.GuardCapAutoAttach) {
				t.Fatalf("C3.popup requires %v", g.Requires)
			}
		case "E3.bypass-csp":
			if !slices.Equal(g.Observe["inline"].DependsOn, []string{"refused.2"}) || g.Observe["served"].DependsOn == nil {
				t.Fatalf("E3.bypass-csp observes %+v", g.Observe)
			}
		}
	}
	s, ok := decode(t, sliccbrowsers.GuardVectorsSchemaJSON()).(map[string]any)
	if !ok || !strings.HasSuffix(s["$id"].(string), "/schema/guard-vectors.schema.json") {
		t.Fatalf("guard schema: %v", s["$id"])
	}
}
