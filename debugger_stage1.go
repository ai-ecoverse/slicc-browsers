package sliccbrowsers

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed debugger-stage1.json
var debuggerStage1JSON []byte

//go:embed schema/debugger-stage1.schema.json
var debuggerStage1SchemaJSON []byte

type DebuggerStage1Vectors struct {
	SchemaVersion  int                          `json:"schemaVersion"`
	Methods        []DebuggerStage1Method       `json:"methods"`
	Rows           []DebuggerStage1Row          `json:"rows"`
	Navigation     []string                     `json:"navigation"`
	LeaseRefusals  []string                     `json:"leaseRefusals"`
	RescueEvidence DebuggerStage1RescueEvidence `json:"rescueEvidence"`
}

type DebuggerStage1Method struct {
	Method                   string `json:"method"`
	Lifetime                 string `json:"lifetime"`
	Admitted                 bool   `json:"admitted"`
	OwnedInstrumentationOnly *bool  `json:"ownedInstrumentationOnly,omitempty"`
}

type DebuggerStage1Row struct {
	ID          string          `json:"id"`
	Mode        string          `json:"mode"`
	Destination string          `json:"destination"`
	Expected    map[string]bool `json:"expected"`
	Requires    []string        `json:"requires"`
}

type DebuggerStage1RescueEvidence struct {
	Origin              string `json:"origin"`
	NoObserverResume    bool   `json:"noObserverResume"`
	OwnerUnchanged      bool   `json:"ownerUnchanged"`
	GenerationUnchanged bool   `json:"generationUnchanged"`
	DeadlineUnchanged   bool   `json:"deadlineUnchanged"`
}

func DebuggerStage1JSON() []byte {
	return bytes.Clone(debuggerStage1JSON)
}

func DebuggerStage1SchemaJSON() []byte {
	return bytes.Clone(debuggerStage1SchemaJSON)
}

func DebuggerStage1() (*DebuggerStage1Vectors, error) {
	var v DebuggerStage1Vectors
	if err := json.Unmarshal(debuggerStage1JSON, &v); err != nil {
		return nil, fmt.Errorf("slicc-browsers debugger stage1 vectors: %w", err)
	}
	if v.SchemaVersion != Schema {
		return nil, fmt.Errorf("slicc-browsers debugger stage1 vectors: schema %d, want %d", v.SchemaVersion, Schema)
	}
	return &v, nil
}
