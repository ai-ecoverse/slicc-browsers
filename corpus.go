package sliccbrowsers

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

//go:embed corpus.json
var corpusJSON []byte

const (
	NeedUserDataDirs = "user-data-dirs"
	NeedProfiles     = "seven-profiles"
	NeedFlag         = "flag"
	NeedProcess      = "process"
	NeedProbe        = "probe"
	NeedOrigins      = "origins"
	NeedInstalled    = "installed"
	NeedSix          = "six"
)

type Case struct {
	Name     string          `json:"name"`
	Input    Input           `json:"case"`
	Expected json.RawMessage `json:"expected"`
}

type Input struct {
	Description string            `json:"description"`
	OS          []string          `json:"os,omitempty"`
	Needs       []string          `json:"needs"`
	Env         map[string]string `json:"env,omitempty"`
	Files       map[string]string `json:"files,omitempty"`
	CDP         []string          `json:"cdp,omitempty"`
	Origins     []string          `json:"origins,omitempty"`
	ProbePorts  []int             `json:"probePorts,omitempty"`
	Processes   []FakeProcess     `json:"processes,omitempty"`
	HTTP        map[string]Server `json:"http,omitempty"`
	Installed   json.RawMessage   `json:"installed,omitempty"`
	Auto        *string           `json:"auto,omitempty"`
}

type FakeProcess struct {
	PID     int    `json:"pid"`
	Self    bool   `json:"self,omitempty"`
	Command string `json:"command"`
}

type Server struct {
	Version json.RawMessage `json:"version,omitempty"`
	List    json.RawMessage `json:"list,omitempty"`
}

func CorpusJSON() []byte {
	return bytes.Clone(corpusJSON)
}

func Corpus() ([]Case, error) {
	var doc struct {
		Schema int    `json:"schema"`
		Cases  []Case `json:"cases"`
	}
	if err := json.Unmarshal(corpusJSON, &doc); err != nil {
		return nil, fmt.Errorf("slicc-browsers corpus: %w", err)
	}
	if doc.Schema != Schema {
		return nil, fmt.Errorf("slicc-browsers corpus: schema %d, want %d", doc.Schema, Schema)
	}
	return doc.Cases, nil
}

func (c Case) Runs(goos string, supported ...string) bool {
	if len(c.Input.OS) > 0 && !slices.Contains(c.Input.OS, goos) {
		return false
	}
	for _, n := range c.Input.Needs {
		if !slices.Contains(supported, n) {
			return false
		}
	}
	return true
}

func (c Case) Env(l Layout) map[string]string {
	out := map[string]string{}
	for k, v := range c.Input.Env {
		out[k] = l.Expand(v)
	}
	return out
}

func (c Case) Files(l Layout) map[string]string {
	out := map[string]string{}
	for k, v := range c.Input.Files {
		out[l.Expand(k)] = v
	}
	return out
}

func (c Case) CDP(l Layout) []string {
	return expandAll(l, c.Input.CDP)
}

func (c Case) Commands(l Layout, self int) []FakeProcess {
	out := make([]FakeProcess, 0, len(c.Input.Processes))
	for _, p := range c.Input.Processes {
		pid := p.PID
		if p.Self {
			pid = self
		}
		out = append(out, FakeProcess{PID: pid, Self: p.Self, Command: l.Expand(p.Command)})
	}
	return out
}

func (c Case) PSOutput(l Layout, self int) string {
	var b strings.Builder
	for _, p := range c.Commands(l, self) {
		fmt.Fprintf(&b, "%6d %s\n", p.PID, p.Command)
	}
	return b.String()
}

func (c Case) CIMOutput(l Layout, self int) string {
	type row struct {
		ProcessID   int     `json:"ProcessId"`
		CommandLine *string `json:"CommandLine"`
	}
	rows := []row{{ProcessID: 4}}
	for _, p := range c.Commands(l, self) {
		cmd := p.Command
		rows = append(rows, row{ProcessID: p.PID, CommandLine: &cmd})
	}
	b, _ := json.Marshal(rows)
	return string(b)
}

func (c Case) Server(hostPort string) (Server, bool) {
	s, ok := c.Input.HTTP[normalizeHostPort(hostPort)]
	return s, ok
}

func (c Case) ExpectedJSON(l Layout) ([]byte, error) {
	var v any
	d := json.NewDecoder(bytes.NewReader(c.Expected))
	d.UseNumber()
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	return json.Marshal(expandValue(l, v))
}

func expandAll(l Layout, in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = l.Expand(s)
	}
	return out
}

func expandValue(l Layout, v any) any {
	switch t := v.(type) {
	case string:
		return l.Expand(t)
	case []any:
		for i := range t {
			t[i] = expandValue(l, t[i])
		}
	case map[string]any:
		for k := range t {
			t[k] = expandValue(l, t[k])
		}
	}
	return v
}

func normalizeHostPort(hostPort string) string {
	host, port := hostPort, ""
	if i := strings.LastIndexByte(hostPort, ':'); i >= 0 {
		host, port = hostPort[:i], hostPort[i+1:]
	}
	host = strings.ToLower(strings.Trim(host, "[]"))
	if host == "localhost" || host == "::1" {
		host = "127.0.0.1"
	}
	if _, err := strconv.Atoi(port); err != nil {
		return host
	}
	return host + ":" + port
}
