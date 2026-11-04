package sliccbrowsers

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed protected.json
var protectedJSON []byte

//go:embed schema/protected.schema.json
var protectedSchemaJSON []byte

const (
	OpenerProtected   = "protected"
	OpenerUnprotected = "unprotected"
	OpenerUnknown     = "unknown"
)

type ErrorPageRule struct {
	URL    string `json:"url"`
	Target string `json:"target"`
	Redact string `json:"redact"`
}

type ExtensionFrameRule struct {
	Schemes           []string `json:"schemes"`
	WhenShown         []string `json:"whenShown"`
	WhilePresent      []string `json:"whilePresent"`
	InputWhilePresent []string `json:"inputWhilePresent"`
	ShownRefusal      string   `json:"shownRefusal"`
	PresentRefusal    string   `json:"presentRefusal"`
	InputRefusal      string   `json:"inputRefusal"`
}

type ProtectedOrigins struct {
	ErrorPage          ErrorPageRule      `json:"errorPage"`
	Domains            []string           `json:"domains"`
	Hosts              []string           `json:"hosts"`
	Schemes            []string           `json:"schemes"`
	InnerSchemes       []string           `json:"innerSchemes"`
	AnySchemes         []string           `json:"anySchemes"`
	ProtectedSchemes   []string           `json:"protectedSchemes"`
	SchemeExceptions   []string           `json:"schemeExceptions"`
	AboutScheme        string             `json:"aboutScheme"`
	TargetTypes        []string           `json:"targetTypes"`
	Inheriting         []string           `json:"inheriting"`
	Unparseable        string             `json:"unparseable"`
	UnparseableRefusal string             `json:"unparseableRefusal"`
	ExtensionFrames    ExtensionFrameRule `json:"extensionFrames"`
	Refusal            string             `json:"refusal"`
}

type ProtectedVectors struct {
	ErrorPage          ErrorPageRule  `json:"errorPage"`
	Unparseable        string         `json:"unparseable"`
	UnparseableRefusal string         `json:"unparseableRefusal"`
	Schema             int            `json:"schema"`
	Origins            []string       `json:"origins"`
	URLs               []URLVector    `json:"urls"`
	Targets            []TargetVector `json:"targets"`
	CookieDomains      []CookieVector `json:"cookieDomains"`
	StorageKeys        []KeyVector    `json:"storageKeys"`
}

type URLVector struct {
	URL       string `json:"url"`
	Protected bool   `json:"protected"`
}

type TargetVector struct {
	DocumentURL    string `json:"documentURL,omitempty"`
	UnreachableURL string `json:"unreachableURL,omitempty"`
	Navigating     bool   `json:"navigating,omitempty"`
	URL            string `json:"url"`
	Type           string `json:"type,omitempty"`
	Previous       bool   `json:"previous,omitempty"`
	Opener         string `json:"opener,omitempty"`
	Protected      bool   `json:"protected"`
}

type CookieVector struct {
	Domain    string `json:"domain"`
	Protected bool   `json:"protected"`
}

type KeyVector struct {
	Key       string `json:"key"`
	Protected bool   `json:"protected"`
}

func ProtectedJSON() []byte {
	return bytes.Clone(protectedJSON)
}

func ProtectedSchemaJSON() []byte {
	return bytes.Clone(protectedSchemaJSON)
}

func Protected() (*ProtectedVectors, error) {
	var v ProtectedVectors
	if err := json.Unmarshal(protectedJSON, &v); err != nil {
		return nil, fmt.Errorf("slicc-browsers protected vectors: %w", err)
	}
	if v.Schema != Schema {
		return nil, fmt.Errorf("slicc-browsers protected vectors: schema %d, want %d", v.Schema, Schema)
	}
	return &v, nil
}
