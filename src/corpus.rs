use crate::{Catalog, Location};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const NEED_USER_DATA_DIRS: &str = "user-data-dirs";
pub const NEED_PROFILES: &str = "seven-profiles";
pub const NEED_FLAG: &str = "flag";
pub const NEED_PROCESS: &str = "process";
pub const NEED_PROBE: &str = "probe";
pub const NEED_ORIGINS: &str = "origins";
pub const NEED_INSTALLED: &str = "installed";
pub const NEED_SIX: &str = "six";
pub const NEED_TABS: &str = "tabs";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Corpus {
    pub schema: u32,
    pub cases: Vec<Case>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Case {
    pub name: String,
    #[serde(rename = "case")]
    pub input: Input,
    pub expected: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub description: String,
    #[serde(default)]
    pub os: Vec<String>,
    pub needs: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub cdp: Vec<String>,
    #[serde(default)]
    pub origins: Vec<String>,
    #[serde(default)]
    pub probe_ports: Vec<u16>,
    #[serde(default)]
    pub processes: Vec<FakeProcess>,
    #[serde(default)]
    pub http: BTreeMap<String, Server>,
    #[serde(default)]
    pub installed: Vec<Value>,
    #[serde(default)]
    pub auto: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FakeProcess {
    #[serde(default)]
    pub pid: u32,
    #[serde(default, rename = "self")]
    pub is_self: bool,
    pub command: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Server {
    #[serde(default)]
    pub version: Option<Value>,
    #[serde(default)]
    pub list: Option<Value>,
}

pub fn corpus() -> Corpus {
    serde_json::from_str(crate::CORPUS).expect("the embedded corpus.json parses")
}

pub struct Layout<'a> {
    pub os: &'a str,
    pub home: &'a str,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub catalog: &'a Catalog,
}

impl Layout<'_> {
    pub fn join(&self, parts: &[&str]) -> String {
        let windows = self.os == "windows";
        let sep = if windows { '\\' } else { '/' };
        let mut out: Vec<String> = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            let part = if windows {
                part.replace('/', "\\")
            } else {
                part.to_string()
            };
            let part = if i == 0 {
                part.trim_end_matches(sep).to_string()
            } else {
                part.trim_matches(sep).to_string()
            };
            if i == 0 || !part.is_empty() {
                out.push(part);
            }
        }
        out.join(&sep.to_string())
    }

    fn under(&self, base: &str, rest: &[String]) -> String {
        let mut parts = vec![base];
        parts.extend(rest.iter().map(String::as_str));
        self.join(&parts)
    }

    fn resolve(&self, loc: &Location, absolute_env: bool) -> String {
        if let Some(name) = &loc.env {
            if let Some(value) = (self.env)(name).filter(|v| !v.is_empty()) {
                if !absolute_env || value.starts_with('/') {
                    return value;
                }
            }
        }
        if let Some(abs) = &loc.absolute {
            return abs.clone();
        }
        self.under(self.home, &loc.home)
    }

    pub fn config(&self) -> String {
        let p = &self.catalog.platforms;
        match self.os {
            "darwin" => self.resolve(&p.macos.config, false),
            "windows" => self.resolve(&p.windows.config, false),
            _ => self.resolve(&p.linux.config, true),
        }
    }

    pub fn seven_profiles(&self) -> String {
        self.under(&self.config(), &self.catalog.profiles.root)
    }

    pub fn six_profiles(&self) -> String {
        let roots = &self.catalog.profiles.six.roots;
        let root = match self.os {
            "darwin" => &roots.macos,
            "windows" => &roots.windows,
            _ => &roots.linux,
        };
        self.under(&self.resolve(&root.base, false), &root.path)
    }

    pub fn windows_root(&self, name: &str) -> String {
        match self.catalog.platforms.windows.roots.get(name) {
            Some(loc) => self.resolve(loc, false),
            None => String::new(),
        }
    }

    pub fn user_data_dirs(&self, id: &str) -> Vec<String> {
        let Some(b) = self.catalog.browser(id) else {
            return Vec::new();
        };
        let mut dirs = Vec::new();
        match self.os {
            "darwin" => {
                if !b.macos.data_dir.is_empty() {
                    dirs.push(self.under(&self.config(), &b.macos.data_dir));
                }
            }
            "windows" => {
                if let Some(w) = b.windows.as_ref().filter(|w| !w.data_dir.is_empty()) {
                    dirs.push(self.under(&self.windows_root(&w.data_root), &w.data_dir));
                }
            }
            _ => {
                if let Some(l) = &b.linux {
                    if !l.config_dir.is_empty() {
                        dirs.push(self.under(&self.config(), &l.config_dir));
                        if let Some(flatpak) = &l.flatpak {
                            let base = self.join(&[self.home, ".var", "app", flatpak, "config"]);
                            dirs.push(self.under(&base, &l.config_dir));
                        }
                    }
                    if let Some(snap) = l.snap.as_ref().filter(|_| !l.snap_data_dir.is_empty()) {
                        let base = self.join(&[self.home, "snap", snap, "common"]);
                        dirs.push(self.under(&base, &l.snap_data_dir));
                    }
                }
            }
        }
        dirs
    }

    pub fn token(&self, name: &str) -> Option<String> {
        match name {
            "home" => Some(self.home.to_string()),
            "config" => Some(self.config()),
            "sevenProfiles" => Some(self.seven_profiles()),
            "sixProfiles" => Some(self.six_profiles()),
            _ => {
                let id = name.strip_prefix("userData:")?;
                self.user_data_dirs(id).into_iter().next()
            }
        }
    }

    pub fn expand(&self, text: &str) -> String {
        let mut out = String::new();
        let mut rest = text;
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            let Some(close) = after.find('}') else {
                out.push_str(&rest[open..]);
                return out;
            };
            let name = &after[..close];
            let tail = &after[close + 1..];
            let end = tail
                .find(|c: char| c.is_ascii_whitespace() || c == '"' || c == '\'' || c == ',')
                .unwrap_or(tail.len());
            match self.token(name).filter(|_| valid_token(name)) {
                Some(base) => {
                    if end == 0 {
                        out.push_str(&base);
                    } else {
                        out.push_str(&self.join(&[&base, &tail[..end]]));
                    }
                    rest = &tail[end..];
                }
                None => {
                    out.push('{');
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out
    }
}

fn valid_token(name: &str) -> bool {
    match name {
        "home" | "config" | "sevenProfiles" | "sixProfiles" => true,
        _ => name.strip_prefix("userData:").is_some_and(|id| {
            !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        }),
    }
}

#[derive(Serialize)]
struct CimRow<'a> {
    #[serde(rename = "ProcessId")]
    process_id: u32,
    #[serde(rename = "CommandLine")]
    command_line: Option<&'a str>,
}

impl Case {
    pub fn runs(&self, os: &str, supported: &[&str]) -> bool {
        (self.input.os.is_empty() || self.input.os.iter().any(|o| o == os))
            && self
                .input
                .needs
                .iter()
                .all(|n| supported.contains(&n.as_str()))
    }

    pub fn env(&self, layout: &Layout<'_>) -> BTreeMap<String, String> {
        self.input
            .env
            .iter()
            .map(|(k, v)| (k.clone(), layout.expand(v)))
            .collect()
    }

    pub fn files(&self, layout: &Layout<'_>) -> Vec<(String, String)> {
        self.input
            .files
            .iter()
            .map(|(k, v)| (layout.expand(k), v.clone()))
            .collect()
    }

    pub fn cdp(&self, layout: &Layout<'_>) -> Vec<String> {
        self.input.cdp.iter().map(|s| layout.expand(s)).collect()
    }

    pub fn commands(&self, layout: &Layout<'_>, self_pid: u32) -> Vec<FakeProcess> {
        self.input
            .processes
            .iter()
            .map(|p| FakeProcess {
                pid: if p.is_self { self_pid } else { p.pid },
                is_self: p.is_self,
                command: layout.expand(&p.command),
            })
            .collect()
    }

    pub fn ps_output(&self, layout: &Layout<'_>, self_pid: u32) -> String {
        self.commands(layout, self_pid)
            .iter()
            .map(|p| format!("{:>6} {}\n", p.pid, p.command))
            .collect()
    }

    pub fn cim_output(&self, layout: &Layout<'_>, self_pid: u32) -> String {
        let commands = self.commands(layout, self_pid);
        let mut rows = vec![CimRow {
            process_id: 4,
            command_line: None,
        }];
        rows.extend(commands.iter().map(|p| CimRow {
            process_id: p.pid,
            command_line: Some(p.command.as_str()),
        }));
        serde_json::to_string(&rows).unwrap_or_default()
    }

    pub fn server(&self, host_port: &str) -> Option<&Server> {
        self.input.http.get(&normalize_host_port(host_port))
    }

    pub fn http_get(&self, host_port: &str, path: &str) -> Option<(u16, String)> {
        let server = self.server(host_port)?;
        let body = match path {
            "/json/version" => server.version.as_ref(),
            "/json/list" | "/json" => server.list.as_ref(),
            _ => None,
        };
        Some(match body.filter(|v| !v.is_null()) {
            Some(v) => (200, v.to_string()),
            None => (404, format!("Unknown command: {path}")),
        })
    }

    pub fn expected(&self, layout: &Layout<'_>) -> Value {
        expand_value(layout, self.expected.clone())
    }
}

fn expand_value(layout: &Layout<'_>, value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(layout.expand(&s)),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|v| expand_value(layout, v)).collect())
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, expand_value(layout, v)))
                .collect(),
        ),
        other => other,
    }
}

pub fn normalize_host_port(host_port: &str) -> String {
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() => (h, Some(p)),
        _ => (host_port, None),
    };
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    let host = if host == "localhost" || host == "::1" {
        "127.0.0.1".to_string()
    } else {
        host
    };
    match port {
        Some(p) => format!("{host}:{p}"),
        None => host,
    }
}
