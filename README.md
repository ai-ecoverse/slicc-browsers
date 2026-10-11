# slicc-browsers

The browser catalog, JSON schemas and conformance corpus shared by the two programs that find and launch browsers for SLICC:
- `slicc browsers` and `slicc launch` in [slicc-cli](https://github.com/ai-ecoverse/slicc-cli) (Go, `CGO_ENABLED=0`);
- `playwright-cli list` and `open` in [slicc-cdp](https://github.com/ai-ecoverse/slicc-cdp) (Rust, also built for `wasm32-wasip1`).

They can't share code, so they share data. Three packages wrap the same files, at one version:

| package | what it gives you |
| --- | --- |
| Go module `github.com/ai-ecoverse/slicc-browsers` (package `sliccbrowsers`) | the files embedded, typed structs, and corpus helpers |
| Rust crate `slicc-browsers` (lib `slicc_browsers`) | the files as `&str` constants, serde types behind features |
| npm package `@ai-ecoverse/slicc-browsers` | the JSON files and the schemas |

| file | what it is |
| --- | --- |
| `catalog.json` | the browsers, Electron apps, ranking, discovery, seven flags and prefs, profile and platform paths |
| `schema/catalog.schema.json` | JSON Schema (2020-12) for `catalog.json` |
| `schema/browsers.schema.json` | JSON Schema for `slicc browsers --json` and `playwright-cli list --json`, schema 1 |
| `schema/corpus.schema.json` | JSON Schema for `corpus.json` |
| `corpus/<case>/case.json`, `corpus/<case>/expected.json` | the conformance cases |
| `corpus.json` | every case in one file, generated from `corpus/` by `npm run corpus` |

## Go

```go
import sliccbrowsers "github.com/ai-ecoverse/slicc-browsers"

c := sliccbrowsers.Default()
b, ok := c.Browser("chrome")
```

- `Default() *Catalog` parses the embedded `catalog.json` once and panics if it doesn't parse (CI makes sure it does). `Load() (*Catalog, error)` is the same without the panic. Treat the result as read-only. `Parse([]byte)` parses another copy and rejects a `schema` other than 1.
- `(*Catalog).Browser(id)` and `(*Catalog).Priority(id)`, the index in `browsers` (its length for an unknown id).
- `CatalogJSON()`, `CatalogSchemaJSON()`, `BrowsersSchemaJSON()` and `CorpusJSON()` return copies of the embedded files.
- `Corpus() ([]Case, error)` returns the cases. See [Running the corpus](#running-the-corpus) for the helpers.

## Rust

```toml
[dependencies]
slicc-browsers = "1"

[dev-dependencies]
slicc-browsers = { version = "1", features = ["corpus"] }
```

- Always: `CATALOG`, `CATALOG_SCHEMA`, `BROWSERS_SCHEMA` and `CORPUS_SCHEMA`, each the file's text via `include_str!`, and `SCHEMA` (1). No dependencies.
- Feature `serde`: `Catalog` and the other types, `Catalog::parse(&str)`, `catalog()` (parses `CATALOG`), `Catalog::browser` and `Catalog::priority`. It pulls in `serde` and `serde_json`.
- Feature `corpus` (implies `serde`): `CORPUS`, the text of `corpus.json`, and the module `corpus` with `corpus()`, `Case`, `Layout` and the helpers below. Use it from `[dev-dependencies]` only; with resolver 2 it stays out of normal builds.

Every feature builds for `wasm32-wasip1`.

## npm

`import catalog from '@ai-ecoverse/slicc-browsers' with { type: 'json' }`. The exports are `.` (`catalog.json`), `./catalog.json`, `./corpus.json`, `./schema/catalog.schema.json`, `./schema/browsers.schema.json` and `./schema/corpus.schema.json`.

## `catalog.json`

`"schema": 1`. A minor release only adds fields; a field that changes meaning or goes away needs schema 2 and a major release. Relative paths are arrays of path segments, joined with the platform's separator. Top-level fields:

- `minChromiumMajor` (116): endpoints whose user agent's `Chrome/<major>` (`discovery.chromeMajorPattern`) is lower are left out, and so are installed browsers with `chromiumVersion: true` whose version's leading number is lower. A version that doesn't start with a number is kept.
- `browsers`: every known Chromium browser, **in rank priority order**. Each has:
  - `id`, `name`, `channel` (`stable`, `beta`, `dev`, `canary`, `nightly`, `snapshot`, `testing`), `engine` (`chromium`), and `chromiumVersion`: whether its version is the Chromium version (Chrome, Edge, Chromium) or its own (Brave, Opera, Vivaldi, Arc).
  - `macos`: `bundleId`, `app` (the bundle's file name), `executable` (under `Contents/MacOS`), and `dataDir?`, the default user-data dir under `~/Library/Application Support`.
  - `windows?`: `roots` (names from `platforms.windows.roots`, searched in order) and `executables` (each tried under each root); `dataRoot` and `dataDir`, the default user-data dir; `startMenuInternet?`, the browser's key names under the `StartMenuInternet` registry keys.
  - `linux?`: `bins` (names on `PATH`), `desktopIds` (`.desktop` file names without the suffix), `flatpak?` (the app id), `snap?` (the snap name), `snapDataDir?` (the user-data dir under `~/snap/<snap>/common`), `configDir` (the user-data dir under the config dir, also under `~/.var/app/<flatpak>/config` for a flatpak), and `debs` (dpkg package names for the version).
- `electron`: `macosApps` (known Electron apps by bundle id, with display names), `debugBlocked` (app names that block remote debugging; they're listed with `debugSupport: "disabled"` and never launched), and `idPrefix` (`electron:`, followed by the slug of the name: lower case, runs of other characters as one `-`).
- `rank`: `tiers`, 1 to 5: `sevenOpen` (an endpoint with a seven tab), `endpoint` (any other endpoint), `chrome` (installed `chromeId`), `chromium` (other installed Chromium browsers), `electron` (installed Electron apps).
- `discovery`:
  - `activePortFile` (`DevToolsActivePort`): its first line is the port (1 to 65535) and its second the browser's websocket path, which starts with `/`. A file without both is ignored. A file is live only when its port answers `/json/version` with a `webSocketDebuggerUrl` whose path is that websocket path; otherwise it's stale and ignored. When the port accepts connections but serves no `/json/version`, the endpoint is listed as `wsOnly`, with `ws://127.0.0.1:<port><path>`;
  - `probePorts` (9222 to 9229, probed by `slicc` only);
  - every endpoint's `cdp` is `<scheme>://<host>:<port>`, with the host in lower case and `localhost` and `::1` written as `127.0.0.1`, whatever form the URL was found in. Endpoints with the same host and port, written that way, are one endpoint. A `ws://` `--cdp` URL that is listed as `wsOnly` keeps its websocket URL as given;
  - `sourceRank`: when two sources find the same host and port, the lower rank wins, and on a tie the first found;
  - `names`: an endpoint's name when it isn't from a known browser's user-data dir: `electron` when the user agent contains `electronUserAgent`, else `products[<product>]` for the product before the `/` in `/json/version`'s `Browser`, else that product, else `fallback`;
  - `process`: the process scan, see [The process source](#the-process-source).
- `seven`:
  - `originScheme` and `originHostPattern`: a seven origin is `https://<host>` with a host matching the pattern, except for the `excludedLabels` (`www`). An origin is compared without the scheme's default port (443 for `https`, 80 for `http`), so `https://seven.sliccy.ai:443` is seven and `https://seven.sliccy.ai:8443` is not. The same goes for extra seven origins;
  - `sitePattern` (`[*.]sliccy.ai`);
  - `switches` and `disabledFeatures`: the seven flags, all `--disable-features` values merged into one switch;
  - `prefs`: values merged into a profile's `Default/Preferences` at the `path` of keys;
  - `discardExceptions`: where the site pattern and the extra origins' hosts go, as a `list` of strings or as a `chrome-time-map`, a map from site to the time it was added (microseconds since 1601-01-01 UTC, as a decimal string);
  - `cleanExit`: values that mark the last exit clean;
  - `form` says where a key comes from: `six` (SLICC six's keys) or `chrome-154` (what Chrome 154 reads).
- `profiles`: SLICC profiles live in `<config dir>/<root>/<name>`, and a snap's in `~/snap/<snap>/common/<snapRoot>/<name>`. `legacyRoot` is the old root, which SLICC six also uses, and `sixProfilePattern` matches six's profile names; neither is ever scanned. `namePattern` is a valid profile name.
- `launch`: `chromiumArgs` (with `{profile}` for the profile dir), then the seven flags, then `headless` with `--headless`. Electron apps get `electron.portFlag` with the first free port from `electron.minPort` up that isn't in `electron.reservedPorts`.
- `platforms`: the config dir per OS, the Windows roots, and the Windows registry keys. A location is the environment variable `env` when it's set (on Linux only an absolute path counts), else `absolute`, else `home` under the home dir. `registry`: under each of `hives`, every subkey of each `startMenuInternet` key, with its `openCommand` default value, and the default value of `appPaths\<name>` for each of `appPathNames`.

## The process source

The process scan finds browsers started with a debugging port by something else:
- **Process list.** On Unix it's `discovery.process.unix` (`ps -ax -o pid= -o command=`): one process a line, the pid, whitespace, and the command line. On Windows it's `discovery.process.windows`, which prints a JSON array (or one object) of `ProcessId` and `CommandLine`; entries with no command line are skipped.
- **What's skipped:** pid 0, the scanning process itself, and commands whose first token is a wrapper. The first token is the quoted string when the command starts with a quote. A wrapper is a token whose base name, without `.exe`, `.cmd` or `.bat`, is one of `wrappers`, case-insensitively. A command with no executable before its first `-` token is skipped too.
- **The port** comes from the first `--remote-debugging-port` followed by `=` or whitespace and then digits. A port above 65535 drops the process.
- **The dir** is the value of `--user-data-dir` at the start of a token, followed by `=` or by whitespace (which is skipped). A value that starts with one of `valueQuotes` (`"` or `'`) runs to the matching quote. Any other value runs up to the first whitespace that is followed by `valueStop` (`--`), or to the end of the command, without trailing whitespace. So `--user-data-dir=/Users/me/Library/Application Support/x --no-first-run` gives `/Users/me/Library/Application Support/x`. A value that would start with `--` is empty.
- **Port 0** means the port is in the dir's `DevToolsActivePort`, checked like any other. With no dir, or a dir under the legacy profile root (a `slicc` segment followed by `profiles`, case-insensitively), the process is skipped.
- **Any other port** is probed on `127.0.0.1`. An endpoint from the process scan has `source: "process"` and `userDataDir` set to the dir when there is one.
- **Tests** must fake the process list: never scan the real one in a test.

## Output schema 1

`schema/browsers.schema.json` describes `slicc browsers --json`, which `playwright-cli list --json` also prints. [slicc-cli's README](https://github.com/ai-ecoverse/slicc-cli#slicc-browsers---json---cdp-url---no-bundle-scan) is the authoritative spec for it; this schema is a copy and follows it. Fields can be added; `source` is one of `devtools-active-port`, `flag`, `probe` and `process`.

## The corpus

Each case is a fake machine: a home tree, `DevToolsActivePort` files, fake `/json/version` and `/json/list` answers, a fake process list, `--cdp` URLs, and installed browsers, with the ranked list it must produce in `expected.json`. `corpus.json` holds every case as `{ "name", "case", "expected" }`.

**`case.json`:**
- `description`, and `os?`: the OSes the case runs on (`darwin`, `linux`, `windows`; default all).
- `needs`: what a program must support to run the case: `user-data-dirs` (`DevToolsActivePort` in browsers' default user-data dirs), `seven-profiles` (in the profile roots), `flag` (`--cdp` URLs), `process`, `probe` (port probes, `slicc` only), `origins` (extra seven origins), `installed` (ranking installed browsers). A program skips a case that needs something it doesn't do.
- `env?`: environment variables for discovery, which sees nothing else from the real environment.
- `files?`: file contents by path. Every path starts with a token.
- `cdp?`, `origins?`, `probePorts?`: `--cdp` URLs, extra seven origins, and the ports to probe.
- `processes?`: `{ "pid", "command" }`, or `{ "self": true, "command" }` for the scanning process, whose pid the harness fills in.
- `http?`: fake servers by `host:port`. `localhost` and `[::1]` are `127.0.0.1`. A listed port accepts TCP connections. `/json/version` answers 200 with `version`, `/json/list` (and `/json`) with `list`. A missing body, or any other path, answers 404. An unlisted port refuses connections.
- `installed?`: installed browsers in the shape of output schema 1's `installed`, ranked along with the endpoints.

**Tokens.** `{home}` (the fake home), `{config}` (the config dir), `{sevenProfiles}` (the profile root) and `{userData:<id>}` (the browser's first default user-data dir on this OS) stand for directories. In `files`, `env`, `cdp`, process commands and `expected.json`, a token and the path characters after it (up to whitespace, `"`, `'` or `,`) become a path on the OS under test, with `\` on Windows. The token values come from `catalog.json`, with the case's `env`.

**Never 9222 to 9229.** A developer's own Chrome listens there. The corpus schema refuses those ports, `npm run validate` refuses them anywhere in the corpus, and the fakes never serve them.

### Running the corpus

A harness, per case it runs:
1. makes a temporary home and writes each of `files`;
2. points discovery at that home and the case's `env` only, so no real user-data dir, profile or process is ever read;
3. feeds the fake process list (Unix: `PSOutput`, Windows: `CIMOutput`) and routes every HTTP request and TCP dial to the fakes, so discovery never touches the network;
4. discovers endpoints, ranks them with `installed`, and compares the JSON with `expected.json` after token expansion, as parsed JSON.

Go (`slicc-cli` does this in `test/integration/corpus_test.go`):

```go
cases, _ := sliccbrowsers.Corpus()
for _, c := range cases {
    if !c.Runs(runtime.GOOS, sliccbrowsers.NeedFlag, sliccbrowsers.NeedProcess /* … */) {
        continue
    }
    l := sliccbrowsers.Layout{OS: runtime.GOOS, Home: t.TempDir(), Getenv: func(k string) string { return c.Input.Env[k] }}
    // write c.Files(l); use c.CDP(l), c.PSOutput(l, os.Getpid()) or c.CIMOutput(l, os.Getpid()),
    // c.Transport() as the http.RoundTripper and c.DialContext for TCP; compare with c.ExpectedJSON(l)
}
```

Rust, with the `corpus` feature:

```rust
use slicc_browsers::corpus::{corpus, Layout, NEED_PROCESS, NEED_PROFILES};

let cat = slicc_browsers::catalog();
let os = match std::env::consts::OS { "macos" => "darwin", other => other };
for case in corpus().cases {
    if !case.runs(os, &[NEED_PROFILES, NEED_PROCESS]) {
        continue;
    }
    let home = tempdir.path().to_str().unwrap();
    let env = |k: &str| case.input.env.get(k).cloned();
    let layout = Layout { os, home, env: &env, catalog: &cat };
    // write case.files(&layout); case.ps_output(&layout, std::process::id()) or case.cim_output(…);
    // answer HTTP with case.http_get(host_port, path) and TCP with case.server(host_port).is_some();
    // compare with case.expected(&layout)
}
```

`Layout` also gives `Config`, `SevenProfiles`, `UserDataDirs(id)`, `Token(name)` and `Expand(text)` (Rust: `config`, `seven_profiles`, `user_data_dirs`, `token`, `expand`). Their results for a few homes are pinned in `test/integration/layout.json`, which the Go and Rust tests both check.

## Development

Go 1.26, Rust stable with `wasm32-wasip1`, Node ≥ 24.
- `npm run corpus` regenerates `corpus.json` from `corpus/`; the pre-commit hook and CI fail when it's stale.
- `npm run validate` checks `catalog.json` and `corpus.json` against the schemas, plus what a schema can't say: unique ids, bundle ids and names, known Windows roots, rising tiers, compiling patterns, known tokens, tier order and `sevenOpen` in each `expected.json`, and no port from 9222 to 9229.
- `npm run lint`: the slicc lint tools (Biome, no comments, no unit tests in git, `AGENTS.md`), `gofmt`, `go mod tidy -diff`, `go vet`, golangci-lint, `cargo fmt --check` and clippy.
- `npm test`: `validate`, the Go tests in `test/integration/`, and `cargo test --all-features`.
- `npm run build`: the Go module, the crate (also for `wasm32-wasip1`), and `npm pack --dry-run`.

Changing a table in `slicc-cli/internal/browser` means changing `catalog.json` here, releasing, and bumping the dependency; slicc-cli has no tables of its own. A new behaviour gets a corpus case.

## Releases

semantic-release cuts one version from `main` for all three packages (`.github/workflows/release.yml`):
1. The tag `vX.Y.Z` and a GitHub release are the Go module's release. `scripts/major-guard.mjs` fails the release when the major doesn't fit the module path in `go.mod` (no suffix allows v0 and v1, `/vN` only vN). The workflow then asks `proxy.golang.org` for the new version and `pkg.go.dev` to fetch it; both only warn.
2. **npm:** with the repository variable `SLICC_BROWSERS_NPM_PUBLISH` set to `true`, the package is stamped with the version and published through npm trusted publishing (OIDC, with provenance). A version that is already on npm is skipped.
3. **crates.io:** with the repository variable `SLICC_BROWSERS_CRATES_PUBLISH` set to `true`, `Cargo.toml` is stamped with the version and `cargo publish` runs with a short-lived token from crates.io trusted publishing (`rust-lang/crates-io-auth-action`). A version that is already on crates.io is skipped.

A run started by hand publishes what's missing without a new release: `gh workflow run release.yml --ref main` when `main`'s head has its tag, or `gh workflow run release.yml --ref main -f tag=vX.Y.Z` for any existing tag.

**Go module versions.** A pushed tag is the release: `proxy.golang.org` caches it and `sum.golang.org` records its hash for good. Never move or delete a pushed tag; retract a bad version in `go.mod` and release anew. A `BREAKING CHANGE` needs a `/vN` module path first.

**First publish (by a maintainer with 2FA):**
1. npm: `npx fledgling add --new @ai-ecoverse/slicc-browsers` claims the name with a `0.0.0` placeholder and trusts `ai-ecoverse/slicc-browsers`' `release.yml`. Then set `SLICC_BROWSERS_NPM_PUBLISH` to `true`.
2. crates.io: trusted publishing needs the crate to exist. Publish it once by hand from the latest tag: `git checkout vX.Y.Z && node scripts/set-crate-version.mjs X.Y.Z && cargo publish --allow-dirty`, logged in with `cargo login`. Then, on crates.io, add a trusted publisher to `slicc-browsers`: GitHub, owner `ai-ecoverse`, repository `slicc-browsers`, workflow `release.yml`, no environment. Then set `SLICC_BROWSERS_CRATES_PUBLISH` to `true`.
