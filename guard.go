package sliccbrowsers

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed guard-vectors.json
var guardVectorsJSON []byte

//go:embed schema/guard-vectors.schema.json
var guardVectorsSchemaJSON []byte

const (
	GuardTargetSeven  = "seven"
	GuardTargetVault  = "vault"
	GuardTargetVaultX = "vault-x"
	GuardTargetApex   = "apex"
	GuardTargetOwn    = "own"
	GuardOrdinary     = "ordinary"
	GuardSameSite     = "ordinary-same-site"
	GuardKindCDP      = "cdp"
	GuardKindText     = "text"
	GuardViaGuard     = "guard"
	GuardViaUnguarded = "unguarded"
	GuardScopeAny     = "any"
	GuardControl      = "control"
	GuardGuarded      = "guarded"

	GuardCapAutoAttach      = "autoAttach"
	GuardCapBrowserSession  = "browserSession"
	GuardCapBrowserContexts = "browserContexts"
	GuardSessionPage        = "page"
	GuardSessionBrowser     = "browser"
	GuardSessionEither      = "page-or-browser"
	GuardSessionChild       = "child"
)

type GuardVectors struct {
	SchemaVersion int                    `json:"schemaVersion"`
	SetVersion    string                 `json:"setVersion"`
	Sources       []GuardSource          `json:"sources"`
	Targets       map[string]GuardTarget `json:"targets"`
	Variants      map[string]int         `json:"variants"`
	Capabilities  map[string]string      `json:"capabilities"`
	Placeholders  map[string]string      `json:"placeholders"`
	Vectors       []GuardVector          `json:"vectors"`
}

type GuardTarget struct {
	Host        string `json:"host,omitempty"`
	Description string `json:"description"`
}

type GuardSource struct {
	Repo string `json:"repo"`
	Ref  string `json:"ref"`
	Path string `json:"path"`
}

type GuardVector struct {
	ID              string                      `json:"id"`
	Family          string                      `json:"family"`
	Kind            string                      `json:"kind"`
	Scope           string                      `json:"scope"`
	Setup           []GuardStep                 `json:"setup"`
	Trigger         []GuardStep                 `json:"trigger"`
	Targets         []string                    `json:"targets"`
	Requires        []string                    `json:"requires,omitempty"`
	Observe         map[string]GuardObservation `json:"observe,omitempty"`
	Live            string                      `json:"live"`
	Control         GuardControlRun             `json:"control"`
	Expected        GuardExpected               `json:"expected"`
	Skip            *GuardSkip                  `json:"skip,omitempty"`
	DesignDependent []string                    `json:"designDependent,omitempty"`
	Observable      *GuardObservable            `json:"observable,omitempty"`
	AppliesTo       []string                    `json:"appliesTo,omitempty"`
}

type GuardObservation struct {
	Means     string   `json:"means"`
	DependsOn []string `json:"dependsOn,omitzero"`
	Requires  []string `json:"requires,omitempty"`
}

type GuardObservable struct {
	Own *bool `json:"own,omitempty"`
}

type GuardOutcome struct {
	Value  bool
	Either bool
}

func (o GuardOutcome) MarshalJSON() ([]byte, error) {
	if o.Either {
		return json.Marshal("either")
	}
	return json.Marshal(o.Value)
}

func (o *GuardOutcome) UnmarshalJSON(b []byte) error {
	var text string
	if json.Unmarshal(b, &text) == nil {
		if text != "either" {
			return fmt.Errorf("guard outcome %q is neither a boolean nor either", text)
		}
		*o = GuardOutcome{Either: true}
		return nil
	}
	*o = GuardOutcome{}
	return json.Unmarshal(b, &o.Value)
}

type GuardControlRun struct {
	Origin   string        `json:"origin"`
	Via      string        `json:"via"`
	Expected GuardExpected `json:"expected"`
}

type GuardSkip struct {
	Target string `json:"target"`
	Reason string `json:"reason"`
}

type GuardExpected struct {
	Checks map[string]GuardOutcome
	Text   string
}

func (e GuardExpected) MarshalJSON() ([]byte, error) {
	if e.Checks != nil {
		return json.Marshal(e.Checks)
	}
	return json.Marshal(e.Text)
}

func (e *GuardExpected) UnmarshalJSON(b []byte) error {
	if bytes.HasPrefix(bytes.TrimSpace(b), []byte(`"`)) {
		e.Checks = nil
		return json.Unmarshal(b, &e.Text)
	}
	e.Text = ""
	return json.Unmarshal(b, &e.Checks)
}

type GuardStep struct {
	Text        string          `json:"text,omitempty"`
	CDP         string          `json:"cdp,omitempty"`
	Params      json.RawMessage `json:"params,omitempty"`
	Refusable   bool            `json:"refusable,omitempty"`
	Refusal     *GuardRefusal   `json:"refusal,omitempty"`
	Page        string          `json:"page,omitempty"`
	URL         string          `json:"url,omitempty"`
	Hops        []GuardHop      `json:"hops,omitempty"`
	From        string          `json:"from,omitempty"`
	Context     string          `json:"context,omitempty"`
	Expression  string          `json:"expression,omitempty"`
	Credentials string          `json:"credentials,omitempty"`
	Status      bool            `json:"status,omitempty"`
	Background  *bool           `json:"background,omitempty"`
	Answer      *GuardAnswer    `json:"answer,omitempty"`
	Children    []GuardStep     `json:"children,omitempty"`
	Settle      *GuardSettle    `json:"settle,omitempty"`
	Wait        *int            `json:"wait,omitempty"`
	Guess       *GuardGuess     `json:"guess,omitempty"`
	Session     string          `json:"session,omitempty"`
	As          string          `json:"as,omitempty"`
	On          string          `json:"on,omitempty"`
	Requires    []string        `json:"requires,omitempty"`
}

type GuardRefusal struct {
	Match string `json:"match"`
}

type GuardHop struct {
	Origin string `json:"origin"`
	Code   int    `json:"code"`
}

type GuardAnswer struct {
	URL    string          `json:"url"`
	Stage  string          `json:"stage,omitempty"`
	CDP    string          `json:"cdp,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Hold   bool            `json:"hold,omitempty"`
}

type GuardSettle struct {
	Beacon  string `json:"beacon,omitempty"`
	Title   string `json:"title,omitempty"`
	MS      int    `json:"ms,omitempty"`
	Variant bool   `json:"variant,omitempty"`
	Session string `json:"session,omitempty"`
}

type GuardGuess struct {
	Between []string        `json:"between"`
	CDP     string          `json:"cdp"`
	Params  json.RawMessage `json:"params"`
}

func GuardVectorsJSON() []byte {
	return bytes.Clone(guardVectorsJSON)
}

func GuardVectorsSchemaJSON() []byte {
	return bytes.Clone(guardVectorsSchemaJSON)
}

func Guard() (*GuardVectors, error) {
	var v GuardVectors
	if err := json.Unmarshal(guardVectorsJSON, &v); err != nil {
		return nil, fmt.Errorf("slicc-browsers guard vectors: %w", err)
	}
	if v.SchemaVersion != Schema {
		return nil, fmt.Errorf("slicc-browsers guard vectors: schema %d, want %d", v.SchemaVersion, Schema)
	}
	return &v, nil
}
