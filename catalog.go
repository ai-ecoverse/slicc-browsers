package sliccbrowsers

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"
)

//go:embed catalog.json
var catalogJSON []byte

//go:embed schema/catalog.schema.json
var catalogSchemaJSON []byte

//go:embed schema/browsers.schema.json
var browsersSchemaJSON []byte

const Schema = 1

type Catalog struct {
	Schema           int              `json:"schema"`
	MinChromiumMajor int              `json:"minChromiumMajor"`
	Browsers         []Browser        `json:"browsers"`
	Electron         Electron         `json:"electron"`
	Rank             Rank             `json:"rank"`
	Discovery        Discovery        `json:"discovery"`
	Seven            Seven            `json:"seven"`
	ProtectedOrigins ProtectedOrigins `json:"protectedOrigins"`
	Profiles         Profiles         `json:"profiles"`
	Launch           Launch           `json:"launch"`
	Platforms        Platforms        `json:"platforms"`
}

type Browser struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Channel         string  `json:"channel"`
	Engine          string  `json:"engine"`
	ChromiumVersion bool    `json:"chromiumVersion"`
	MacOS           MacOS   `json:"macos"`
	Windows         Windows `json:"windows,omitzero"`
	Linux           Linux   `json:"linux,omitzero"`
}

type MacOS struct {
	BundleID   string   `json:"bundleId"`
	App        string   `json:"app"`
	Executable string   `json:"executable"`
	DataDir    []string `json:"dataDir,omitempty"`
}

type Windows struct {
	Roots             []string   `json:"roots,omitempty"`
	Executables       [][]string `json:"executables,omitempty"`
	DataRoot          string     `json:"dataRoot,omitempty"`
	DataDir           []string   `json:"dataDir,omitempty"`
	StartMenuInternet []string   `json:"startMenuInternet,omitempty"`
}

type Linux struct {
	Bins        []string `json:"bins,omitempty"`
	DesktopIDs  []string `json:"desktopIds,omitempty"`
	Flatpak     string   `json:"flatpak,omitempty"`
	Snap        string   `json:"snap,omitempty"`
	SnapDataDir []string `json:"snapDataDir,omitempty"`
	ConfigDir   []string `json:"configDir,omitempty"`
	Debs        []string `json:"debs,omitempty"`
}

type Electron struct {
	MacOSApps    []App    `json:"macosApps"`
	DebugBlocked []string `json:"debugBlocked"`
	IDPrefix     string   `json:"idPrefix"`
}

type App struct {
	BundleID string `json:"bundleId"`
	Name     string `json:"name"`
}

type Rank struct {
	Tiers    Tiers  `json:"tiers"`
	ChromeID string `json:"chromeId"`
}

type Tiers struct {
	SevenOpen int `json:"sevenOpen"`
	Endpoint  int `json:"endpoint"`
	Chrome    int `json:"chrome"`
	Chromium  int `json:"chromium"`
	Electron  int `json:"electron"`
	Six       int `json:"six"`
}

type Discovery struct {
	ActivePortFile     string         `json:"activePortFile"`
	ProbePorts         []int          `json:"probePorts"`
	SourceRank         map[string]int `json:"sourceRank"`
	ChromeMajorPattern string         `json:"chromeMajorPattern"`
	Names              Names          `json:"names"`
	Process            Process        `json:"process"`
}

type Names struct {
	ElectronUserAgent string            `json:"electronUserAgent"`
	Electron          string            `json:"electron"`
	Products          map[string]string `json:"products"`
	Fallback          string            `json:"fallback"`
}

type Process struct {
	Unix            []string `json:"unix"`
	Windows         []string `json:"windows"`
	PortFlag        string   `json:"portFlag"`
	UserDataDirFlag string   `json:"userDataDirFlag"`
	ValueQuotes     []string `json:"valueQuotes"`
	ValueStop       string   `json:"valueStop"`
	Wrappers        []string `json:"wrappers"`
	WrapperSuffixes []string `json:"wrapperSuffixes"`
}

type Seven struct {
	OriginScheme          string             `json:"originScheme"`
	OriginHostPattern     string             `json:"originHostPattern"`
	ExcludedLabels        []string           `json:"excludedLabels"`
	ExcludedLabelPrefixes []string           `json:"excludedLabelPrefixes"`
	SitePattern           string             `json:"sitePattern"`
	Switches              []string           `json:"switches"`
	DisabledFeatures      []string           `json:"disabledFeatures"`
	Prefs                 []Pref             `json:"prefs"`
	DiscardExceptions     []DiscardException `json:"discardExceptions"`
	CleanExit             []Pref             `json:"cleanExit"`
}

type Pref struct {
	Path  []string        `json:"path"`
	Value json.RawMessage `json:"value"`
	Form  string          `json:"form,omitempty"`
}

type DiscardException struct {
	Path []string `json:"path"`
	Type string   `json:"type"`
	Form string   `json:"form"`
}

type Profiles struct {
	Root              []string `json:"root"`
	SnapRoot          []string `json:"snapRoot"`
	LegacyRoot        []string `json:"legacyRoot"`
	SixProfilePattern string   `json:"sixProfilePattern"`
	NamePattern       string   `json:"namePattern"`
	Six               Six      `json:"six"`
}

type Six struct {
	Roots          SixRoots `json:"roots"`
	DefaultName    string   `json:"defaultName"`
	DefaultPort    int      `json:"defaultPort"`
	PortSuffix     string   `json:"portSuffix"`
	UserDataDirEnv string   `json:"userDataDirEnv"`
}

type SixRoots struct {
	MacOS   SixRoot `json:"macos"`
	Linux   SixRoot `json:"linux"`
	Windows SixRoot `json:"windows"`
}

type SixRoot struct {
	Base Location `json:"base"`
	Path []string `json:"path"`
}

type Launch struct {
	ChromiumArgs        []string       `json:"chromiumArgs"`
	Headless            string         `json:"headless"`
	DisableFeaturesFlag string         `json:"disableFeaturesFlag"`
	Electron            ElectronLaunch `json:"electron"`
}

type ElectronLaunch struct {
	PortFlag      string `json:"portFlag"`
	MinPort       int    `json:"minPort"`
	ReservedPorts []int  `json:"reservedPorts"`
}

type Platforms struct {
	MacOS   MacOSPlatform   `json:"macos"`
	Windows WindowsPlatform `json:"windows"`
	Linux   LinuxPlatform   `json:"linux"`
}

type MacOSPlatform struct {
	Config Location `json:"config"`
}

type WindowsPlatform struct {
	Config   Location            `json:"config"`
	Roots    map[string]Location `json:"roots"`
	Registry Registry            `json:"registry"`
}

type LinuxPlatform struct {
	Config Location `json:"config"`
}

type Location struct {
	Env      string   `json:"env,omitempty"`
	Home     []string `json:"home,omitempty"`
	Absolute string   `json:"absolute,omitempty"`
}

type Registry struct {
	Hives             []string `json:"hives"`
	StartMenuInternet []string `json:"startMenuInternet"`
	OpenCommand       string   `json:"openCommand"`
	AppPaths          string   `json:"appPaths"`
	AppPathNames      []string `json:"appPathNames"`
}

func CatalogJSON() []byte {
	return bytes.Clone(catalogJSON)
}

func CatalogSchemaJSON() []byte {
	return bytes.Clone(catalogSchemaJSON)
}

func BrowsersSchemaJSON() []byte {
	return bytes.Clone(browsersSchemaJSON)
}

func Parse(b []byte) (*Catalog, error) {
	var c Catalog
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("slicc-browsers catalog: %w", err)
	}
	if c.Schema != Schema {
		return nil, fmt.Errorf("slicc-browsers catalog: schema %d, want %d", c.Schema, Schema)
	}
	return &c, nil
}

var (
	defaultOnce    sync.Once
	defaultCatalog *Catalog
	defaultErr     error
)

func Load() (*Catalog, error) {
	defaultOnce.Do(func() {
		defaultCatalog, defaultErr = Parse(catalogJSON)
	})
	return defaultCatalog, defaultErr
}

func Default() *Catalog {
	c, err := Load()
	if err != nil {
		panic(err)
	}
	return c
}

func (c *Catalog) Browser(id string) (Browser, bool) {
	for _, b := range c.Browsers {
		if b.ID == id {
			return b, true
		}
	}
	return Browser{}, false
}

func (c *Catalog) Priority(id string) int {
	for i, b := range c.Browsers {
		if b.ID == id {
			return i
		}
	}
	return len(c.Browsers)
}

func (s *Seven) IsSevenLabel(label string) bool {
	if label == "" {
		return false
	}
	for _, excluded := range s.ExcludedLabels {
		if label == excluded {
			return false
		}
	}
	for _, prefix := range s.ExcludedLabelPrefixes {
		if len(label) >= len(prefix) && label[:len(prefix)] == prefix {
			return false
		}
	}
	return true
}
