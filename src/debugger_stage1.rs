use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Vectors {
    pub schema_version: u32,
    pub methods: Vec<Method>,
    pub rows: Vec<Row>,
    pub navigation: Vec<String>,
    pub lease_refusals: Vec<String>,
    pub rescue_evidence: RescueEvidence,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Method {
    pub method: String,
    pub lifetime: String,
    pub admitted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_instrumentation_only: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Row {
    pub id: String,
    pub mode: String,
    pub destination: String,
    pub expected: BTreeMap<String, bool>,
    pub requires: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RescueEvidence {
    pub origin: String,
    pub no_observer_resume: bool,
    pub owner_unchanged: bool,
    pub generation_unchanged: bool,
    pub deadline_unchanged: bool,
}

pub fn vectors() -> Vectors {
    serde_json::from_str(crate::DEBUGGER_STAGE1).expect("the embedded debugger-stage1.json parses")
}
