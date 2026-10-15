use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const TARGET_SEVEN: &str = "seven";
pub const TARGET_VAULT: &str = "vault";
pub const TARGET_VAULT_X: &str = "vault-x";
pub const TARGET_APEX: &str = "apex";
pub const TARGET_OWN: &str = "own";
pub const ORDINARY: &str = "ordinary";
pub const ORDINARY_SAME_SITE: &str = "ordinary-same-site";
pub const KIND_CDP: &str = "cdp";
pub const KIND_TEXT: &str = "text";
pub const VIA_GUARD: &str = "guard";
pub const VIA_UNGUARDED: &str = "unguarded";
pub const SCOPE_ANY: &str = "any";
pub const CONTROL: &str = "control";
pub const GUARDED: &str = "guarded";
pub const CAP_AUTO_ATTACH: &str = "autoAttach";
pub const CAP_BROWSER_SESSION: &str = "browserSession";
pub const CAP_BROWSER_CONTEXTS: &str = "browserContexts";
pub const SESSION_PAGE: &str = "page";
pub const SESSION_BROWSER: &str = "browser";
pub const SESSION_PAGE_OR_BROWSER: &str = "page-or-browser";
pub const SESSION_CHILD: &str = "child";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct Vectors {
    pub schema_version: u32,
    pub set_version: String,
    pub sources: Vec<Source>,
    pub targets: BTreeMap<String, Target>,
    pub variants: BTreeMap<String, u64>,
    pub capabilities: BTreeMap<String, String>,
    pub placeholders: BTreeMap<String, String>,
    pub vectors: Vec<Vector>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub repo: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Vector {
    pub id: String,
    pub family: String,
    pub kind: String,
    pub scope: String,
    pub setup: Vec<Step>,
    pub trigger: Vec<Step>,
    pub targets: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observe: Option<BTreeMap<String, Observation>>,
    pub live: String,
    pub control: Control,
    pub expected: Expected,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip: Option<Skip>,
    #[serde(
        default,
        rename = "designDependent",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub design_dependent: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observable: Option<Observable>,
    #[serde(default, rename = "appliesTo", skip_serializing_if = "Vec::is_empty")]
    pub applies_to: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub means: String,
    #[serde(default, rename = "dependsOn", skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observable {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Outcome {
    Is(bool),
    Either(Either),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Either {
    #[serde(rename = "either")]
    Either,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    pub origin: String,
    pub via: String,
    pub expected: Expected,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Skip {
    pub target: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Expected {
    Checks(BTreeMap<String, Outcome>),
    Text(String),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub refusable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<Refusal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hops: Option<Vec<Hop>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub status: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Answer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Step>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settle: Option<Settle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guess: Option<Guess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, rename = "as", skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refusal {
    #[serde(rename = "match")]
    pub pattern: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hop {
    pub origin: String,
    pub code: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hold: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beacon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub variant: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Guess {
    pub between: Vec<String>,
    pub cdp: String,
    pub params: serde_json::Value,
}

pub fn vectors() -> Vectors {
    serde_json::from_str(crate::GUARD_VECTORS).expect("the embedded guard-vectors.json parses")
}
