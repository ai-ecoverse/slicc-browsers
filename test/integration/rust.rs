use serde_json::Value;
use slicc_browsers::corpus::{self, Layout};
use slicc_browsers::{catalog, Catalog, CATALOG, CORPUS};
use std::collections::BTreeMap;

const LAYOUT: &str = include_str!("layout.json");

fn strip_nulls(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, strip_nulls(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.into_iter().map(strip_nulls).collect()),
        other => other,
    }
}

#[test]
fn the_typed_catalog_round_trips_every_field() {
    let typed = catalog();
    let raw: Value = serde_json::from_str(CATALOG).unwrap();
    let back = strip_nulls(serde_json::to_value(&typed).unwrap());
    assert_eq!(back, raw);
    assert_eq!(typed.schema, slicc_browsers::SCHEMA);
    assert_eq!(typed.browsers[0].id, typed.rank.chrome_id);
    assert_eq!(typed.priority("edge"), 1);
    assert_eq!(typed.priority("nope"), typed.browsers.len());
}

#[test]
fn the_corpus_parses_and_round_trips() {
    let c = corpus::corpus();
    assert_eq!(c.schema, 1);
    assert!(!c.cases.is_empty());
    let raw: Value = serde_json::from_str(CORPUS).unwrap();
    assert_eq!(raw["cases"].as_array().unwrap().len(), c.cases.len());
}

fn layout_for<'a>(
    os: &'a str,
    home: &'a str,
    env: &'a dyn Fn(&str) -> Option<String>,
    cat: &'a Catalog,
) -> Layout<'a> {
    Layout {
        os,
        home,
        env,
        catalog: cat,
    }
}

#[test]
fn layouts_match_the_shared_vectors() {
    let cat = catalog();
    let vectors: Vec<Value> = serde_json::from_str(LAYOUT).unwrap();
    for v in vectors {
        let os = v["os"].as_str().unwrap();
        let home = v["home"].as_str().unwrap();
        let env: BTreeMap<String, String> =
            serde_json::from_value(v.get("env").cloned().unwrap_or(Value::Null))
                .unwrap_or_default();
        let lookup = move |k: &str| env.get(k).cloned();
        let l = layout_for(os, home, &lookup, &cat);
        for (token, want) in v["tokens"].as_object().unwrap() {
            assert_eq!(
                l.token(token),
                want.as_str().map(str::to_string),
                "{os} {token}"
            );
        }
        if let Some(dirs) = v.get("userDataDirs").and_then(Value::as_object) {
            for (id, want) in dirs {
                let want: Vec<String> = serde_json::from_value(want.clone()).unwrap();
                assert_eq!(l.user_data_dirs(id), want, "{os} {id}");
            }
        }
        for (input, want) in v["expand"].as_object().unwrap() {
            assert_eq!(l.expand(input), want.as_str().unwrap(), "{os} {input}");
        }
    }
}

#[test]
fn every_case_expands_on_every_os_it_runs_on() {
    let cat = catalog();
    let none = |_: &str| None;
    for c in corpus::corpus().cases {
        for os in ["darwin", "linux", "windows"] {
            if !c.input.os.is_empty() && !c.input.os.iter().any(|o| o == os) {
                continue;
            }
            let home = if os == "windows" { "C:\\h" } else { "/h" };
            let l = layout_for(os, home, &none, &cat);
            for (path, _) in c.files(&l) {
                assert!(!path.contains('{'), "{} {os}: {path}", c.name);
                assert!(path.starts_with(home), "{} {os}: {path}", c.name);
            }
            let expected = c.expected(&l).to_string();
            assert!(
                !expected.contains("{home}")
                    && !expected.contains("{sevenProfiles}")
                    && !expected.contains("{sixProfiles}"),
                "{} {os}",
                c.name
            );
            let ps = c.ps_output(&l, 77);
            assert_eq!(ps.lines().count(), c.input.processes.len());
            let cim: Value = serde_json::from_str(&c.cim_output(&l, 77)).unwrap();
            assert_eq!(cim.as_array().unwrap().len(), c.input.processes.len() + 1);
        }
    }
}

#[test]
fn the_fake_http_normalizes_localhost() {
    let c = corpus::corpus()
        .cases
        .into_iter()
        .find(|c| c.name == "dedupe")
        .unwrap();
    assert!(c.server("localhost:9391").is_some());
    assert_eq!(
        c.http_get("127.0.0.1:9391", "/json/version").unwrap().0,
        200
    );
    assert_eq!(c.http_get("127.0.0.1:9391", "/nope").unwrap().0, 404);
    assert!(c.http_get("127.0.0.1:1", "/json/version").is_none());
}
