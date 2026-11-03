package integration

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	sliccbrowsers "github.com/ai-ecoverse/slicc-browsers"
)

func TestDebuggerStage1DataAndSchemaAreEmbedded(t *testing.T) {
	vectors, err := sliccbrowsers.DebuggerStage1()
	if err != nil {
		t.Fatal(err)
	}
	if vectors.SchemaVersion != sliccbrowsers.Schema || len(vectors.Methods) == 0 || len(vectors.Rows) == 0 {
		t.Fatal("missing Stage1 corpus")
	}
	decoder := json.NewDecoder(bytes.NewReader(sliccbrowsers.DebuggerStage1JSON()))
	decoder.DisallowUnknownFields()
	var strict sliccbrowsers.DebuggerStage1Vectors
	if err := decoder.Decode(&strict); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*vectors, strict) {
		t.Fatal("typed Stage1 accessor lost data")
	}
	back, err := json.Marshal(vectors)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decode(t, back), decode(t, sliccbrowsers.DebuggerStage1JSON())) {
		t.Fatal("Stage1 corpus did not round-trip")
	}
	schema := decode(t, sliccbrowsers.DebuggerStage1SchemaJSON()).(map[string]any)
	if !strings.HasSuffix(schema["$id"].(string), "/schema/debugger-stage1.schema.json") {
		t.Fatal("Stage1 schema missing")
	}
	for _, get := range []func() []byte{sliccbrowsers.DebuggerStage1JSON, sliccbrowsers.DebuggerStage1SchemaJSON} {
		first := get()
		before := bytes.Clone(first)
		first[0] ^= 1
		if !bytes.Equal(get(), before) {
			t.Fatal("raw Stage1 accessor leaked the embedded buffer")
		}
	}
}
