use serde_json::Value;
use slicc_browsers::corpus::{self, Layout};
use slicc_browsers::{catalog, Catalog, CATALOG, CORPUS, GUARD_VECTORS, PROTECTED};
use slicc_browsers::{guard, protected};
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
fn is_seven_label() {
    let seven = &catalog().seven;
    for label in ["seven", "link-websockets"] {
        assert!(seven.is_seven_label(label), "{label} should be seven");
    }
    for label in [
        "",
        "www",
        "vault",
        "vault-preview",
        "get",
        "mcpcat",
        "echo",
        "vault-feature-x",
    ] {
        assert!(!seven.is_seven_label(label), "{label} should not be seven");
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

#[test]
fn the_protected_vectors_parse_and_round_trip() {
    let v = protected::vectors();
    assert_eq!(v.schema, slicc_browsers::SCHEMA);
    assert!(!v.origins.is_empty() && !v.urls.is_empty() && !v.targets.is_empty());
    let raw: Value = serde_json::from_str(PROTECTED).unwrap();
    assert_eq!(strip_nulls(serde_json::to_value(&v).unwrap()), raw);
    let openers = [
        protected::OPENER_PROTECTED,
        protected::OPENER_UNPROTECTED,
        protected::OPENER_UNKNOWN,
    ];
    assert!(v
        .targets
        .iter()
        .all(|t| t.opener.as_deref().is_none_or(|o| openers.contains(&o))));
    let po = catalog().protected_origins;
    assert!(po.domains.iter().any(|d| d == "sliccy.ai"));
    assert!(po.hosts.iter().any(|h| h == "vault.sliccy.ai"));
    assert_eq!(po.refusal, "slicc: refused: target is on seven's origin");
    assert!(slicc_browsers::PROTECTED_SCHEMA.contains("/schema/protected.schema.json"));
}

#[test]
fn the_guard_vectors_parse_and_round_trip() {
    let v = guard::vectors();
    assert_eq!(v.schema_version, slicc_browsers::SCHEMA);
    assert!(v.variants.contains_key("prompt") && v.variants.contains_key("lagging"));
    let c1 = v.vectors.iter().find(|x| x.id == "C1.script-nav").unwrap();
    assert!(!c1.design_dependent.is_empty());
    let e6 = v.vectors.iter().find(|x| x.id == "E6.locale").unwrap();
    assert_eq!(e6.applies_to, vec!["href".to_string()]);
    let raw: Value = serde_json::from_str(GUARD_VECTORS).unwrap();
    assert_eq!(serde_json::to_value(&v).unwrap(), raw);
    let targets = [
        guard::TARGET_SEVEN,
        guard::TARGET_VAULT,
        guard::TARGET_VAULT_X,
        guard::TARGET_APEX,
        guard::TARGET_OWN,
        guard::TARGET_CHROME_NEWTAB,
        guard::TARGET_CHROME_NEW_TAB_PAGE,
        guard::TARGET_CHROME_SETTINGS,
        guard::TARGET_CHROME_PASSWORDS,
        guard::TARGET_CHROME_SEARCH,
        guard::TARGET_NETWORK_ERROR,
        guard::TARGET_CHROME_EXTENSION_PAGE,
        guard::TARGET_FILE_ROOT,
    ];
    for t in targets
        .iter()
        .chain(&[guard::ORDINARY, guard::ORDINARY_SAME_SITE])
    {
        assert!(v.targets.contains_key(*t));
    }
    let mut ids = std::collections::BTreeSet::new();
    for vec in &v.vectors {
        assert!(ids.insert(vec.id.clone()), "duplicate {}", vec.id);
        assert_eq!(vec.control.origin, guard::ORDINARY);
        assert!(vec.control.via == guard::VIA_GUARD || vec.control.via == guard::VIA_UNGUARDED);
        assert!(vec.kind == guard::KIND_CDP || vec.kind == guard::KIND_TEXT);
        assert_eq!(vec.scope, guard::SCOPE_ANY);
        assert!(vec.targets.iter().all(|t| targets.contains(&t.as_str())));
        for s in vec.setup.iter().chain(&vec.trigger) {
            assert!(s
                .on
                .as_deref()
                .is_none_or(|o| o == guard::CONTROL || o == guard::GUARDED));
            assert_eq!(s.refusable, s.refusal.is_some());
        }
    }
    let skip = v
        .vectors
        .iter()
        .find(|x| x.id == "C4.static-same-site")
        .unwrap();
    assert_eq!(skip.skip.as_ref().unwrap().target, guard::TARGET_VAULT);
    for c in [
        guard::CAP_AUTO_ATTACH,
        guard::CAP_BROWSER_SESSION,
        guard::CAP_BROWSER_CONTEXTS,
        guard::CAP_CHROME_URLS_ATTACH,
    ] {
        assert!(v.capabilities.contains_key(c));
    }
    let fetch = v
        .vectors
        .iter()
        .find(|x| x.id == "C5.guessed-id.continue-response")
        .unwrap();
    let refusal = fetch.setup[2].refusal.as_ref().unwrap();
    assert!(fetch.setup[2].refusable);
    assert!(refusal.only_protected);
    assert_eq!(refusal.pattern, "^slicc: refused");
    for observation in fetch.observe.as_ref().unwrap().values() {
        assert_eq!(observation.depends_on, Some(vec!["refused.2".to_string()]));
    }
    let newtab = v.vectors.iter().find(|x| x.id == "C8.newtab").unwrap();
    assert!(newtab
        .requires
        .contains(&guard::CAP_CHROME_URLS_ATTACH.to_string()));
    let popup = v.vectors.iter().find(|x| x.id == "C3.popup").unwrap();
    assert!(popup.requires.contains(&guard::CAP_AUTO_ATTACH.to_string()));
    let e3 = v.vectors.iter().find(|x| x.id == "E3.bypass-csp").unwrap();
    let inline = &e3.observe.as_ref().unwrap()["inline"];
    assert_eq!(inline.depends_on, Some(vec!["refused.2".to_string()]));
    let storage = v.vectors.iter().find(|x| x.id == "C6.storage").unwrap();
    assert!(storage
        .trigger
        .iter()
        .filter(|s| s.cdp.as_deref().is_some_and(|m| m.starts_with("Storage.")))
        .all(|s| s.session.as_deref() == Some(guard::SESSION_PAGE_OR_BROWSER)));
    assert!(slicc_browsers::GUARD_VECTORS_SCHEMA.contains("/schema/guard-vectors.schema.json"));
}
