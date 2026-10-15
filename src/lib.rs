#![forbid(unsafe_code)]

pub const SCHEMA: u32 = 1;

pub const CATALOG: &str = include_str!("../catalog.json");

pub const CATALOG_SCHEMA: &str = include_str!("../schema/catalog.schema.json");

pub const BROWSERS_SCHEMA: &str = include_str!("../schema/browsers.schema.json");

pub const CORPUS_SCHEMA: &str = include_str!("../schema/corpus.schema.json");

pub const PROTECTED_SCHEMA: &str = include_str!("../schema/protected.schema.json");

pub const GUARD_VECTORS_SCHEMA: &str = include_str!("../schema/guard-vectors.schema.json");

#[cfg(feature = "corpus")]
pub const CORPUS: &str = include_str!("../corpus.json");

#[cfg(feature = "corpus")]
pub const PROTECTED: &str = include_str!("../protected.json");

#[cfg(feature = "corpus")]
pub const GUARD_VECTORS: &str = include_str!("../guard-vectors.json");

#[cfg(feature = "serde")]
mod catalog;

#[cfg(feature = "serde")]
pub use catalog::*;

#[cfg(feature = "corpus")]
pub mod corpus;

#[cfg(feature = "corpus")]
pub mod protected;

#[cfg(feature = "corpus")]
pub mod guard;
