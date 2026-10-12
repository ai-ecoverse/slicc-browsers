package sliccbrowsers

import (
	"regexp"
	"strings"
)

type Layout struct {
	OS      string
	Home    string
	Getenv  func(string) string
	Catalog *Catalog
}

var tokenRE = regexp.MustCompile(`\{(home|config|sevenProfiles|sixProfiles|userData:[a-z0-9-]+)\}([^\s"',]*)`)

func (l Layout) catalog() *Catalog {
	if l.Catalog != nil {
		return l.Catalog
	}
	return Default()
}

func (l Layout) env(key string) string {
	if l.Getenv == nil {
		return ""
	}
	return l.Getenv(key)
}

func (l Layout) Join(parts ...string) string {
	sep := "/"
	if l.OS == "windows" {
		sep = `\`
	}
	var out []string
	for i, p := range parts {
		if l.OS == "windows" {
			p = strings.ReplaceAll(p, "/", `\`)
		}
		if i == 0 {
			p = strings.TrimRight(p, sep)
		} else {
			p = strings.Trim(p, sep)
		}
		if p != "" || i == 0 {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

func (l Layout) resolve(loc Location, absEnv bool) string {
	if loc.Env != "" {
		if v := l.env(loc.Env); v != "" && (!absEnv || strings.HasPrefix(v, "/")) {
			return v
		}
	}
	if loc.Absolute != "" {
		return loc.Absolute
	}
	return l.Join(append([]string{l.Home}, loc.Home...)...)
}

func (l Layout) Config() string {
	p := l.catalog().Platforms
	switch l.OS {
	case "darwin":
		return l.resolve(p.MacOS.Config, false)
	case "windows":
		return l.resolve(p.Windows.Config, false)
	default:
		return l.resolve(p.Linux.Config, true)
	}
}

func (l Layout) SevenProfiles() string {
	return l.Join(append([]string{l.Config()}, l.catalog().Profiles.Root...)...)
}

func (l Layout) SixProfiles() string {
	r := l.catalog().Profiles.Six.Roots
	root := r.Linux
	switch l.OS {
	case "darwin":
		root = r.MacOS
	case "windows":
		root = r.Windows
	}
	return l.Join(append([]string{l.resolve(root.Base, false)}, root.Path...)...)
}

func (l Layout) WindowsRoot(name string) string {
	return l.resolve(l.catalog().Platforms.Windows.Roots[name], false)
}

func (l Layout) UserDataDirs(id string) []string {
	b, ok := l.catalog().Browser(id)
	if !ok {
		return nil
	}
	var dirs []string
	switch l.OS {
	case "darwin":
		if len(b.MacOS.DataDir) > 0 {
			dirs = append(dirs, l.Join(append([]string{l.Config()}, b.MacOS.DataDir...)...))
		}
	case "windows":
		if len(b.Windows.DataDir) > 0 {
			dirs = append(dirs, l.Join(append([]string{l.WindowsRoot(b.Windows.DataRoot)}, b.Windows.DataDir...)...))
		}
	default:
		lx := b.Linux
		if len(lx.ConfigDir) > 0 {
			dirs = append(dirs, l.Join(append([]string{l.Config()}, lx.ConfigDir...)...))
			if lx.Flatpak != "" {
				dirs = append(dirs, l.Join(append([]string{l.Home, ".var", "app", lx.Flatpak, "config"}, lx.ConfigDir...)...))
			}
		}
		if lx.Snap != "" && len(lx.SnapDataDir) > 0 {
			dirs = append(dirs, l.Join(append([]string{l.Home, "snap", lx.Snap, "common"}, lx.SnapDataDir...)...))
		}
	}
	return dirs
}

func (l Layout) Token(name string) (string, bool) {
	switch {
	case name == "home":
		return l.Home, true
	case name == "config":
		return l.Config(), true
	case name == "sevenProfiles":
		return l.SevenProfiles(), true
	case name == "sixProfiles":
		return l.SixProfiles(), true
	case strings.HasPrefix(name, "userData:"):
		dirs := l.UserDataDirs(strings.TrimPrefix(name, "userData:"))
		if len(dirs) == 0 {
			return "", false
		}
		return dirs[0], true
	}
	return "", false
}

func (l Layout) Expand(s string) string {
	return tokenRE.ReplaceAllStringFunc(s, func(m string) string {
		sub := tokenRE.FindStringSubmatch(m)
		base, ok := l.Token(sub[1])
		if !ok {
			return m
		}
		if sub[2] == "" {
			return base
		}
		return l.Join(base, sub[2])
	})
}
