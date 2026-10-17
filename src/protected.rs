use serde::{Deserialize, Serialize};

pub const OPENER_PROTECTED: &str = "protected";
pub const OPENER_UNPROTECTED: &str = "unprotected";
pub const OPENER_UNKNOWN: &str = "unknown";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vectors {
    pub schema: u32,
    pub origins: Vec<String>,
    pub urls: Vec<UrlVector>,
    pub targets: Vec<TargetVector>,
    pub cookie_domains: Vec<CookieVector>,
    pub storage_keys: Vec<KeyVector>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UrlVector {
    pub url: String,
    pub protected: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TargetVector {
    pub url: String,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub previous: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opener: Option<String>,
    pub protected: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CookieVector {
    pub domain: String,
    pub protected: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyVector {
    pub key: String,
    pub protected: bool,
}

pub fn vectors() -> Vectors {
    serde_json::from_str(crate::PROTECTED).expect("the embedded protected.json parses")
}
