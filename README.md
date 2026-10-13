# slicc-browsers

The browser catalog, JSON schemas and conformance corpus shared by the two programs that find and launch browsers for SLICC:
- `slicc browsers` and `slicc launch` in [slicc-cli](https://github.com/ai-ecoverse/slicc-cli) (Go, `CGO_ENABLED=0`);
- `playwright-cli list` and `open` in [slicc-cdp](https://github.com/ai-ecoverse/slicc-cdp) (Rust, also built for `wasm32-wasip1`).

It also holds the [protected origins](#protected-origins): the origins browser control must never reach, which slicc-agent checks too.

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
| `protected.json`, `schema/protected.schema.json` | the protected-origin test vectors and their schema |
| `protected.mjs` | the reference protected-origin matcher, in JavaScript (npm only) |

## Go

```go
import sliccbrowsers "github.com/ai-ecoverse/slicc-browsers"

c := sliccbrowsers.Default()
b, ok := c.Browser("chrome")
```

- `Default() *Catalog` parses the embedded `catalog.json` once and panics if it doesn't parse (CI makes sure it does). `Load() (*Catalog, error)` is the same without the panic. Treat the result as read-only. `Parse([]byte)` parses another copy and rejects a `schema` other than 1.
- `(*Catalog).Browser(id)` and `(*Catalog).Priority(id)`, the index in `browsers` (its length for an unknown id).
- `CatalogJSON()`, `CatalogSchemaJSON()`, `BrowsersSchemaJSON()`, `CorpusJSON()`, `ProtectedJSON()` and `ProtectedSchemaJSON()` return copies of the embedded files.
- `(*Catalog).ProtectedOrigins` is `catalog.json`'s `protectedOrigins`. `Protected() (*ProtectedVectors, error)` parses `protected.json` (`Origins`, `URLs`, `Targets`, `CookieDomains`, `StorageKeys`; a target's `Opener` is `""`, `OpenerProtected`, `OpenerUnprotected` or `OpenerUnknown`).
- `Corpus() ([]Case, error)` returns the cases. See [Running the corpus](#running-the-corpus) for the helpers.

## Rust

```toml
[dependencies]
slicc-browsers = "1"

[dev-dependencies]
slicc-browsers = { version = "1", features = ["corpus"] }
```

- Always: `CATALOG`, `CATALOG_SCHEMA`, `BROWSERS_SCHEMA`, `CORPUS_SCHEMA` and `PROTECTED_SCHEMA`, each the file's text via `include_str!`, and `SCHEMA` (1). No dependencies.
- Feature `serde`: `Catalog` and the other types (`protected_origins` is a `ProtectedOrigins`), `Catalog::parse(&str)`, `catalog()` (parses `CATALOG`), `Catalog::browser` and `Catalog::priority`. It pulls in `serde` and `serde_json`.
- Feature `corpus` (implies `serde`): `CORPUS` and `PROTECTED`, the text of `corpus.json` and `protected.json`; the module `corpus` with `corpus()`, `Case`, `Layout` and the helpers below; and the module `protected` with `vectors()`, `Vectors` and the `OPENER_*` constants. Use it from `[dev-dependencies]` only; with resolver 2 it stays out of normal builds.

Every feature builds for `wasm32-wasip1`.

## npm

`import catalog from '@ai-ecoverse/slicc-browsers' with { type: 'json' }`. The exports are `.` (`catalog.json`), `./catalog.json`, `./corpus.json`, `./protected.json`, `./protected.mjs`, `./schema/catalog.schema.json`, `./schema/browsers.schema.json`, `./schema/corpus.schema.json` and `./schema/protected.schema.json`.

`protected.mjs` is the reference matcher for [protected origins](#protected-origins): `import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs'`, then `protectedOrigins(catalog.protectedOrigins, extraOrigins)` returns `{ url(text), target({ url, previous, opener }), cookieDomain(domain), storageKey(key) }`, each a boolean. It needs only the WHATWG `URL`, so it runs in Node and in a browser.

## `catalog.json`

`"schema": 1`. A minor release only adds fields; a field that changes meaning or goes away needs schema 2 and a major release. Relative paths are arrays of path segments, joined with the platform's separator. Top-level fields:

- `minChromiumMajor` (116): endpoints whose user agent's `Chrome/<major>` (`discovery.chromeMajorPattern`) is lower are left out, and so are installed browsers with `chromiumVersion: true` whose version's leading number is lower. A version that doesn't start with a number is kept.
- `browsers`: every known Chromium browser, **in rank priority order**. Each has:
  - `id`, `name`, `channel` (`stable`, `beta`, `dev`, `canary`, `nightly`, `snapshot`, `testing`), `engine` (`chromium`), and `chromiumVersion`: whether its version is the Chromium version (Chrome, Edge, Chromium) or its own (Brave, Opera, Vivaldi, Arc).
  - `macos`: `bundleId`, `app` (the bundle's file name), `executable` (under `Contents/MacOS`), and `dataDir?`, the default user-data dir under `~/Library/Application Support`.
  - `windows?`: `roots` (names from `platforms.windows.roots`, searched in order) and `executables` (each tried under each root); `dataRoot` and `dataDir`, the default user-data dir; `startMenuInternet?`, the browser's key names under the `StartMenuInternet` registry keys.
  - `linux?`: `bins` (names on `PATH`), `desktopIds` (`.desktop` file names without the suffix), `flatpak?` (the app id), `snap?` (the snap name), `snapDataDir?` (the user-data dir under `~/snap/<snap>/common`), `configDir` (the user-data dir under the config dir, also under `~/.var/app/<flatpak>/config` for a flatpak), and `debs` (dpkg package names for the version).
- `electron`: `macosApps` (known Electron apps by bundle id, with display names), `debugBlocked` (app names that block remote debugging; they're listed with `debugSupport: "disabled"` and never launched), and `idPrefix` (`electron:`, followed by the slug of the name: lower case, runs of other characters as one `-`).
- `rank`: `tiers`, 1 to 6: `sevenOpen` (an endpoint with a seven tab), `endpoint` (any other endpoint), `chrome` (installed `chromeId`), `chromium` (other installed Chromium browsers), `electron` (installed Electron apps), `six` (an endpoint in SLICC six's profile, with or without a seven tab; see [SLICC six's profiles](#slicc-sixs-profiles)).
- `discovery`:
  - `activePortFile` (`DevToolsActivePort`): its first line is the port (1 to 65535) and its second the browser's websocket path, which starts with `/`. A file without both is ignored. A file is live only when its port answers `/json/version` with a `webSocketDebuggerUrl` whose path is that websocket path; otherwise it's stale and ignored. When the port accepts connections but serves no `/json/version`, the endpoint is listed as `wsOnly`, with `ws://127.0.0.1:<port><path>`;
  - `probePorts` (9222 to 9229, probed by `slicc` only);
  - every endpoint's `cdp` is `<scheme>://<host>:<port>`, with the host in lower case and `localhost` and `::1` written as `127.0.0.1`, whatever form the URL was found in. Endpoints with the same host and port, written that way, are one endpoint. A `ws://` `--cdp` URL that is listed as `wsOnly` keeps its websocket URL as given;
  - `sourceRank`: when two sources find the same host and port, the lower rank wins, and on a tie the first found;
  - `names`: an endpoint's name when it isn't from a known browser's user-data dir: `electron` when the user agent contains `electronUserAgent`, else `products[<product>]` for the product before the `/` in `/json/version`'s `Browser`, else that product, else `fallback`;
  - `process`: the process scan, see [The process source](#the-process-source).
- `seven`:
  - `originScheme` and `originHostPattern`: a seven origin is `https://<host>` with a host matching the pattern, except for the `excludedLabels` (`www`, `vault`, `vault-preview`, `get`, `mcpcat`) and the `excludedLabelPrefixes` (`vault-`, which excludes `vault-feature-x` and any other vault branch preview). The bare apex (`sliccy.ai`, i.e. an empty label) never matches. An origin is compared without the scheme's default port (443 for `https`, 80 for `http`), so `https://seven.sliccy.ai:443` is seven and `https://seven.sliccy.ai:8443` is not. The same goes for extra seven origins;
  - `sitePattern` (`[*.]sliccy.ai`);
  - `switches` and `disabledFeatures`: the seven flags, all `--disable-features` values merged into one switch;
  - `prefs`: values merged into a profile's `Default/Preferences` at the `path` of keys;
  - `discardExceptions`: where the site pattern and the extra origins' hosts go, as a `list` of strings or as a `chrome-time-map`, a map from site to the time it was added (microseconds since 1601-01-01 UTC, as a decimal string);
  - `cleanExit`: values that mark the last exit clean;
  - `form` says where a key comes from: `six` (SLICC six's keys) or `chrome-154` (what Chrome 154 reads).
- `protectedOrigins`: what browser control must never reach, see [Protected origins](#protected-origins). `domains` (`sliccy.ai`), `hosts` (`vault.sliccy.ai`), `schemes` (`https`, `http`), `innerSchemes` (`blob`, `filesystem`, `view-source`), `anySchemes` (`devtools`), `inheriting` (`about:blank`, `about:srcdoc`), and `refusal`, the text of a refusal.
- `profiles`: SLICC profiles live in `<config dir>/<root>/<name>`, and a snap's in `~/snap/<snap>/common/<snapRoot>/<name>`. `legacyRoot` is the old root, never scanned; on macOS's case-insensitive volume it is SLICC six's root too. `sixProfilePattern` matches six's profile names, case-insensitively. `namePattern` is a valid profile name. `six` describes SLICC six's Chrome profiles (see [SLICC six's profiles](#slicc-sixs-profiles)):
  - `roots`: six's profile root per OS (`macos`, `linux`, `windows`), a `base` location followed by the `path` segments. The base is its `env` when that is set and not empty (any value, as six takes it), else `home` under the home dir.
  - `defaultName` (`browser-coding-agent-chrome`), `defaultPort` (5710) and `portSuffix` (`-{port}`): six's profile for its serve port `<port>` is `<root>/<defaultName>`, with `portSuffix` added for any port other than `defaultPort`.
  - `userDataDirEnv` (`SLICC_USER_DATA_DIR`): when set, its value, trimmed of whitespace, is six's profile for every port, unless it is empty.
- `launch`: `chromiumArgs` (with `{profile}` for the profile dir), then the seven flags, then `headless` with `--headless`. Electron apps get `electron.portFlag` with the first free port from `electron.minPort` up that isn't in `electron.reservedPorts`.
- `platforms`: the config dir per OS, the Windows roots, and the Windows registry keys. A location is the environment variable `env` when it's set (on Linux only an absolute path counts), else `absolute`, else `home` under the home dir. `registry`: under each of `hives`, every subkey of each `startMenuInternet` key, with its `openCommand` default value, and the default value of `appPaths\<name>` for each of `appPathNames`.

## Protected origins

Browser control must never navigate to, open or attach to a target on seven's own origin, or read or write its cookies or storage: not slicc-cli's `cdp` relay, not slicc-cdp's `playwright-cli`, not slicc-agent. `protectedOrigins` in `catalog.json` says what is protected, and every implementation runs the vectors in `protected.json`.

**URLs.** A URL is parsed the way the WHATWG URL Standard (and so the browser) parses it, so `https:\\seven.sliccy.ai`, a tab or newline inside the URL, `%2E`, `。` and full-width letters all reach seven. In Go and Rust that takes a WHATWG parser, not `net/url`. A URL that doesn't parse isn't protected; the browser doesn't load it either. Then:
1. While its scheme is one of `innerSchemes`, the rest of the URL after `<scheme>:` takes its place, at most 8 times: `blob:https://seven.sliccy.ai/<uuid>` is `https://seven.sliccy.ai/<uuid>`.
2. A scheme in `anySchemes` is protected whatever follows: a DevTools front end (`devtools://`) can be inspecting seven.
3. A scheme in `schemes` is protected when its host is one of `hosts`, or one of `domains` or under one, at any depth and on any port. The host is lower-cased, and one trailing dot is dropped.
4. Any other URL is protected when its origin is one of the program's **extra origins**: the seven origins it accepts besides `sliccy.ai` (slicc-cli's `--origin` and `--page` origins), compared as `scheme://host[:port]` without the scheme's default port, with the host as in 3.

This is wider than the rule for finding seven (`seven.originHostPattern`, which leaves out the `excludedLabels` and `excludedLabelPrefixes`—`www`, `vault`, `vault-preview`, `get`, `mcpcat`, and any `vault-*` prefix). Every `sliccy.ai` host shares the `sliccy.ai` cookies, and cookies ignore the port and, without `Secure`, the scheme. SLICC six lives on `www.sliccy.ai` and the apex, and its cookies matter. `*.kernel.localhost` is not protected: each port is its own origin, and the agent's own servers live there. An extra origin is matched exactly, so `http://127.0.0.1:5710` doesn't protect `http://127.0.0.1:5711`.

**The vault.** `vault.sliccy.ai` is in `hosts` by name, and vault branch previews (`vault-preview.sliccy.ai`, `vault-*.sliccy.ai`) are covered by the `sliccy.ai` domain rule. `sliccy.ai` already covers them all, but vault must stay protected even if `domains` ever changes: the vault must never be a CDP target for agent tools. The one exception is slicc-cli's own pairing attach for the vault, which is the CLI's own connection and not browser control handed to the agent.

**Targets.** A target's effective origin is its URL's (`TargetInfo.url`), except when the URL inherits the origin of whoever made the document: the empty URL, and `inheriting` with any query or fragment. Such a target is protected when it was protected before this URL (a seven tab that went to `about:blank` keeps seven's origin), or when its opener (`openerId`, else `openerFrameId`) is protected or unknown, for an opener closed before the program saw it. The URL, `openerFrameId` and `browserContextId` alone can't tell: a blank popup that seven opens has seven's origin and the URL `about:blank`. A program that holds a session to the target also has the document's real origin: the main frame's `securityOrigin` in `Page.frameNavigated`, and the default context's `origin` in `Runtime.executionContextCreated`. When one of those is protected, the target is protected too, until a URL with an origin of its own replaces it.

A same-site frame shares its parent's process and has no target of its own. Every `sliccy.ai` host is protected, and site isolation gives a seven frame inside any other site its own target, so this only matters for an extra origin whose site has other origins (another port of `127.0.0.1`, say).

**Cookies.** A cookie domain, lower-cased and without a leading or trailing dot, is protected when it is one of `domains` or under one, or when it is one of `hosts`, the host of a protected domain or an extra origin, or a parent of one: a cookie on `.example.test` reaches `https://seven.example.test`.

**Storage keys** (`Storage`, `IndexedDB`, `CacheStorage` and `FileSystem` in CDP): a key is protected when its origin (up to the first `^`) or its top-level site (a part after `^0`) is a protected URL.

**Refusals** carry the text in `refusal`, `slicc: refused: target is on seven's origin`.

**`protected.json`** (schema `schema/protected.schema.json`): `origins`, the extra origins every vector runs with; `urls` (`url`, `protected`); `targets` (`url`, `previous?`, whether the target was protected before; `opener?`, `protected`, `unprotected` or `unknown`, and no `opener` for a target without one; `protected`); `cookieDomains` (`domain`, `protected`); `storageKeys` (`key`, `protected`). `npm run validate` runs every vector through `protected.mjs`, and no vector uses a port from 9222 to 9229.

## The process source

The process scan finds browsers started with a debugging port by something else:
- **Process list.** On Unix it's `discovery.process.unix` (`ps -ax -o pid= -o command=`): one process a line, the pid, whitespace, and the command line. On Windows it's `discovery.process.windows`, which prints a JSON array (or one object) of `ProcessId` and `CommandLine`; entries with no command line are skipped.
- **What's skipped:** pid 0, the scanning process itself, and commands whose first token is a wrapper. The first token is the quoted string when the command starts with a quote. A wrapper is a token whose base name, without `.exe`, `.cmd` or `.bat`, is one of `wrappers`, case-insensitively. A command with no executable before its first `-` token is skipped too.
- **The port** comes from the first `--remote-debugging-port` followed by `=` or whitespace and then digits. A port above 65535 drops the process.
- **The dir** is the value of `--user-data-dir` at the start of a token, followed by `=` or by whitespace (which is skipped). A value that starts with one of `valueQuotes` (`"` or `'`) runs to the matching quote. Any other value runs up to the first whitespace that is followed by `valueStop` (`--`), or to the end of the command, without trailing whitespace. So `--user-data-dir=/Users/me/Library/Application Support/x --no-first-run` gives `/Users/me/Library/Application Support/x`. A value that would start with `--` is empty.
- **Port 0** means the port is in the dir's `DevToolsActivePort`, checked like any other. With no dir, or a dir under the legacy profile root (a `slicc` segment followed by `profiles`, case-insensitively) that isn't one of [six's profile dirs](#slicc-sixs-profiles), the process is skipped.
- **Any other port** is probed on `127.0.0.1`. An endpoint from the process scan has `source: "process"` and `userDataDir` set to the dir when there is one.
- **Tests** must fake the process list: never scan the real one in a test.

## SLICC six's profiles

SLICC six launches Chrome in a profile of its own, and slicc-cli can use that profile in place (`slicc --profile six`). Discovery never chooses it: its endpoints are listed, marked and ranked last.

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| six's root | `~/Library/Application Support/Slicc/profiles` | `$XDG_STATE_HOME/slicc/profiles`, else `~/.local/state/slicc/profiles` | `%LOCALAPPDATA%\Slicc\profiles`, else `~\AppData\Local\Slicc\profiles` |

Taken from [ai-ecoverse/slicc](https://github.com/ai-ecoverse/slicc) at `65c5a79b4` (v6.247.17-8):

| what | where |
| --- | --- |
| the root per OS | `packages/node-server/src/chrome-launch.ts:119-136` (`resolveProfilesDir`); `packages/swift-server/Sources/Browser/ChromeLauncher.swift:314-322` (macOS only) |
| `browser-coding-agent-chrome` | `chrome-launch.ts:27`; `ChromeLauncher.swift:5` |
| the `-<port>` suffix for a serve port other than 5710 | `chrome-launch.ts:147`; `ChromeLauncher.swift:6`, `:323` |
| `SLICC_USER_DATA_DIR`, trimmed | `chrome-launch.ts:143-146` (node-server only) |
| six's own `--remote-debugging-port` (9222 by default) | `chrome-launch.ts:283`, `packages/node-server/src/runtime-flags.ts:47`; `ChromeLauncher.swift:213` |

**Six's profile dirs** are the dirs in six's root whose name matches `sixProfilePattern` case-insensitively, and the `SLICC_USER_DATA_DIR` dir. A dir found anywhere is six's when it is one of them: the paths are compared case-insensitively, with `/` and `\` alike, and after resolving symlinks where the program can (so a symlink to six's profile, or a symlinked root, is six's too).

**Discovery** marks an endpoint `six: true` when one of its sources found it in six's profile:
- `DevToolsActivePort` in each of six's profile dirs, checked like any other. No other dir in six's root is read.
- The process list: a process whose `--user-data-dir` is six's. With port 0 its `DevToolsActivePort` is read, which the legacy-root rule would otherwise skip.
- Merging: an endpoint is six's when any source that found it, and whose checks passed, is six's. So a port probe hit or a `--cdp` URL that the process list maps to six's profile is six's, while a stale `DevToolsActivePort` in six's profile marks nothing. Its `userDataDir` is six's dir when the source that wins has none.

A six endpoint has tier `six`, whatever its seven tabs. **A program never chooses it by itself**: a default choice, an "attach to the best" rule, or a non-interactive mode skips it. Only an explicit request for six's profile unlocks it, such as `slicc --profile six` or picking it in a picker.

## Output schema 1

`schema/browsers.schema.json` describes `slicc browsers --json`, which `playwright-cli list --json` also prints. [slicc-cli's README](https://github.com/ai-ecoverse/slicc-cli#slicc-browsers---json---cdp-url---no-bundle-scan) is the authoritative spec for it; this schema is a copy and follows it. Fields can be added; `source` is one of `devtools-active-port`, `flag`, `probe` and `process`. `tier` is 1 to 6, and `six: true` marks an endpoint in SLICC six's profile (tier 6).

## The corpus

Each case is a fake machine: a home tree, `DevToolsActivePort` files, fake `/json/version` and `/json/list` answers, a fake process list, `--cdp` URLs, and installed browsers, with the ranked list it must produce in `expected.json`. `corpus.json` holds every case as `{ "name", "case", "expected" }`.

**`case.json`:**
- `description`, and `os?`: the OSes the case runs on (`darwin`, `linux`, `windows`; default all).
- `needs`: what a program must support to run the case: `user-data-dirs` (`DevToolsActivePort` in browsers' default user-data dirs), `seven-profiles` (in the profile roots), `flag` (`--cdp` URLs), `process`, `probe` (port probes, `slicc` only), `origins` (extra seven origins), `installed` (ranking installed browsers), `six` (finding and marking SLICC six's profiles). A program skips a case that needs something it doesn't do.
- `env?`: environment variables for discovery, which sees nothing else from the real environment.
- `files?`: file contents by path. Every path starts with a token.
- `cdp?`, `origins?`, `probePorts?`: `--cdp` URLs, extra seven origins, and the ports to probe.
- `processes?`: `{ "pid", "command" }`, or `{ "self": true, "command" }` for the scanning process, whose pid the harness fills in.
- `http?`: fake servers by `host:port`. `localhost` and `[::1]` are `127.0.0.1`. A listed port accepts TCP connections. `/json/version` answers 200 with `version`, `/json/list` (and `/json`) with `list`. A missing body, or any other path, answers 404. An unlisted port refuses connections.
- `installed?`: installed browsers in the shape of output schema 1's `installed`, ranked along with the endpoints.
- `auto`: exactly in the cases that need `six`, the id of the first entry in `expected.json` that isn't six's, or `null` when every entry is. A program that chooses without being asked must choose no entry before it, and never a six entry.

**Tokens.** `{home}` (the fake home), `{config}` (the config dir), `{sevenProfiles}` (the profile root), `{sixProfiles}` (SLICC six's root) and `{userData:<id>}` (the browser's first default user-data dir on this OS) stand for directories. In `files`, `env`, `cdp`, process commands and `expected.json`, a token and the path characters after it (up to whitespace, `"`, `'` or `,`) become a path on the OS under test, with `\` on Windows. The token values come from `catalog.json`, with the case's `env`.

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

`Layout` also gives `Config`, `SevenProfiles`, `SixProfiles`, `UserDataDirs(id)`, `Token(name)` and `Expand(text)` (Rust: `config`, `seven_profiles`, `six_profiles`, `user_data_dirs`, `token`, `expand`). Their results for a few homes are pinned in `test/integration/layout.json`, which the Go and Rust tests both check.

## Development

Go 1.26, Rust stable with `wasm32-wasip1`, Node ≥ 24.
- `npm run corpus` regenerates `corpus.json` from `corpus/`; the pre-commit hook and CI fail when it's stale.
- `npm run validate` checks `catalog.json`, `corpus.json` and `protected.json` against the schemas, runs the protected-origin vectors through `protected.mjs`, and checks what a schema can't say: unique ids, bundle ids and names, known Windows roots, rising tiers, compiling patterns, known tokens, tier order, `sevenOpen`, `six` and `auto` in each `expected.json`, and no port from 9222 to 9229.
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
