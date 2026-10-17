use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema: u32,
    pub min_chromium_major: u32,
    pub browsers: Vec<Browser>,
    pub electron: Electron,
    pub rank: Rank,
    pub discovery: Discovery,
    pub seven: Seven,
    pub protected_origins: ProtectedOrigins,
    pub profiles: Profiles,
    pub launch: Launch,
    pub platforms: Platforms,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    pub id: String,
    pub name: String,
    pub channel: String,
    pub engine: String,
    pub chromium_version: bool,
    pub macos: MacOs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<Windows>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linux: Option<Linux>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacOs {
    pub bundle_id: String,
    pub app: String,
    pub executable: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data_dir: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Windows {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub executables: Vec<Vec<String>>,
    pub data_root: String,
    pub data_dir: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub start_menu_internet: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Linux {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bins: Vec<String>,
    #[serde(default, rename = "desktopIds", skip_serializing_if = "Vec::is_empty")]
    pub desktop_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flatpak: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snap: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub snap_data_dir: Vec<String>,
    pub config_dir: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub debs: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Electron {
    pub macos_apps: Vec<App>,
    pub debug_blocked: Vec<String>,
    pub id_prefix: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub bundle_id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rank {
    pub tiers: Tiers,
    pub chrome_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tiers {
    pub seven_open: u8,
    pub endpoint: u8,
    pub chrome: u8,
    pub chromium: u8,
    pub electron: u8,
    pub six: u8,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub active_port_file: String,
    pub probe_ports: Vec<u16>,
    pub source_rank: BTreeMap<String, u8>,
    pub chrome_major_pattern: String,
    pub names: Names,
    pub process: Process,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Names {
    pub electron_user_agent: String,
    pub electron: String,
    pub products: BTreeMap<String, String>,
    pub fallback: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub unix: Vec<String>,
    pub windows: Vec<String>,
    pub port_flag: String,
    pub user_data_dir_flag: String,
    pub value_quotes: Vec<String>,
    pub value_stop: String,
    pub wrappers: Vec<String>,
    pub wrapper_suffixes: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seven {
    pub origin_scheme: String,
    pub origin_host_pattern: String,
    pub excluded_labels: Vec<String>,
    #[serde(default)]
    pub excluded_label_prefixes: Vec<String>,
    pub site_pattern: String,
    pub switches: Vec<String>,
    pub disabled_features: Vec<String>,
    pub prefs: Vec<Pref>,
    pub discard_exceptions: Vec<DiscardException>,
    pub clean_exit: Vec<Pref>,
}

impl Seven {
    pub fn is_seven_label(&self, label: &str) -> bool {
        if label.is_empty() {
            return false;
        }
        if self.excluded_labels.iter().any(|e| e == label) {
            return false;
        }
        if self
            .excluded_label_prefixes
            .iter()
            .any(|p| label.starts_with(p.as_str()))
        {
            return false;
        }
        true
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedOrigins {
    pub domains: Vec<String>,
    pub hosts: Vec<String>,
    pub schemes: Vec<String>,
    pub inner_schemes: Vec<String>,
    pub any_schemes: Vec<String>,
    #[serde(default)]
    pub protected_schemes: Vec<String>,
    #[serde(default)]
    pub scheme_exceptions: Vec<String>,
    #[serde(default)]
    pub about_scheme: String,
    #[serde(default)]
    pub target_types: Vec<String>,
    pub inheriting: Vec<String>,
    pub refusal: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Pref {
    pub path: Vec<String>,
    pub value: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DiscardException {
    pub path: Vec<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub form: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profiles {
    pub root: Vec<String>,
    pub snap_root: Vec<String>,
    pub legacy_root: Vec<String>,
    pub six_profile_pattern: String,
    pub name_pattern: String,
    pub six: Six,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Six {
    pub roots: SixRoots,
    pub default_name: String,
    pub default_port: u16,
    pub port_suffix: String,
    pub user_data_dir_env: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SixRoots {
    pub macos: SixRoot,
    pub linux: SixRoot,
    pub windows: SixRoot,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SixRoot {
    pub base: Location,
    pub path: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub chromium_args: Vec<String>,
    pub headless: String,
    pub disable_features_flag: String,
    pub electron: ElectronLaunch,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElectronLaunch {
    pub port_flag: String,
    pub min_port: u16,
    pub reserved_ports: Vec<u16>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Platforms {
    pub macos: MacOsPlatform,
    pub windows: WindowsPlatform,
    pub linux: LinuxPlatform,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MacOsPlatform {
    pub config: Location,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WindowsPlatform {
    pub config: Location,
    pub roots: BTreeMap<String, Location>,
    pub registry: Registry,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LinuxPlatform {
    pub config: Location,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Location {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub home: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub hives: Vec<String>,
    pub start_menu_internet: Vec<String>,
    pub open_command: String,
    pub app_paths: String,
    pub app_path_names: Vec<String>,
}

impl Catalog {
    pub fn parse(text: &str) -> Result<Catalog, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn browser(&self, id: &str) -> Option<&Browser> {
        self.browsers.iter().find(|b| b.id == id)
    }

    pub fn priority(&self, id: &str) -> usize {
        self.browsers
            .iter()
            .position(|b| b.id == id)
            .unwrap_or(self.browsers.len())
    }
}

pub fn catalog() -> Catalog {
    Catalog::parse(crate::CATALOG).expect("the embedded catalog.json parses")
}
