# slicc-browsers

The browser catalog, JSON schemas and conformance corpus shared by the two programs that find and launch browsers for SLICC:
- `slicc browsers` and `slicc launch` in [slicc-cli](https://github.com/ai-ecoverse/slicc-cli) (Go, `CGO_ENABLED=0`);
- `playwright-cli list` and `open` in [slicc-cdp](https://github.com/ai-ecoverse/slicc-cdp) (Rust, also built for `wasm32-wasip1`).

It also holds the [protected origins](#protected-origins): the origins browser control must never reach, which slicc-agent checks too. It also holds the [guard vectors](#guard-vectors), which every CDP guard runs: bios, slicc-cdp, slicc-extension and slicc-cli.

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
| `guard-vectors.json`, `schema/guard-vectors.schema.json` | the guard vectors and their schema |
| `guard-driver.mjs` | the guard vectors' beacon and canary helpers, in JavaScript (npm only) |

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
- `Guard() (*GuardVectors, error)` parses `guard-vectors.json`; `GuardVectorsJSON()` and `GuardVectorsSchemaJSON()` return copies of the files. `Guard()` parses it into `SchemaVersion`, `SetVersion`, `Targets`, `Variants`, `Capabilities`, `Placeholders` and `Vectors`. A `GuardExpected` is `Checks` (names to booleans) or `Text`, and a `GuardObservation` is `Means`, `DependsOn` and `Requires`. The `GuardTarget*`, `GuardOrdinary`, `GuardSameSite`, `GuardKind*`, `GuardVia*`, `GuardScopeAny`, `GuardControl`, `GuardGuarded`, `GuardCap*` and `GuardSession*` constants name the values.
- `Corpus() ([]Case, error)` returns the cases. See [Running the corpus](#running-the-corpus) for the helpers.

## Rust

```toml
[dependencies]
slicc-browsers = "1"

[dev-dependencies]
slicc-browsers = { version = "1", features = ["corpus"] }
```

- Always: `CATALOG`, `CATALOG_SCHEMA`, `BROWSERS_SCHEMA`, `CORPUS_SCHEMA`, `PROTECTED_SCHEMA` and `GUARD_VECTORS_SCHEMA`, each the file's text via `include_str!`, and `SCHEMA` (1). No dependencies.
- Feature `serde`: `Catalog` and the other types (`protected_origins` is a `ProtectedOrigins`), `Catalog::parse(&str)`, `catalog()` (parses `CATALOG`), `Catalog::browser` and `Catalog::priority`. It pulls in `serde` and `serde_json`.
- Feature `corpus` (implies `serde`): `CORPUS`, `PROTECTED` and `GUARD_VECTORS`, the text of `corpus.json`, `protected.json` and `guard-vectors.json`; the module `corpus` with `corpus()`, `Case`, `Layout` and the helpers below; the module `protected` with `vectors()`, `Vectors` and the `OPENER_*` constants; and the module `guard` with `vectors()`, `Vectors`, `Vector`, `Step`, `Observation`, `Expected` (`Checks` or `Text`), and the `TARGET_*`, `ORDINARY*`, `KIND_*`, `VIA_*`, `SCOPE_ANY`, `CONTROL`, `GUARDED`, `CAP_*` and `SESSION_*` constants. Use it from `[dev-dependencies]` only; with resolver 2 it stays out of normal builds.

Every feature builds for `wasm32-wasip1`.

## npm

`import catalog from '@ai-ecoverse/slicc-browsers' with { type: 'json' }`. The exports are `.` (`catalog.json`), `./catalog.json`, `./corpus.json`, `./protected.json`, `./protected.mjs`, `./guard-vectors.json`, `./guard-driver.mjs`, `./schema/catalog.schema.json`, `./schema/browsers.schema.json`, `./schema/corpus.schema.json`, `./schema/protected.schema.json` and `./schema/guard-vectors.schema.json`.

`guard-driver.mjs` is described under [Guard vectors](#guard-vectors).

`protected.mjs` is the reference matcher for [protected origins](#protected-origins): `import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs'`, then `protectedOrigins(catalog.protectedOrigins, extraOrigins)` returns `{ url(text), target({ url, previous, opener, type, documentURL, unreachableURL, navigating }), cookieDomain(domain), storageKey(key), unparseable(text) }`, each a boolean. `url(text)` uses the load/loaded-URL fail-closed rule; `url(text, { readOnly: true })` preserves the old parse-failure result for read-only keys and value redaction, and `storageKey(key)` uses that mode internally. `unparseable(text)` identifies parse or unwrap failures without changing whether a parsed origin is protected. It needs only the WHATWG `URL`, so it runs in Node and in a browser. `protected.mjs` and `seven.mjs` import nothing and re-export nothing, so an extension or service worker can ship either file alone; `npm run validate` (through `scripts/self-contained.mjs`) evaluates each as a module in a fresh `node:vm` context that has only `URL`, with no linker resolution allowed.

The complete static import graph of `guard-runner.mjs` is browser-safe too: it uses ordinary browser globals (`URL`, timers, `fetch`, `atob`/`btoa`, `Uint8Array`, `TextEncoder` and `TextDecoder`), never `Buffer`, `process`, `require` or `node:` imports. Base64 bodies and postData are decoded with `atob` and UTF-8 bytes rather than a Node shim. `npm run validate` loads and executes that graph in a fresh `node:vm` browser-like context, including an encoded-body exercise and a drivable page row. The separate host-side `./fixture` server intentionally uses Node HTTP/TLS APIs and is not imported by the browser runner.

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
  - `probePorts` (9222 to 9229);
  - every endpoint's `cdp` is `<scheme>://<host>:<port>`, with the host in lower case and `localhost` and `::1` written as `127.0.0.1`, whatever form the URL was found in. Endpoints with the same host and port, written that way, are one endpoint. A `ws://` `--cdp` URL that is listed as `wsOnly` keeps its websocket URL as given;
  - `sourceRank`: when two sources find the same host and port, the lower rank wins, and on a tie the first found;
  - `names`: an endpoint's name when it isn't from a known browser's user-data dir: `electron` when the user agent contains `electronUserAgent`, else `products[<product>]` for the product before the `/` in `/json/version`'s `Browser`, else that product, else `fallback`;
  - `process`: the process scan, see [The process source](#the-process-source).
- `seven`:
  - `originScheme` and `originHostPattern`: a seven origin is `https://<host>` with a host matching the pattern, except for the `excludedLabels` (`www`, `vault`, `vault-preview`, `get`, `mcpcat`, `echo`) and the `excludedLabelPrefixes` (`vault-`, which excludes `vault-feature-x` and any other vault branch preview). The bare apex (`sliccy.ai`, i.e. an empty label) never matches. An origin is compared without the scheme's default port (443 for `https`, 80 for `http`), so `https://seven.sliccy.ai:443` is seven and `https://seven.sliccy.ai:8443` is not. The same goes for extra seven origins;
  - `sitePattern` (`[*.]sliccy.ai`);
  - `switches` and `disabledFeatures`: the seven flags, all `--disable-features` values merged into one switch;
  - `prefs`: values merged into a profile's `Default/Preferences` at the `path` of keys;
  - `discardExceptions`: where the site pattern and the extra origins' hosts go, as a `list` of strings or as a `chrome-time-map`, a map from site to the time it was added (microseconds since 1601-01-01 UTC, as a decimal string);
  - `cleanExit`: values that mark the last exit clean;
  - `form` says where a key comes from: `six` (SLICC six's keys) or `chrome-154` (what Chrome 154 reads).
- `protectedOrigins`: what browser control must never reach, see [Protected origins](#protected-origins). `domains` (`sliccy.ai`), `hosts` (`vault.sliccy.ai`), `schemes` (`https`, `http`), `innerSchemes` (`blob`, `filesystem`, `view-source`), `anySchemes` (`devtools`), `protectedSchemes` (`chrome`, `chrome-untrusted`, `chrome-search`, `chrome-native`, `chrome-distiller`, `chrome-experimental-site-token-provider`, `isolated-app`, `externalfile`, `content`, `chrome-extension`, `devtools`, `edge`, `brave`, `opera`, `vivaldi`, `arc`, `file`) with `schemeExceptions` (`chrome://newtab`, `chrome://new-tab-page`, `chrome-untrusted://new-tab-page`, `edge://newtab`, `brave://newtab`, `opera://startpage`), `aboutScheme` (`chrome`), `targetTypes` (`browser_ui`), `inheriting` (`about:blank`, `about:srcdoc`), `errorPage` (`url: "chrome-error://chromewebdata/"`, `target: "previous"`, `redact: "origin"`), `unparseable` (`protected`) with `unparseableRefusal`, and `refusal`, the text of a parsed protected-origin refusal.
- `profiles`: SLICC profiles live in `<config dir>/<root>/<name>`, and a snap's in `~/snap/<snap>/common/<snapRoot>/<name>`. `legacyRoot` is the old root, never scanned; on macOS's case-insensitive volume it is SLICC six's root too. `sixProfilePattern` matches six's profile names, case-insensitively. `namePattern` is a valid profile name. `six` describes SLICC six's Chrome profiles (see [SLICC six's profiles](#slicc-sixs-profiles)):
  - `roots`: six's profile root per OS (`macos`, `linux`, `windows`), a `base` location followed by the `path` segments. The base is its `env` when that is set and not empty (any value, as six takes it), else `home` under the home dir.
  - `defaultName` (`browser-coding-agent-chrome`), `defaultPort` (5710) and `portSuffix` (`-{port}`): six's profile for its serve port `<port>` is `<root>/<defaultName>`, with `portSuffix` added for any port other than `defaultPort`.
  - `userDataDirEnv` (`SLICC_USER_DATA_DIR`): when set, its value, trimmed of whitespace, is six's profile for every port, unless it is empty.
- `launch`: `chromiumArgs` (with `{profile}` for the profile dir), then the seven flags, then `headless` with `--headless`. Electron apps get `electron.portFlag` with the first free port from `electron.minPort` up that isn't in `electron.reservedPorts`.
- `platforms`: the config dir per OS, the Windows roots, and the Windows registry keys. A location is the environment variable `env` when it's set (on Linux only an absolute path counts), else `absolute`, else `home` under the home dir. `registry`: under each of `hives`, every subkey of each `startMenuInternet` key, with its `openCommand` default value, and the default value of `appPaths\<name>` for each of `appPathNames`.

## Protected origins

Browser control must never navigate to, open or attach to a target on seven's own origin, or read or write its cookies or storage: not slicc-cli's `cdp` relay, not slicc-cdp's `playwright-cli`, not slicc-agent. `protectedOrigins` in `catalog.json` says what is protected, and every implementation runs the vectors in `protected.json`.

**URLs.** A URL is parsed the way the WHATWG URL Standard (and so the browser) parses it, so `https:\\seven.sliccy.ai`, a tab or newline inside the URL, `%2E`, `。` and full-width letters all reach seven. In Go and Rust that takes a WHATWG parser, not `net/url`. A URL the guard’s WHATWG parser cannot parse is **protected** wherever the guard judges a URL the browser will load or has loaded: `unparseable: "protected"` in both `catalog.json.protectedOrigins` and `protected.json`. Chrome’s parser is not interchangeable with the guard’s parser; in particular it can load `http://exa%20mple.sliccy.ai/` even though the WHATWG parser rejects the decoded space. Then:
1. While its scheme is one of `innerSchemes`, the rest of the URL after `<scheme>:` takes its place, at most 8 times: `blob:https://seven.sliccy.ai/<uuid>` is `https://seven.sliccy.ai/<uuid>`. A failing inner parse, or a URL still wrapped after the eighth unwrap, is unparseable and protected.
2. A scheme in `anySchemes` is protected whatever follows: a DevTools front end (`devtools://`) can be inspecting seven.
3. A scheme in `protectedSchemes` is protected like seven, whatever follows, except the `scheme://host` pairs in `schemeExceptions` (the new tab pages), on any path. Match the parsed scheme and exact host, never a raw URL prefix: `chrome-untrusted://new-tab-page/one-google-bar?paramsencoded=` is excepted, but `chrome-untrusted://new-tab-page.evil/` and `chrome-untrusted://other/` remain protected. Chrome's new tab embeds the excepted untrusted host, and `chrome://new-tab-page/` can commit as itself when opened directly:
   - Chrome's privileged UI (`chrome://settings`, `chrome://password-manager`, `chrome-untrusted://…`, `devtools://`) and the same UI in the catalog's other Chromium browsers (`edge://settings/passwords`, `edge://wallet`, `brave://`, `opera://`, `vivaldi://`, `arc://`), since a client attaches to whatever browser answers;
   - `chrome-extension://`, every page, frame and extension target of every type: password-manager and wallet extensions keep secrets there. There are no default exceptions. Seven's own extension origin is already covered as a seven origin. If a guard ever needs an exception, it is a catalog entry by extension id with a reason, never a default;
   - `file://`: otherwise a tool could open `~/.ssh` or `~/.aws/credentials` in the real browser, around slicc's file-system fence. Adopters whose tests open local HTML through the guarded client move those fixtures to a local http server.

   An `about:` URL other than `inheriting` is first rewritten the way Chromium rewrites it, to `aboutScheme://<path>`: `about:settings` is `chrome://settings` and protected, `about:newtab` is `chrome://newtab`, and `about:blank` stays unprotected. A wrapper is judged by what it wraps (rule 1): `view-source:chrome://settings/` and `view-source:file:///…` are protected, and `blob:` and `filesystem:` URLs by their creator's origin.
4. A scheme in `schemes` is protected when its host is one of `hosts`, or one of `domains` or under one, at any depth and on any port. The host is lower-cased, and one trailing dot is dropped.
5. Any other URL is protected when its origin is one of the program's **extra origins**: the seven origins it accepts besides `sliccy.ai` (slicc-cli's `--origin` and `--page` origins), compared as `scheme://host[:port]` without the scheme's default port, with the host as in 3.

This is wider than the rule for finding seven (`seven.originHostPattern`, which leaves out the `excludedLabels` and `excludedLabelPrefixes`—`www`, `vault`, `vault-preview`, `get`, `mcpcat`, `echo`, and any `vault-*` prefix). Every `sliccy.ai` host shares the `sliccy.ai` cookies, and cookies ignore the port and, without `Secure`, the scheme. SLICC six lives on `www.sliccy.ai` and the apex, and its cookies matter. `*.kernel.localhost` is not protected: each port is its own origin, and the agent's own servers live there. An extra origin is matched exactly, so `http://127.0.0.1:5710` doesn't protect `http://127.0.0.1:5711`.

**Chromium scheme audit.** Checked [content scheme registration](https://github.com/chromium/chromium/blob/d0bfaae35fa745d9dee525dc4ff6617b1551dbe7/content/common/url_schemes.cc) and [Chrome additional schemes](https://github.com/chromium/chromium/blob/d0bfaae35fa745d9dee525dc4ff6617b1551dbe7/chrome/common/chrome_content_client.cc), including platform-specific registrations:

| Scheme | Decision and reason |
| --- | --- |
| `chrome` | Protected: browser WebUI, with only the catalog's exact new-tab host exceptions. |
| `chrome-untrusted` | Protected: browser-owned isolated UI resources, except the exact `new-tab-page` host. |
| `chrome-search` | Protected: Instant/search-provider UI and profile resources, including `local-ntp`, `most-visited` and `remote-ntp`; hiding targets is not refusal. |
| `chrome-native` | Protected: browser UI rendered by platform-native widgets instead of HTML. |
| `chrome-distiller` | Protected: browser-generated reader-mode documents, which may contain content distilled from a protected document. |
| `chrome-error` | Not scheme-wide protected: generic network-error documents hold no protected document content; ordinary errors must remain readable and recoverable. |
| `isolated-app` | Protected: installed isolated web apps have app-specific storage and privileged capabilities outside ordinary web origins. |
| `devtools` | Protected already: a DevTools front end can inspect a protected target. |
| `chrome-extension` | Protected already: extension documents and workers can contain credentials and browser privileges. |
| `chrome-experimental-site-token-provider` | Protected: an internal data source issues site-specific tokens. |
| `externalfile` | Protected: ChromeOS local/external file access must not bypass the `file` fence. |
| `file` | Protected already: local files must not bypass the agent's file-system fence. |
| `content` | Protected: Android local content-provider access must not bypass the `file` fence. |
| `android-app` | Not scheme-wide protected: Android app/referrer identity, not a browser UI document; extra-origin rules still apply. |
| `googlechrome` | Not scheme-wide protected: an external launch alias, not registered as a privileged document scheme by these entry points. |
| `view-source`, `blob`, `filesystem` | Not blindly scheme-wide protected: existing recursive inner-origin rules protect what they wrap. |
| `about` | Not blindly scheme-wide protected: existing Chromium alias rewriting protects UI while retaining inheriting blank/srcdoc URLs. |
| `http`, `https`, `data`, `javascript`, `ws`, `wss`, `mailto`, `webcal` | Not scheme-wide protected: ordinary web, inline content, transport or external handlers, not privileged browser UI. |

A guard must refuse navigation, creation and attach on protected schemes, including protected frames of an otherwise ordinary tab, rather than merely hiding them from discovery. `chrome-error` is deliberately not a protected scheme: ordinary DNS, connection and certificate failures produce that same generic document, so scheme-wide refusal would prevent reattaching to an ordinary error tab. Error pages hold no secrets from the failed document. This does not permit opening or attaching to a protected origin: guards still fail protected navigations before commit and enforce protected-target provenance; C1–C5 observer-only `unreachableUrl`, history and network block evidence is unchanged.

**New-tab checks (1.8.2).** In fresh default profiles on macOS, Chrome for Testing 156.0.8078.4 (Playwright build 1248) and Chrome 155.0.8059.82 commit `chrome://newtab/` to `chrome://new-tab-page/` and embed `chrome-untrusted://new-tab-page/one-google-bar?paramsencoded=` as an out-of-process frame. Direct `chrome://new-tab-page/` also commits as itself. Edge 155.0.4283.60 commits `edge://newtab/` to `https://ntp.msn.com/edge/ntp` with an `about:blank` child and no internal-scheme child observed; directly opening `edge://ntp/` returns `ERR_INVALID_URL`. These observations are for fresh default profiles, not every browser configuration. Brave, Opera and Vivaldi were not installed locally, and this repository's CI installs only Chromium, so their redirects and internal frames were not verified and no additional exceptions are inferred. Incognito Chrome and Edge new tabs omit the ordinary new tab's frame tree; the reachability vector therefore uses the default context.

**Protected-URL error pages.** `errorPage` in both the catalog and `protected.json` retains the previous target decision; it never locks an allowed target or unlocks an already-protected target. The exemption requires the last main-frame different-document commit to be `chrome-error://chromewebdata/`, with opaque `securityOrigin` (`://`), and `unreachableUrl` exactly equal to the reported `TargetInfo.url`, with no main-frame navigation in flight. A URL mismatch, unavailable commit evidence or an in-flight navigation does not qualify; guards fail closed while their state is unknown. `protected.mjs.target` takes validated `documentURL`, `unreachableURL` and `navigating` evidence in addition to `previous`; callers must track commits and readiness, rather than trust `TargetInfo.url` alone. Browser UI target types remain protected. Read-only discovery still redacts the URL **and title** to the protected origin in `getTargets`, `getTargetInfo`, `targetCreated`, `targetInfoChanged` and `attachedToTarget`, including held sessions released later. Path, query and fragment secrets must never survive in those fields. Navigation destinations remain protected: the exception permits recovery, not a protected `Page.navigate` destination.

Main-frame loaders start at `Page.frameStartedNavigating`, excluding `sameDocument` and `historySameDocument`, and end on the corresponding commit, `Network.loadingFailed` with matching requestId, or main-frame `Page.frameStoppedLoading`. A different-document commit clears older loaders; `BackForwardCacheRestore` clears the entire set, even though it reuses the restored document’s old loaderId. A guard that is not ready, cannot parse parameters, or has more than 64 loaders in flight must fail closed. BFCache can report the protected TargetInfo before its restore commit, so waiting for `frameNavigated` alone is not sufficient.

**Privileged-scheme follow-up checks.** With the expanded catalog, fresh default-profile Chrome for Testing 156.0.8078.4 on macOS again committed both NTP entry points to `chrome://new-tab-page/`, with an `about:blank` background child and only `chrome-untrusted://new-tab-page/one-google-bar?paramsencoded=` as its internal-scheme OOPIF. `C8.newtab` passed both attach and ordinary-navigation legs; no `chrome-search` exceptions are added or inferred for other profile/search-provider configurations. Direct `Page.navigate` to `chrome-search://most-visited/` returned `net::ERR_INVALID_URL` and committed `chrome-error://chromewebdata/` with that exact `unreachableUrl`, confirming why `C8.chrome-search` distinguishes a browser response from a guard refusal rather than requiring a successful search-document commit. The catalog-adopting emulator passed every C8 protection row; plain clients failed them, and removing only `chrome-search` from the adopted catalog failed the new row. C1.href, C2.302, C3.popup-self-nav, all tested C4 iframe process layouts and C5.document passed their guarded and control legs with the expanded schemes; plain clients passed controls and failed protection expectations. Those HTTP fixtures deliberately protect only the seven host, leaving their same-site control host ordinary, while adopting every internal-scheme rule unchanged.

**Unparseable URL boundaries.** Fail closed on command destinations: navigation and target creation, the URL and `userTypedURL` of a selected history entry, `Fetch.continueRequest` and legacy interception overrides, `Network.loadNetworkResource`, PWA install/launch, and cookie-command URLs when no domain is supplied. Also fail closed on security-relevant Chrome-reported URLs: targets, main-frame `securityOrigin`, execution-context origins, requests/redirect responses, web sockets and web transports, and service-worker scopes/scripts. A protected default execution context still cuts its session; a protected foreign isolated world stays hidden. This is not a rule to reject arbitrary strings a guard merely reads: storage-command origin keys, storage keys/cache ids, script/stack URLs, generic value redaction and storage events retain the old not-protected result for a parse failure. Cookie domains remain suffix matches, so `exa%20mple.sliccy.ai` is already covered.

The empty string is exempt (`Target.createTarget`’s blank page, an empty history `userTypedURL`, or no override); opaque-origin spellings `null` and `://` are exempt too. `about:blank` still inherits provenance, so those exemptions never erase an already protected opener or target. A failing `about:` alias is judged as the original `about:` URL, not as a parse failure. `unparseableRefusal` is exactly `slicc: refused: slicc can't parse this URL, so it could be a protected page`; a URL the guard can parse and finds protected uses its ordinary refusal instead. IDNA validation differs between WHATWG implementations: Node accepts some punycode spellings that the Go parser rejects; the canonical `.sliccy.ai` spellings remain protected by the domain rule either way.

The deliberate cost includes otherwise ordinary `http://<U+200D>.example/` and `https://exa mple.com/`: an unparseable URL is not an ordinary-origin allowlist exception. The vectors include space/percent-space, U+200D/punycode and invalid-punycode `.sliccy.ai` forms; malformed hosts, ports and IPv6; failed wrappers and unwrap-limit exhaustion; and the explicit exemptions and read-only storage-key controls.

**The vault.** `vault.sliccy.ai` is in `hosts` by name, and vault branch previews (`vault-preview.sliccy.ai`, `vault-*.sliccy.ai`) are covered by the `sliccy.ai` domain rule. `sliccy.ai` already covers them all, but vault must stay protected even if `domains` ever changes: the vault must never be a CDP target for agent tools. The one exception is slicc-cli's own pairing attach for the vault, which is the CLI's own connection and not browser control handed to the agent.

**Targets.** A target whose `TargetInfo.type` is one of `targetTypes` (`browser_ui`, Chrome's own UI such as `chrome://omnibox-popup.top-chrome/`) is always protected, whatever its URL. Otherwise a target's effective origin is its URL's (`TargetInfo.url`), except when the URL inherits the origin of whoever made the document: the empty URL, and `inheriting` with any query or fragment. Such a target is protected when it was protected before this URL (a seven tab that went to `about:blank` keeps seven's origin), or when its opener (`openerId`, else `openerFrameId`) is protected or unknown, for an opener closed before the program saw it. The URL, `openerFrameId` and `browserContextId` alone can't tell: a blank popup that seven opens has seven's origin and the URL `about:blank`. A program that holds a session to the target also has the document's real origin: the main frame's `securityOrigin` in `Page.frameNavigated`, and the default context's `origin` in `Runtime.executionContextCreated`. When one of those is protected, the target is protected too, until a URL with an origin of its own replaces it.

A same-site frame shares its parent's process and has no target of its own. Every `sliccy.ai` host is protected, and site isolation gives a seven frame inside any other site its own target, so this only matters for an extra origin whose site has other origins (another port of `127.0.0.1`, say).

**Cookies.** A cookie domain, lower-cased and without a leading or trailing dot, is protected when it is one of `domains` or under one, or when it is one of `hosts`, the host of a protected domain or an extra origin, or a parent of one: a cookie on `.example.test` reaches `https://seven.example.test`.

**Storage keys** (`Storage`, `IndexedDB`, `CacheStorage` and `FileSystem` in CDP): a key is protected when its origin (up to the first `^`) or its top-level site (a part after `^0`) is a protected URL.

**Redirect secrets.** An allowed response can name a protected destination without becoming a protected document itself. Every protected URL in a nested delivered string or object key is redacted in place to its origin, including embedded `Location`, `Content-Location`, `Refresh` and `Link` values, raw `headersText` lines, `redirectResponse`, Page URL/history/error fields, console/exception text and Audits issues. Percent-encoded representations must not retain the tail. A separate `urlFragment` alongside a protected `url` is cleared too. The event remains delivered so Network ExtraInfo pairing survives; dropping an ExtraInfo event fails these vectors. A request whose response names a protected URL has its response body refused (`slicc: refused:`), through both Fetch and Network, even though the request started at an ordinary URL. Body reads, replay and URL overrides must not follow an ordinary redirect into protected content or send its cookies. Ordinary redirect headers and bodies stay readable.

**Refusals** carry the text in `refusal`, `slicc: refused: target is on seven's origin`.

**`protected.json`** (schema `schema/protected.schema.json`): `errorPage` (the committed-error previous-decision and origin-redaction rule), `unparseable` (`protected`) and `unparseableRefusal`, in step with the catalog; `origins`, the extra origins every vector runs with; `urls` (`url`, `protected`); `targets` (`url`, `documentURL?` and `unreachableURL?` for validated main-frame error-commit evidence, `navigating?` for a main-frame navigation in flight; `type?`, the target's `TargetInfo.type`; `previous?`, whether the target was protected before; `opener?`, `protected`, `unprotected` or `unknown`, and no `opener` for a target without one; `protected`); `cookieDomains` (`domain`, `protected`); `storageKeys` (`key`, `protected`). `npm run validate` runs every vector through `protected.mjs`, and no vector uses a port from 9222 to 9229.

## Guard vectors

Every CDP guard runs the vectors in `guard-vectors.json` (schema `schema/guard-vectors.schema.json`): bios, slicc-cdp, slicc-extension and slicc-cli. The sources are listed in `sources`:
- slicc-cli's `protectVectors` at `2d5d981` (`test/integration/testdata/link/protect.js`), with the ids kept, and at `fe33052` for `C3.redirect-popup-stays-out` and `C3.direct-popup-stays-out`: a popup opened straight onto, or through a redirect chain to, a protected origin never reaches the client, not at open and not after the page later navigates itself and auto-attach runs again;
- slicc-cdp's `test/integration/guard-vectors.json` at `4907a45`, where its `E1`, `E2`, `E3`, `E5` and `B2` are renamed `E1.onload`, `E2.binding`, `E3.bypass-csp`, `E5.console` and `B2.headers`;
- the cert lane's E and B rows;
- `C5.continue-request` and `C5.continue-response`, added next to `C5.document`;
- the `C8` rows for privileged pages: `C8.navigate` (a page navigates to `chrome://settings`, `chrome://password-manager`, an extension page or `file:///`; refused), `C8.view-source` (the same through `view-source:`; refused), `C8.create` (`Target.createTarget` straight on those pages; refused), `C8.browser-ui-listed` (`Target.getTargets` lists no `browser_ui` target) and `C8.browser-ui-attach` (`Target.attachToTarget` by a `browser_ui` target's id; refused). All five have an unguarded control, since the guard refuses them only on the privileged target. Two cases aren't rows, because Chrome itself blocks them, so an unguarded client can't tell a guard from none: a page's `window.open('chrome://settings')`, and an `about:` alias such as `about:settings`, which `Page.navigate` and `Target.createTarget` both turn into `about:blank#blocked`. The `about:` aliases are in `protected.json` instead.
- slicc-cdp's owner vectors in `test/integration/guard-native.test.mjs` at `d85ac3c`: `C5.script`, a protected script subresource under the client's own `Fetch.enable` `*` at both stages (the guard neither pauses it for the client nor lets the client fulfil it, and the page runs the stand-in's real `/script`, while the control's paused request carries its headers as an object with `User-Agent` and runs the forged script), and `X1.after-exit`, the client lifecycle row below.

`X1.after-exit` (family `X`, client lifecycle) needs `clientExit`. Through the guard, the client opens an ordinary tab, registers `Page.addScriptToEvaluateOnNewDocument` with `{beacon}`, `Network.setExtraHTTPHeaders` with `x-probe: {tag}` and `Fetch.enable` `*` with a rule that fulfils the destination with a forged `FULFILLED` page, then loads the `/page?k=href&tag={tag}&to={target}/canary/{tag}` trigger whose `go()` navigates to `{target}/canary/{tag}`. Before the exit it must see its init-script beacon, its header on the trigger request and the trigger's `Fetch.requestPaused`, matched up to `&to=`, so a guard that redacts the embedded protected URL to its origin still matches: those are the positive evidence on both legs. Then the client exits, the unguarded observer calls `go()`, and the destination must be served and read as the real `canary` document, with no beacon from `{target}`, no `x-probe` on its request, no forged body and no `Fetch.requestPaused` for it reaching the client: nothing the client registered may outlive it. The control runs the same on `{plain}` through the guard, and expects the same, since an ordinary navigation after the exit must be just as clean. A guard that keeps its upstream session, or its own init scripts, headers or interception, past the client's exit fails the row.

`C4.iframe-preattach.blank` and `C4.iframe-preattach.srcdoc` read a protected frame's same-process child that committed before the client attached. The unguarded observer opens `<from>/framed` around `{target}/nest?n=<tag>&kind=blank` or `kind=srcdoc`: the protected frame holds an `about:blank` child that it fills, or an `about:srcdoc` child, each named `frame-marker-<tag>` and showing that marker, and then moves itself with `history.replaceState` to `/nest/path-secret-<tag>?query-secret=<tag>#fragment-secret-<tag>`. `from` is `{ordinary-same-site}` on the guarded leg, so both frames share the page's process under site isolation, and `{plain}` on the control. The `.shared` rows open the page from `{ordinary}` on both legs and require `siteIsolationOff`; a transport without it reports them as `skip` with `not-supported:siteIsolationOff`. The observer must find the child in the page's own frame tree and pierced document, and must see the marker or the secret through every read. Then the client attaches to the settled page and makes the same reads: `Page.getFrameTree`, `Accessibility.getFullAXTree` with the protected frame's and the child's `frameId`, `Accessibility.getPartialAXTree` of the marker element's `backendNodeId` with `fetchRelatives`, `DOM.getDocument` with `depth: -1` and `pierce: true`, `DOM.describeNode` of the child's document and `DOM.getOuterHTML` of the marker element, and `DOMSnapshot.captureSnapshot`. Each `<read>Shown` holds when a reply carries the marker or the secret path, query or fragment, and `eventsShown` when an event on the client's session does. The guarded leg expects all of them false: a refusal, an error or origin-only data passes, and a refused attach refuses every read. The control runs unguarded and expects every read to show the content. Missing evidence is `incomplete`, with `frame-read: <reason>`: no same-process child within 5000 ms (scaled by `settleScale`), an observer read that doesn't show the content (that field reads `incomplete`), a client read or attach that was never answered (an error that says `timed out` or `closed`), or a control attach without a session.

The `C9` foreign extension isolated-world family requires `extensionWorld`: a browser hosting a foreign content-script extension on the ordinary fixture page. `C9.world-hidden` requires the page default context to remain visible after `Runtime.enable`, while the extension context and Runtime/Debugger identifiers remain hidden without cutting or detaching the session. `C9.world-select` probes numeric and unique context selectors, object and argument handles, promises, properties, named bindings and DOM node resolution; each command selecting the hidden world must fail with the `slicc: refused:` prefix, never an ordinary browser error. Numeric guesses also sweep ids 1–32: an id not exposed to this client must be refused, while every exposed numeric context must remain usable; none of those guarded probes may reach the fixture content-script marker. The marker combines the content script’s global lexical `root` binding with its extension-id DOM marker and `chrome.runtime.id`, and is independently required to be absent from the page default world. `C9.world-debugger` pauses inside that content script: the control must reach its frame, while the guard must refuse or hide it. The control waits up to 5000 ms (scaled by `settleScale`) for `Debugger.paused`; when it never pauses, `reachable` records `"incomplete"`, not `false`, and the row fails with `extensionWorld debugger: no Debugger.paused within <ms>ms`. The guarded leg waits up to 1500 ms, scaled by `refusalScale`. `C9.page-drivable` evaluates `self.origin`, captures a DOM snapshot and dispatches an Input click on the same ordinary page; cutting the entire session fails this regression row. All four use an unguarded control, the default browser context and observer discovery of the real extension world, not an invented isolated world. Protected default contexts remain session-cutting evidence; hiding a foreign isolated world does not weaken any seven-origin row.

The integration launcher loads shared-web 1.25.2’s harness extension exactly once through `Extensions.loadUnpacked` (`ankmbodmgimjemnojmeddfcdlbocolob`), whose content script runs on HTTP(S) pages. shared-web 1.25.2 also loads it by default in its own harness. A transport unable to host a foreign content-script extension omits `extensionWorld` and reports `not-supported:extensionWorld`; an advertised capability with no observed world fails, rather than silently skipping.

`C2.redirect-secret` probes ordinary fixture 302s to seven’s `/auth/callback?code=…&state=…` and vault’s `/oauth/mcp-callback?code=…`, plus `#access_token=…` variants of both. It navigates with Page and scripted `location.href`, fetches a subresource and sends an XHR. After each one it waits, at least 250 ms and up to two seconds scaled by `settleScale` (stall-tolerant), for the fixture to log the redirect URL and every request seen for it to end, before it navigates away. On the guarded leg, once one action's wait times out, the remaining actions skip it, so a guard that never terminates costs that bound once per leg. The 302 carries `Location`, `Content-Location`, `Refresh: 0;url=…` and `Link: <…>; rel=preconnect`. Page, Network (including ExtraInfo), Runtime, Log, Audits and both Fetch stages are enabled. Every received raw message is scanned, including replies but not the probe’s own observer session traffic, across an eight-second tail, for raw, percent-encoded, JSON-escaped and base64 marker representations. Both response-body APIs are attempted on each hop; guarded bodies need matched refusals. `Network.getResponseBody` is attempted, once per id, with every network id the client learns for a 301–308 hop: the `requestId` of a Network event carrying the redirect status and the `networkId` of the Fetch response-stage pause. For each registered hop whose id the client learned neither way, the probe reads the hop’s real id from the harness’s own unguarded tap (the observer session, which enables Network on the guarded leg) and attempts the read on the guarded session with it. The evidence’s `networkBodyCarriers` counts the ids per carrier, and `networkBodyPath` names the weakest carrier any id needed: `withheld+tap`, then `fetch-networkId`, then `network`, or `none` without any id. These reads never hold up a Fetch pause, and the probe gives them five seconds after `Fetch.disable` to settle, and again after the terminal wait for reads that late events started. A read still unanswered then is not a refusal. `networkBodyAttempted` and `networkBodyRefused` hold only when every attempt is refused. On the guarded leg a `fetch-networkId` or `withheld+tap` carrier also needs the same row’s unguarded control to have seen the redirect’s Network events. Without that proof, or with no id at all, both read `incomplete` and the probe returns `redirect-secret: network body leg <reason>`; an attempt that is not refused is measured and fails. Every request the client sees for a registered redirect URL, through its initial `Network.requestWillBeSent` or a redirect `requestWillBeSent` whose `redirectResponse.url` is that URL, must end within the step in a redirect `requestWillBeSent`, `loadingFinished` or `loadingFailed` for that `requestId`. Before the evidence is evaluated, on every leg, the probe waits up to five seconds scaled by `settleScale` (stall-tolerant) for every seen request to reach one of those events. The evidence’s `hops` records per `requestId` the `delivery` (`redacted` for an origin-only protected redirect in place, `withheld` for a terminal without the redirect, `ordinary`, `raw` or `unterminated`) and the `terminal` event method. On the guarded leg `requestsTerminated` is false on any `unterminated` request after that wait, a measured guard failure rather than missing evidence; on the unguarded control an `unterminated` request is missing evidence, so `requestsTerminated` reads `incomplete` and the probe returns `redirect-secret: control requests <ids> unterminated`; `hopsRedacted` is false on any `raw` or `ordinary` hop, so a delivered protected hop must be origin-only, never the raw or a substituted URL; the guarded leg expects it. Page frame trees, resource trees and navigation history are read before recovery to catch error-page leftovers. A separate structural check requires every protected `Network.Request.urlFragment` and `Page.Frame.urlFragment` to be empty or absent, even if its value contains no marker; the ordinary `#access_token` control independently requires fragment evidence in request events, frame events, frame-tree replies and resource-tree replies. The ordinary session must survive. The unguarded ordinary redirect control preserves all four headers in `redirectResponse`, ExtraInfo’s headers and `headersText`, and Fetch’s response headers. `C2.redirect-secret-mix` repeats that matrix with 301/303/307/308. The protected leg requires in-place ExtraInfo delivery with origin-only header values, not merely the absence of a marker.

`C2.redirect-body` calls `Network.loadNetworkResource` on an ordinary redirect with `includeCredentials: true`, reads any stream with `IO.read`, replays a redirected XHR, requests Page resource content, and captures Page/MHTML and DOM snapshots after a main-frame redirect. It also captures an ordinary parent containing an iframe redirected to vault, including its error document, and overrides a paused ordinary Fetch request to the allowed redirect URL. No protected marker may appear in any message or body, and no request from those operations may send the independently seeded seven cookie. The ordinary control must return the body, resource content and snapshots, and accept the URL override. Its network-body carrier, `networkBodyAttempted`, `networkBodyRefused`, `hops`, `requestsTerminated` and `hopsRedacted` follow `C2.redirect-secret`. Each probe cleans up its redirect registrations, observer session and cookie. The focused Chrome tests use HTTPS with SPKI-pinned fixture trust and default-port protected URLs; host resolver rules route seven and vault to the fixture rather than the public service.

Every C2 redirect probe reports `sessionEnded`. It becomes true when the guarded client’s session ends during the probe: a `Target.detachedFromTarget` for that session, or a CDP reply that the session is closed or not found, or that the target, websocket or transport is closed. `Inspected target navigated or closed` is an ordinary reply on a live session, not a session end. When an expected Fetch pause or XHR event is missing, the probe sends one `Runtime.evaluate` to check that the session is still alive. Once the session has ended, the probe sends nothing more on it, skips the eight-second tail and the termination wait, and evaluates what the client received before the end. `secretHidden`, `protectedBodyHidden`, `cookieHidden`, `fragmentsHidden` and `hopsRedacted` are measured on those messages, replies, bodies and fixture logs, so a guard that leaked before the end still fails them. A clean end passes them. `sessionSurvives` reads false. Checks that need evidence from after the end read `incomplete`, with `redirect-secret: session ended (<how>)` in the probe’s `incomplete`. If the end cuts the probe’s action matrix short, or leaves any body read pending or unanswered, then `fetchBodyAttempted`, `fetchBodyRefused` and the network-body leg read `incomplete`, even after some refused reads. Any answer that isn’t a refusal still fails its refusal check. `requestsTerminated` reads `incomplete` when requests are unterminated or the matrix was cut short. A short but origin-only `extraLocation` reads `incomplete`. So does each attempt or override check whose command never reached the client: it wasn’t sent because the session had already ended, or its reply was the session end. On the unguarded control, a session end is an error: the probe throws `redirect-secret: control session ended (<how>)`.

`C8.unparseable` probes both raw and canonical space/U+200D/invalid-punycode URLs through creation and navigation. Every guarded destination needs a matched refusal. Its unguarded controls record `document` or `native-rejection` outcomes, including Chrome builds that reject raw U+200D instead of committing it. Both raw and encoded-space forms must commit real fixture documents, because that is the proven cookie leak. An independent observer loads the encoded-space document and confirms it shares a uniquely seeded `.sliccy.ai` cookie; the guarded client must neither list nor attach to it, read its cookie, query that cookie by URL, nor cause a cookie-bearing destination request. The guard does not erase the observer’s private browser state. The row runs on both browser-session and page-session-only transports, uses the default context, and cleans up its own targets and cookie. Cookie seeding always uses the unguarded observer’s browser session, never the guarded client. Only guarded browser-session target listing requires `browserSession`; without it, `listed` records `not-supported` explicitly in probe and observation evidence, and the result lists that field in `notSupported`. Creation, navigation, attachment and `Network.getCookies` with `urls` still require matched refusals; filtering cookies without refusing fails `cookieRefused`. Fixture URLs omit the colon when the port is empty, and reported URLs are compared after canonicalisation, including Chrome’s WHATWG-unparseable encoded-space hosts. Launchers must resolve the raw/canonical space, U+200D/punycode and invalid-punycode `.sliccy.ai` fixture hosts to the fixture server, including for default-port HTTP or HTTPS origins. The HTTP fixture accepts Chrome’s encoded-space Host header without reparsing it as a WHATWG origin.

`C8.chrome-search` requests `chrome-search://most-visited/` through `Page.navigate` and requires an explicit guard refusal. Its unguarded control requires a CDP response, not a successful document commit: Chrome can answer with `errorText` when that internal data source is unavailable outside an Instant process. Browser-side load failure is not a guard refusal, and merely hiding the target must fail this row.

The `C8.newtab` reachability control attaches through the guard to a settled ordinary new tab, including its internal frames, then navigates that same tab to an ordinary document. Both legs must succeed, including without a guard. It requires `chromeUrlsAttach`, so an extension transport reports it as `skip` with `not-supported:chromeUrlsAttach`. The C8 protection rows expect a refusal on the guarded leg and run their controls unguarded, so they don't require it and still run on extension transports. It uses the default browser context, since an incognito new tab omits the ordinary new tab's internal frames. It covers `chrome://newtab/` and directly opened `chrome://new-tab-page/`.

`C8.protected-bfcache-restore` and `.history` test history restoration on seven and vault, with both detach variants. The independent observer seeds ordinary A, protected P and ordinary B on one tab. `/bfcache?n=<tag>` has no unload handler: it retains a global and sessionStorage marker, records `pageshow.persisted` and counts key events. The guarded client must answer on B before the gate is armed. The first row restores P with the observer's `Page.navigateToHistoryEntry`; `.history` sends that navigation through the client instead. A matched client navigation refusal lets the observer restore the same entry. The unguarded control must observe a real `BackForwardCacheRestore`, persisted pageshow, the marker and protected origin in evaluate, a touched global, and positive evidence from every probe method.

The rows require `inboundDelay`. The guarded client supplies `inboundDelay({ targetId, sessionId, ms, side, client, gate: true })`, a harness gate before the guard's inbound stream. It holds every browser-to-guard message until explicit release; guard-to-browser writes remain possible. The control gates only its unguarded client stream, not the independent observer session. Immediately before restoration the runner requests a gate with a 1500 ms minimum hold. The hook returns `{ targetId, sessionId, ms, gate: true, protectedObserved, ordinaryObserved, release, audit? }`. Both observed flags acknowledge delivery of the protected seed and subsequent ordinary B through the relevant stream before injection. `release()` restores delivery and returns `{ delayedEvents, firstDelayedAt, releasedAt }`, counting held restore events and recording their first hold and actual release times. Missing capability or hook is `not-supported:inboundDelay`; an unacknowledged gate, absent seed acknowledgement or no held restore event is `incomplete`. A timer-only event delay does not meet this contract.

After the observer confirms the persisted protected document, the client repeatedly probes `Runtime.evaluate`, `Runtime.callFunctionOn`, `DOM.getDocument`, `Accessibility.getFullAXTree`, `Input.dispatchKeyEvent`, `Page.captureScreenshot` and `IO.read` for 2500 ms while the gate stays closed. Runtime probes write `__touched`; Input is measured by the fixture's key counter. The observer supplies a real network-resource stream for IO's positive control: the read must use that handle and show the document marker, including base64-encoded bodies. Screenshot controls must return PNG bytes captured while P is current that match the independent observer's capture of P; unrelated or merely nonempty data is not evidence. The guard must hide the marker from all received messages and events and hide the protected origin from every probe reply, not only Runtime replies, and leave both side effects absent on P. A returned screenshot while P is current fails, regardless of its encoded contents. Refused, answered and unanswered outcomes are retained individually; an unanswered call alone never proves protection. The observer measures P's marker, persisted state and side effects before and after release. Missing restore, fixture, hold or side-effect evidence is `incomplete`, even when every measured observation matches; measured leaks or side effects fail even beside missing evidence. After release the runner drains probe replies for up to 5000 ms, scaled by `settleScale`, before scanning them and judging screenshots. An unresolved reply needs a complete final forwarding ledger proving terminal non-forwarding; otherwise its missing measurement is `incomplete`. A measured failure takes precedence over incomplete evidence.

`forwardAudit` gates only `commandsUnforwarded`. When advertised, `audit({ probes, final })` must return `{ complete: true, probes: [{ id, forwarded }] }` with a browser-side forwarding decision for every probe id; any probe sent while the gate is armed that was forwarded fails, even when its frame state was unknown. The gate-window audit runs before release. The final audit runs after reply settlement and certifies terminal forwarding decisions, including commands queued at release; its ledger must remain available after `release()`. An observed forward fails even beside a partial ledger. Guard-generated internal calls and the history trigger are not probe calls. A missing or partial ledger is `incomplete`. Without the capability the audit is `not-supported`, and the independent side-effect, leak and screenshot checks remain required. Each row's `evidence.control.restore` and `evidence.guarded.restore` retains gate acknowledgement/release, the restore timestamp, every probe's send time and outcome, forwarding evidence when available, and the independent side-effect reads. Cleanup releases the gate and closes only that row's targets, streams and sessions.

`C8.protected-error-page` touches an allowed tab, scripts a protected navigation, and requires the guard to fail its Document request. The independent observer verifies the committed error document and the exact unreachable/reported URL pair. The session stays attached; reload, navigation to `about:blank` and close succeed, while `Target.getTargetInfo`, `Target.getTargets`, the `Target.attachedToTarget` of a fresh attach and the `targetCreated`/`targetInfoChanged` events redact URL and title to the origin (`infoRedacted`, `listRedacted`, `attachRedacted`, `eventsRedacted`), and none of them shows the full failed URL (`fullURL`). The failed URL carries a secret path, `?query` and `#fragment`; the `.query` and `.fragment` variants of this row and of `C8.protected-error-page-sticky` fail `/doc?query-secret=…` and `/doc#fragment-secret-…` instead, so no path, query or fragment secret may survive alone either. The unguarded control uses independent Fetch failure injection and keeps raw discovery values: its `fullURL` must be `true`. `C8.protected-document-restore` seeds a real protected document before attachment, navigates away, then restores it from BFCache in the same tab after the error/recovery sequence; evaluate, attach and close must be refused. A real `BackForwardCacheRestore` commit is required, so a second failed network request cannot masquerade as this control. `C8.protected-error-page-sticky` additionally fails a request after that real protected restore and requires the already-protected tab to remain locked. They run on browser-session and page-session-only transports alike, have unguarded controls and clean up their own targets. The regression tests include URL-only locking, unconditional error-page unlocking, and a plain client with only request-failure injection.

`C8.network-error` and `C8.iframe-error` are ordinary-error reachability controls: request the configured `network-error` URL (default `http://nonexistent.invalid/`) directly or in an ordinary iframe, observe a failed Document request, reattach to the settled tab, evaluate and snapshot its document, then navigate the same tab to an ordinary document. Both control and guarded legs must pass. The failing URL is unchanged on the control, rather than replaced with a healthy origin, and the rows require `browserSession` but not `chromeUrlsAttach`. With Chrome for Testing 156.0.8078.4, scheme-wide `chrome-error` protection made the direct-error row fail both legs because reattachment was refused; removing it passed both rows, with readable DOM and successful recovery. The old emulator still allowed the cross-process iframe parent because the iframe TargetInfo kept the failing HTTP URL, but that layout-specific behavior is not grounds for protecting the error scheme. Plain-client controls and reachability legs also passed both rows.

`E4` and the `E6` rows are runnable, each with a guarded-through control on the ordinary origin that must show the effect. `E4` sets a `Debugger.setBreakpointByUrl` on line 0 of the `listener=1` document's `/listener.js?n=<tag>` with a condition that sends `{beacon}` and returns `false`; the control needs that beacon, and the guarded leg needs neither the beacon nor a `Debugger.paused` in the protected document. `E4.instrumentation` sets `Debugger.setInstrumentationBreakpoint` with `beforeScriptWithSourceMapExecution`, so only `/listener.js`, whose `SourceMap` header names a source map, pauses: `beforeScriptExecution` would also pause the runner's own `Runtime.evaluate` and any extension's content script first. `E4.event-listener` sets `DOMDebugger.setEventListenerBreakpoint` for `load`. Both set up before the trigger, need a `Debugger.paused` on the control (in `/listener.js`, or for `E4.event-listener` with `listener:load`, which only that document registers, since a listener pause reports no script URL), none on the guarded leg, and end with `Debugger.resume` and then `Debugger.disable` on the page session: Chrome doesn't answer `Debugger.disable` while the page sits in a pause, so a client that never times calls out would hang there. The resume can't hide a pause, since the `Debugger.paused` it ends was already seen, and every call in these rows must answer before the client's call timeout. The `E6` overrides are set on the page session before the trigger: `E6.headers` (`x-probe`), `E6.ua-network` and `E6.ua-emulation` (`User-Agent: slicc-probe-<tag>`) and `E6.cache-disabled` (`Pragma: no-cache`) are read from the stand-in's request log; `E6.network-conditions` (1500 ms latency) needs a navigation `duration` of at least 1000 ms, since Chrome delays the body rather than `responseStart`; `E6.locale` (`fr-CH`), `E6.timezone` (`Pacific/Chatham`) and `E6.network-state` (`navigator.onLine` false) are read by the unguarded observer in the destination document, and `E6.network-state` starts on `{cross}`, because Chrome drops that override on a same-site navigation once a second session is attached to the page. A guard that keeps its own session on the page, as the test emulator's Fetch shield does, can still lose it, and then fails that control rather than passing it; `E6.blocked-urls` has the observer fetch a blocked `/data` subresource there. Observer reads first check that the page is the exact destination URL, so a blocked or replaced document never shows the effect. The five overrides Chrome also applies inside a cross-site iframe have an `.iframe` row, triggered through `/framed`; `E6.network-conditions.iframe` reads the iframe's `duration` from the parent's resource timing. Each override is refusable at registration, with its observation depending on that refusal. These rows settle on the destination's load or request rather than on the detach variant, because each effect lands when the request is made or the script runs.

A client may register `Fetch.enable` patterns naming a protected origin in either of two conformant ways: the guard allows registration but never pauses or forwards protected requests to the client and refuses continue, fulfil or fail calls for request ids it did not hand out; or the guard refuses registration with its declared refusal text. Setup calls explicitly naming a protected placeholder are refusable with `refusal.onlyProtected: true`, and interception-dependent observations depend on that refusal. Wildcard and ordinary-only patterns do not receive this exemption. The ordinary-origin control still runs through the guard and must succeed.

**Top level.**
- `schemaVersion` (1): guards pin it.
- `setVersion`: the package version. The release flow stamps it into the npm package and the crate (`scripts/set-crate-version.mjs`). In git, and so in the Go module, it reads `0.0.0`; Go code gets the version from the module.
- `targets`: the names a runner maps to a scheme, host and port: `seven`, `vault`, `vault-x` (a vault branch preview), `apex`, `own` (the client page's origin, `{client}`), `ordinary`, `ordinary-same-site`, `chrome-newtab`, `chrome-new-tab-page`, `chrome-settings`, `chrome-passwords`, `chrome-search`, `network-error`, `chrome-extension-page` and `file-root`. Each has a `description` and, for the protected ones, a default `host`. `chrome-newtab` (`chrome://newtab/`), `chrome-new-tab-page` (`chrome://new-tab-page/`), `chrome-settings` (`chrome://settings/`), `chrome-passwords` (`chrome://password-manager/`), `chrome-search` (`chrome-search://most-visited/`), `network-error` (`http://nonexistent.invalid/`), `chrome-extension-page` (a page of Chrome's built-in PDF viewer extension) and `file-root` (`file:///`) carry a `url`, which the runner uses unless `targets` maps the name to something else. No other URL in the file is one a runner must use.
- `variants`: the detach variants in ms. `prompt` and `lagging` are documented; a runner may add others, such as `lagging-8s`, and reports the name it ran.
- `capabilities`: what a transport may lack. `autoAttach` covers `Target.setAutoAttach`, `children` steps and child sessions; `browserSession` covers calls on the browser session; `browserContexts` covers `Target.createBrowserContext` and `Target.disposeBrowserContext`; `extensionWorld` means it can host a foreign content-script extension isolated world on the ordinary fixture; `discovery` means session-less `Target.setDiscoverTargets` and `Target.targetCreated`/`Target.targetInfoChanged` delivery; `chromeUrlsAttach` means the transport can attach to and drive `chrome://` pages. CDP over a DevTools port can; `chrome.debugger` can't, since Chrome refuses it every `chrome://` page, even with `--extensions-on-chrome-urls`. `clientExit` means the harness can close the guarded client in the middle of a row: the client has `close()`, the `clientFactory` makes a fresh guarded client for the next leg, and an unguarded observer independent of the client outlives it. `siteIsolationOff` means the browser runs without site isolation, so a cross-site iframe shares its parent's process.
- `placeholders`: every `{name}` used in the vectors, with what it stands for. `{client}` is the client page's origin, which the runner maps.

**A vector** has:
- `id`, and `family` (`C`, `E`, `B` or `X`, the id's first letter);
- `kind`: `cdp` (runnable steps) or `text` (rows in words, which runners report as `not-run`, never `pass`);
- `scope`: `any`, or the one guard the vector is for;
- `setup` and `trigger`, both lists of steps;
- `targets`: the protected or reachability targets it runs against;
- `requires?`: the capabilities needed for the whole vector, including its steps' `requires`. Observation-only capabilities may be omitted here to keep independent legs runnable. A runner whose transport lacks one reports the vector as `skip` with the reason `not-supported:<capability>`. A row with a `page-or-browser` cookie step that would carry a `browserContextId` reports `not-supported:browserSession` without a browser session, because that parameter is only allowed on the browser target;
- `observe?`: each observed name, as `{ "means", "dependsOn"?, "requires"?, "eitherWhen"? }`. `requires` gates only that observation when it is not also a whole-vector requirement: unavailable evidence is recorded as `"not-supported"`, excluded from that field's expectations, and reported in the row's `notSupported` list. `dependsOn` lists the refusals the observation depends on (see Refusals). `eitherWhen` is a check: when it holds on the guarded leg, that observation's expectation becomes `"either"` there (see Design-dependent outcomes);
- `live`: the liveness check;
- `control` (`origin: "ordinary"`, `via`, `expected`) and `expected`: an object of names and booleans, or text;
- `skip?` (`target`, `reason`): `reason` starts with a code, as in `not-applicable: …`. A runner reports the row on `target` as `skip` with this `reason`, unless a capability is missing.

**Steps** are declarative and transport-neutral. Any step can take `on` (`control` or `guarded`), which runs it on that leg only.
Any `cdp`, `page` or `children` step can take `requires`, the capabilities it needs: `autoAttach` for `Target.setAutoAttach`, `children` and `session: "child"`, `browserSession` for `session: "browser"`, `browserContexts` for `Target.createBrowserContext` and `Target.disposeBrowserContext`, and `chromeUrlsAttach` for a step that must attach to a `chrome://` page to pass.
- `{ "cdp": method, "params"?, "session"?, "as"?, "refusable"?, "refusal"? }`: a CDP call. It runs on the page session by default, on the browser with `browser`, on either with `page-or-browser` (the driver uses the page session), or on the current auto-attached target with `child`. `as` names its outcome. `refusable: true` with `refusal: { "match", "onlyProtected"? }` (a regular expression for the error message or code) marks a call that a guard may refuse at registration.
- `{ "page": action, … }`:
  - `tab`: a new tab at `url`, in `context`, which becomes the page. `background` defaults to `true`;
  - `navigate`: go to `url` and wait for the load;
  - `href`, `replace`, `form`, `post`: navigate from the page, 50 ms later;
  - `open`: `window.open` with a user gesture;
  - `iframe`: add an iframe;
  - `framed`: load the `/framed` page from `from`, with `url` in an iframe;
  - `fetch`, `xhr`, `image`, `script`: load `url` and name the body (`width N` for an image, `String(globalThis.vectorScript)` after a `<script src>` loads, `error` when it fails, or `<status> <body>` with `status`); `background` doesn't wait;
  - `eval`: evaluate `expression`.
  `hops` routes `url` through `/hop` on each `origin`, with its `code`.
- `{ "answer": { "url", "stage"?, "cdp"?, "params"?, "hold"? } }`: answer each paused request or auth challenge for `url` with that call; `hold` leaves it paused. Every other paused request continues unchanged.
- `{ "children": steps, "where"? }`: run these steps on each target auto-attached from then on, then resume it. `where` scopes them to the row's own target: `{ "openerId": "page" }` (opened by the row's page) or `{ "urlPrefix": url }`; other attached targets are resumed and otherwise left alone. When a vector has a `children` step with `where`, a target that attaches before that step runs waits until it does, and is then matched against `where`. A target is only resumed when it attached waiting for the debugger, and a `browser_ui` target (Chrome's own UI, such as `chrome://omnibox-popup.top-chrome/`) is never adopted or sent anything.
- `{ "settle": { "beacon"?, "served"?, "title"?, "ms"?, "variant"?, "session"?, "dependsOn"?, "or"? } }`: wait for a beacon from `beacon`, for the fixture to log a request for the URL `served`, for the page `title`, or for the session to detach. When a refusal in `dependsOn` was recorded, the beacon can't come: a settle with `or` (a check) then waits until `or` holds, and one without it is skipped. Without such a refusal, `or` plays no part. Each beacon settle after an init script depends on that script's registration, and its `or` is what the row reads: the hops and the destination for the redirect chains, or the served page otherwise. It waits up to `ms` (10000 by default), then another 600 ms. `variant` waits the run's detach variant instead.
- `{ "wait": ms }`.
- `{ "paused": { "url", "ms" } }`: wait until the client has seen the pause that an `answer` rule for `url` matches (`Fetch.requestPaused` at the rule's stage, or `Fetch.authRequired` for a `Fetch.continueWithAuth` rule). It waits up to `ms`. On the control leg, a pause that never comes fails the row with `paused: no pause for <url> within <ms>ms`. On the guarded leg the guard may hide that pause, so the step waits the full `ms` and doesn't fail. The C5 guessed-id vectors and `C5.auth` use it before their second request, so the probe's interception id falls between the two ids the guess spans.
- `{ "guess": { "between", "cdp", "params" }, "as" }`: the call for each request id between the ids paused for the two URLs.
- `{ "client": "exit" }`: the guarded client exits. The runner calls its `close()`, waits up to 5000 ms (scaled by `settleScale`) for the page target to be no longer attached, noting in `notes` when it stays attached, attaches its unguarded observer to the page, and runs every later step of the leg through that observer. Observations still read the exited client's events. It runs only at the top level of `setup` or `trigger`, and the vector requires `clientExit`.
- `{ "text": … }`: a step in words.

Popups are observed by `Target.targetCreated` with the opener's `openerId`, or by the child's `Target.attachedToTarget`, never by the URL: a popup waiting for the debugger can still be `about:blank`.

**The stand-in** serves these routes on every origin. It never listens on 9222 to 9229.
- `/doc?n=`: an HTML page with the `data-canary` marker; `listener=1` adds `<script src="/listener.js?n=<n>">`; `csp=1` adds `Content-Security-Policy: script-src 'none'` and an inline script that sends a beacon tagged `inline-<n>` to the log, which the CSP blocks unless it is bypassed;
- `/hop?code=&to=` and `/framed?src=`;
- `/listener.js`: one line registering a window `load` listener, served with `SourceMap: /listener.js.map`;
- `/data?n=`: `real-<n>`, with CORS;
- `/script?n=`: a script setting `globalThis.vectorScript` to `real-<n>`;
- `/page?k=&to=`: a trigger page whose `go()` sends the page to `to` (`k=href`, `replace`, `popup` or `form`), and `/canary/<tag>`: a document titled `canary` with the marker;
- `/nest?n=&kind=` (and any path under `/nest`): the `C4.iframe-preattach` frame, with its `about:blank` or `about:srcdoc` child;
- `/img`: a 1×1 PNG;
- `/auth`: Basic `u`:`p`, then `authed`;
- `/rewritten` (title `rewritten`);
- `/plant`: sets the canary;
- `/beacon`, and `/log?n=`, which returns `{ hits, beacons }`.

`{ "extensionWorld": "hidden" | "select" | "debugger" | "drivable", "as": "world", "requires": ["extensionWorld"] }` runs the C9 compound probe on the current ordinary page. The runner attaches an independent observer to discover actual context ids, unique ids and names, and sends probes through the client session. Discovery matches the expected fixture extension’s exact origin, never the first extension world: `run()`’s optional `extensionWorldId` defaults to shared-web’s harness id `ankmbodmgimjemnojmeddfcdlbocolob`. Multiple unrelated content-script worlds are ignored for fixture selection, while guards must still protect foreign worlds. A custom fixture must provide the same content-script marker contract. Object handles are minted and validated on the unguarded control session, then replayed as guesses on the guarded leg; Chrome object handles and DOM node ids are session-local, so observer handles must never be mistaken for client handles. Numeric ids from the control are also replayed alongside fresh observer-discovered selectors, but numeric ids are local to a tab: a control id may name the next tab’s exposed default context, which must work and return no extension marker. The same-tab hidden world’s actual numeric id and every extension unique-id guess still require a matched refusal. Unknown numeric ids and stale object handles (`not exposed`) need explicit refusals rather than Chrome’s invalid-id errors. `guessesRefused` aggregates only required refusals; `guessesReached` must be false on the guarded leg, and `exposedContextsWork` must remain true. Its result contains boolean evidence consumed by ordinary `result` checks. The unguarded leg validates those selectors against Chrome itself before guarded evidence can pass.

`{ "errorPage": "recover", "secret"?: "all" | "query" | "fragment", "as": "errorPage" }` (also modes `restore` and `sticky`; `secret` defaults to `all`) runs the protected-error-page compound probe with independent commit evidence, discovery redaction and recovery or sticky-lock checks. The unguarded observer seeds the protected history and failed commit, so the rows run on page-session-only transports too. The guarded client uses only `Target.getTargetInfo` with a `targetId`, `Target.getTargets`, `Target.setDiscoverTargets`, `Target.attachToTarget`, `Target.detachFromTarget` and `Target.closeTarget` without a session, which page-session transports answer themselves, and everything else on its page session; the rows require no whole-vector capability. Only `eventsRedacted` requires `discovery`: without it the probe does not call `Target.setDiscoverTargets`, that one field is `not-supported` in both legs, and the notes say `not-supported:discovery`; info, list, attach, recovery and lock checks still run. Discovery absence is structural: a guarded transport delivering either `Target.targetCreated` or `Target.targetInfoChanged` during such a row without declaring `discovery` fails the row, even when the event names an ordinary target. `Target.attachedToTarget` remains independently checked by `attachRedacted`. The runner leaves this probe’s independent Fetch sessions to the probe rather than answering their pauses itself. Each of the probe’s waits is bounded at 5000 ms, scaled by `settleScale`. When the probe’s own evidence is missing, it returns `incomplete` with `protected-error-page: <reason>` instead of throwing: the observer target could not be created or attached (an `openerId` included, after cleaning the target up), the observer’s history seed or allowed document did not commit (or its setup failed), the control’s own Fetch failure injection left no error commit, the protected history entry is missing, no real `BackForwardCacheRestore` arrived, or the observer’s sticky failure left no error page. The guarded leg’s missing error commit is not incomplete: it is the guard’s, and stays `live: false`.

`{ "redirectSecret": "headers" | "mix" | "body", "as": "redirect" }` runs a C2 compound probe and owns its Fetch pauses. The client must expose `messages`, an append-only array of every raw received CDP text frame, recorded before parsing; an events-only or reply-only tap fails `rawRecorded`. Whenever a run includes a `C2.redirect-*` row or a `redirectSecret` step, `run()` retains an explicit `fixture.redirectSecret` hook or automatically installs a fetch-only `POST /redirect` bridge. Its base is `fixtureBase`, then `fixture.origin`, then `targets.ordinary`; a browser-page alias or reverse proxy must forward that endpoint to the bundled fixture. The bundled `fixtureServer()` always supplies both its direct hook and HTTP control endpoint, so no custom registration method is needed. Missing, unreachable or non-successful registration is an explicit row/summary error containing `redirectSecret fixture registration required`, never a pass or a skipped observation. Fixture logs must include headers for the cookie check. The guard’s events and raw messages must represent the same delivered stream. The leak scan memoizes each decoded string and yields to the event loop between items, so concurrent rows in the same process are not starved. When the probe’s own unguarded observer setup (attach, `Page.enable` and the seven cookie) fails before the client is used, the probe returns `incomplete` with `redirect-secret: observer setup failed: <reason>` instead of throwing.

**Host-harness requirements for every guard.** Host Node processes may use `fixtureServer()` from `./fixture`; browser pages must import only the browser-safe runner graph, served with JavaScript MIME types, and need no Node-global shim. All guards supply a guarded client, an independent unguarded observer, mapped fixture origins and the relevant advertised capabilities. C2 clients additionally record every received raw CDP frame in `client.messages` before parsing. Route protected seven/vault hosts to the fixture with `--host-resolver-rules`, including default-port callback URLs; a live protected-body negative needs HTTPS fixture trust (the reference harness pins its SPKI).

For remote/page harnesses, `fixtureClient(base)` is exported by `./guard-runner` and `./fixture-client`, or `run(set, { fixtureBase: base, ... })` constructs it. The bundled server serves CORS-safe `GET /log?since=N` as `{ from: N, entries: [...] }`, with an append-only history unaffected by `fixture.reset()`, and `POST /redirect` with a JSON-encoded string body (a simple text/plain request, without a preflight). Control requests do not appear in the log. Registration descriptors are `{ path, host?, search?, to?, code?, body, remove? }`: `path` starts with `/`, `host` selects the callback hostname, `search` distinguishes query-bearing callbacks, `to` creates a redirect with the four Location/Content-Location/Refresh/Link headers, `code` defaults to 302, an omitted `to` serves the callback body, and `remove: true` unregisters it. The bundled endpoint returns 204; custom servers must acknowledge with a successful status and actually serve the registered routes. Custom fixtures may instead supply an async `fixture.redirectSecret` hook directly; a separate log/control server can implement the same `GET /log` and `POST /redirect` contract. A Node harness using browser-only DNS aliases should pass a reachable `fixtureBase` or its direct hook.

`{ "bfcacheRestore": "observer" | "history", "origin": "{protectedTarget}", "as": "restore", "requires": ["inboundDelay"] }` runs the history-restore compound probe. `{protectedTarget}` is the row target on both legs, so the unguarded control exercises the same protected fixture origin.

`{ "frameRead": "blank" | "srcdoc", "from", "as": "frames", "on"?, "requires"? }` runs the `C4.iframe-preattach` compound probe: the observer's page and reads, then the client's attach and reads, with boolean evidence for ordinary `result` checks.

`{ "unparseable": true, "as": "unparseable" }` runs the C8 malformed-URL compound probe on the current ordinary page: independent browser ground truth, raw/canonical destination commands, discovery/attach and cookie checks. Boolean evidence is consumed by ordinary `result` checks, with native Chrome outcomes retained in its diagnostics.

**The control rule.** Every vector has a control on an ordinary origin: the same setup and trigger against an unprotected origin must succeed. A missing or failing control fails the id. With `via: "guard"`, the control runs through the guard. With `via: "unguarded"`, the runner runs setup and trigger through its own CDP against the ordinary origin and against the protected stand-in, and both must show the effect. The runner reports the control's transport as `via`.

**Refusals.** Each refusable step has a refusal name: its `as`, or `refused.<i>`, where `i` is its index in the vector's steps, setup then trigger, with each `children` step's steps right after it, counted from 0 before `on` is applied. When a guard refuses the step and the error matches `refusal.match`, the runner sets that name to `true` in the leg's observations. On that leg, an observation whose `dependsOn` lists the name is skipped; every other observation is checked as usual. A guard that refuses the step on every origin passes in one of two ways: through the guard, with the step refused on both legs, or with an unguarded control and the guard's matched refusal on the guarded leg. With `via: "guard"`, a refusal on one leg only fails that leg, unless the step declares `refusal.onlyProtected: true`: its matched refusal on the guarded leg alone is conformant, and its dependent observations are skipped there. Refusing such a step on the control always fails the control, even if both legs are refused. Without that flag, refusal symmetry is unchanged. The comparison only counts steps that ran on both legs. A step that ran on one leg only (for example a `children` step on the control's popup, when the guarded leg never gets that popup attached) doesn't fail the row by itself, and the row reports it in `ran`, as `{ "refused.5": "control-only" }` or `"guarded-only"`. Observations that depend on such a step follow their `dependsOn` on each leg. A refusable step that fails without a matching refusal, for example with an internal error or a timeout, is not a refusal: it fails the row with `<name> failed without a refusal: <message>`. A step skipped because an earlier step failed therefore never passes through `ran`, and only a matched refusal skips the observations that depend on it. A guard that allows the step must pass its control through the guard.

**Liveness.** A runner checks `live` through its own CDP, never through the guard path: either the protected document loaded (title, marker or URL), or the guard returned its own refusal for a refusable step. A failing `live` fails the id.

**Design-dependent outcomes.** A key listed in `designDependent` may expect `"either"`, which `true` and `false` both match: a guard that refuses a setup step lets the real document load, and one that blocks before commit doesn't. `detached` is design-dependent on the rows whose guarded leg proves the block (the pre-action beacon plus an exact-URL block or the history form): its `eitherWhen` holds the same proof, so a guard that blocks without detaching passes, and one that neither blocks nor detaches still fails. The hard negatives stay required.

**Observability.** `observable.own: false` marks a vector the guard host's own origin can't show (headers, auth, redirects); a runner reports it as `skip` with `not-applicable` on that target.

**Applies to.** `appliesTo` lists the triggers a vector runs with (`href`, `iframe`, `popup`, `redirect`). Chrome doesn't apply some session overrides inside a cross-site iframe, so `E6.locale`, `E6.timezone`, `E6.network-state` and `E6.blocked-urls` have no `.iframe` row.

**Variants.** `variants` gives the delay in milliseconds before the client's `Target.detachFromTarget`: `prompt` 0, `lagging` 8000. A runner may add its own variant names.

**Reports.** There is one row per id, target, variant and transport. `control`, `guarded` and `live` are each `pass`, `fail`, `incomplete` (missing probe evidence, listed in the row's `incomplete`), `skip` (with the skip's `reason`) or `not-run` (for text rows):

```json
{ "id": "C1.script-nav", "target": "vault", "variant": "lagging", "transport": "cli", "via": "guard", "control": "pass", "guarded": "pass", "live": "pass" }
```

**`guard-driver.mjs`** has no dependencies and no imports. It uses no Node APIs, so it runs in a plain browser page as well as in Node. It drives a client of this shape:
- `send(method, params, sessionId)`: returns a promise of the result, and rejects with an error carrying `cdp`, the CDP error;
- `waitEvent(predicate, ms)`: resolves with the first matching event `{ method, params, sessionId }`;
- `events`: every event received so far.

It exports:
- `beacon(log, tag)` and `probe(log, tag)`: the sources for `{beacon}` and `{probe}`;
- `canary.plant(value)`, `canary.read()` and `canary.untouched(value, read)`: the canary in `localStorage`, IndexedDB and the stand-in's marker;
- `hop`, `expand(value, vars)`, and `steps(vector, side, vars)`, a leg's expanded steps, with `refusal.name` on each refusable step and `background` set on each `tab` step;
- `refusals(vector)`: the vector's refusal names;
- `outcome`, `call(client, step, sessionId)` and `isRefusal(outcome, step)`;
- `instrument(client, sessionId, log, tag)`, `load(client, sessionId, url)` and `popup(client, openerId)`;
- `waitFor(check, ms, step?)`: polls `check` every `step` ms (default 25) until it holds, checking once more after the bound. A timer heartbeat every `step` runs for the whole wait, including while `check` is awaiting a reply, and any gap between beats longer than a second (or four steps, if longer) extends the bound by that gap, so a synchronous event-loop stall elsewhere in the process does not consume it. The extensions add up to at most `max(4 × ms, 30000)` ms, so a throttled page cannot stretch a wait without limit. `load`, the runner's waits and the error-page and redirect-body probes use it;
- `judge(vector, side, observed)`: `{ pass, refused, skipped, mismatches }`, where `refused` lists the leg's refusals and `skipped` the observations that depend on them or explicitly record unavailable observation capabilities;
- `result(vector, run)`: a report row from `{ target, variant, transport, via?, capabilities?, control, guarded, live }`. `capabilities` is the transport's; without it, the transport has them all;
- `skipReason(vector, target, scope)`: the reason the runner skips the row with when it has every capability: the vector's `skip.reason` when its `skip.target` is `target`, `not-applicable` when its `observable[target]` is `false` or its `scope` is neither `any` nor `scope`, otherwise `null`; `inapplicable(vector, target, scope)` is whether it isn't `null`;
- `knownOrigins` and `originDefaults`: the origin names a runner can miss, and the origins `plain`, `cross`, `log` and `own` fall back to when unset;
- `parseURL(value, base?)`: a `URL`, or `null` for anything `new URL` rejects or a non-string; every parse of a fixture log entry or a Chrome-reported URL in the runner and the fixture goes through it (`protected.mjs` keeps its own copy, since it imports nothing), so an unparseable entry never throws;
- `owned(entries, tag)`: the fixture log entries whose raw URL contains `tag`, the row's attribution through its `n=`, `tag=` or `to=` query;
- `summary({ guard, sha, set, results })`: `set` is the parsed `guard-vectors.json`. It returns `{ set, schemaVersion, guard, sha, variants, targets, transports, results, skipped, notRun, missing, forged, pass, line }`. `missing` lists each `{ id, target, variant, transport }` without a row, for every vector whose `scope` is `any` or the guard, every target it lists, every variant in `variants` or `results`, and every transport in `results`; `pass` needs it empty, where `line` is `GUARD-PASS <guard>@<sha> (vectors @ai-ecoverse/slicc-browsers@X.Y.Z)` or `GUARD-FAIL …`. `forged` lists each `{ id, target, variant, transport, why }` that is `not-run` on a vector that isn't `kind: "text"`, or `skip` without a reason the runner gives (`skipReason(vector, target, guard)`, the reason the runner gives: the vector's own `skip.reason` on its `skip.target`, or `not-applicable` for a target it marks unobservable or a `scope` other than `any` and the guard; `not-applicable:no-<origin>-origin` for an origin in `knownOrigins` that the row's target, `plain`, the control's origin, the steps or a check names, directly or through `originDefaults`, where only the first branch of an `any` counts, or `not-supported:<capability>` for a capability the set requires, `browserSession` or `unguarded-observer`); `pass` needs it empty too, and `line` then ends in `forged <n>`.

**`npm run validate`** checks that:
- the file matches the schema, and ids are unique;
- every vector has a control and an `expected`, text rows included;
- each id is in its family;
- a `cdp` vector has a `cdp` or `page` step, and a `text` vector has neither;
- every CDP method on the guarded leg also runs on the control;
- a skip names one of the vector's targets;
- `observe` defines every expected name;
- in a vector with a refusable step, every observation, except an `as` of a step before the first refusable one, has `dependsOn`, and each name in it is a refusable step's refusal name;
- every `Target.setAutoAttach`, `children`, child-session, browser-session and browser-context step has the matching `requires`, and a vector's `requires` includes its steps' requirements; observation-only requirements can remain local;
- a client exit step is top-level and its vector requires `clientExit`, and only a vector with a client exit step scopes a check with `exit`;
- every `{name}` is in `placeholders`;
- no URL uses a port from 9222 to 9229.

## Reference runner

`guard-runner.mjs` is dependency-free browser ESM. `run(set, options)` returns
`{ results, summary(metadata) }`; the module also exports `summary`. Results have
`id`, `target`, `variant`, `control`, `guarded`, `live`, boolean observations and
errors. Statuses are `pass`, `fail`, `incomplete`, `skip` and `not-run`. Text vectors are reported
as `not-run`; they are not silently certified. A missing observation check is an
error before execution.

Supply a CDP client with `send(method, params, sessionId): Promise<object>`,
`waitEvent(predicate, milliseconds): Promise<event>` and an append-only `events`
array of `{ method, params, sessionId }`. Rejections should expose the protocol
error as `error.cdp`, or an error message. `client` carries the guarded leg;
`unguarded`, when supplied, carries unguarded controls and observation reads.
There is no fallback from observer reads to the guarded client. A bare client
means guarded transport only; rows requiring an observer report
`skip` with `not-supported:unguarded-observer`, counted in `summary().observerSkipped`. The run's `summary()` also reports
`skips`, the number of skipped rows per reason, and appends
`skips <n> (<reason>=<count>, ...)` to `line` whenever any row was skipped, so a
certification line never reads skipped rows as coverage.
`clientFactory({ variant, detachDelay, vector, target, slot, leg? })` is called per row
and may return either a client or `{ client, unguarded, close, transportVariant }`.
The factory can configure the guard's own transport delay from this metadata;
the runner never reaches into the guard. `transportVariant: true` acknowledges
that configuration, and every result records that boolean (false by default).
`slot` allows pooling browsers while keeping each row's clients independent.
A factory that rejects or throws makes only that row `incomplete` for control, guarded and live, with `clientFactory: <reason>` in its `incomplete`; the run goes on with the next row instead of rejecting. Such a row is labelled with the transport of the last client the factory made (`cdp` if none), and is passed to `log` once the run completes, so `summary()` never counts a placeholder transport. The optional `close` releases the row's clients; release pooled browsers after
`run` completes. Each parallel slot needs an independent browser for
browser-wide settings. Without a factory execution is serial. Cookie and storage
rows use fresh browser contexts when `capabilities.browserContexts` is true;
otherwise they run serially. `capabilities` is an object of booleans or an array
of supported names, and a capability that isn't declared is unsupported: a CDP
transport over a DevTools port declares `chromeUrlsAttach: true`, and an
extension on `chrome.debugger` leaves it out, so `C8.newtab` is skipped with
`not-supported:chromeUrlsAttach`. `capabilities.scope` selects owner-specific rows; pass the same name as `guard` to `summary()`.
A row with a client exit step needs `clientExit` declared, a `clientFactory` and an
unguarded observer that isn't the guarded client: without the capability or the factory
it is `skip` with `not-supported:clientExit`, and without such an observer, with
`not-supported:unguarded-observer`, since nothing could watch the page after the exit.
When the control leg exits, the runner calls `clientFactory` again with `leg: "guarded"`
for the guarded leg's clients and releases them with their `close` after the row. If
that call fails, or its observer is the client, the guarded leg is `incomplete`, with
`clientFactory: <reason>` or `client exit: <reason>` in `incomplete`, never a pass. A
leg whose client can't exit (it has no `close()`) fails with `client exit: <reason>`.

Map `ordinary`, `ordinary-same-site`, `seven`, `vault`, `vault-x`, `apex`, `own`
and `client` to origins. `chrome-newtab`, `chrome-new-tab-page`, `chrome-settings`, `chrome-passwords`, `chrome-search`, `network-error`, `chrome-extension-page` and `file-root` default to their `url`.
`{browserUi}` is the id of one of Chrome's own `browser_ui` targets, which the runner looks up through
its unguarded observer (or the client) before the row; a row that uses it fails when there is none.
A vector with `"defaultContext": true` runs in the browser's default context even with the
`browserContexts` capability: navigating a page in a created browser context to `chrome://settings`
closes Chrome's DevTools connection (Chrome for Testing 156), so `C8.navigate` stays in the default
context. Optionally map `plain`, `cross` and `log`; their defaults
are `ordinary`, `client` and `ordinary`. Origins must preserve the site
relationships of the data. Map an unavailable target to `null`, or leave it out; a
missing or `undefined` origin is treated exactly like `null`: every
row needing that origin is reported as `skip` for control, guarded and live, with
reason `not-applicable:no-<target>-origin`; no substitute origin is used and the
row never passes. A guard whose whole site is protected, such as the extension
where every `sliccy.ai` host is protected, passes `ordinary-same-site: null`.
This also applies to origins referenced in setup and triggers, not only the row
target. In observations and liveness checks, an `any` alternative that references
a `null` origin is dropped and the rest are evaluated; the row skips only when
every alternative of an `any`, or a required (`all`, `not` or plain) check, needs it. Tags and cookie names are unique per leg. `variant`
selects one variant or an array; omission selects all. `parallel` defaults to 1.
With the `browserContexts` capability each leg runs in its own browser context. A `Target.createBrowserContext` that fails with a timeout is retried once, and the row's `notes` records it; any other failure fails the row.

Every target created by the runner’s own unguarded observer uses `Target.createTarget` with `newWindow: true`, then verifies through `Target.getTargetInfo` that `openerId` is absent. A supplied opener or missing target evidence fails and cleans up that target (in the protected-error-page probe, the row is `incomplete` instead), rather than inheriting the active client tab (which could be seven). This includes ordinary control setup, storage canaries, protected-error history seeds, the frame-read page and the malformed-URL observer. The row notes record `newWindow=true, openerId absent`. Intentional guarded-client creation commands and popup/opener tests keep their original parameters.

`settleScale` (default 1) multiplies the bounds of waits for events the leg expects to happen: settles (beacon, served, title and load) on the control leg and `required` settles on either leg, `paused` on the control leg, page and child loads, the wait for a background step's `as` result (`<as> did not complete within <ms>ms`), the wait for the pre-action beacons, the C9 control's `Debugger.paused`, and the wait for an observation the leg expects to be `true`. Adopters on slow hosts can set 3 or 4. Every wait polls and returns as soon as its event arrives, so a larger bound only costs time when something is really missing, and each timeout error names the bound it used. An observation read from the fixture (`observer: "fixture"`, such as a beacon or a served request) that the leg expects to be `true` is polled for up to 5000 ms (scaled) instead of read once. One that the leg expects to be `false` is still read once.

`refusalScale` (default 1) multiplies the bounds of waits for what the guarded leg expects to be absent, the beacon, request, title or navigation that the guard should block: settles that are not `required`, and `paused`, on the guarded leg. Such a wait runs to its full bound whenever the guard works, so `settleScale` leaves it alone. The trade-off: a larger `refusalScale` gives more sensitivity to a leak that arrives late on a slow host, because the observations after the wait see it, at the cost of that much more time per guarded row. Adopters should keep `refusalScale` at 1 or higher, never below 1; the runner refuses a `refusalScale` below 1 with `refusalScale must be a number of at least 1`.

**Incomplete.** A probe that returns `incomplete` (including `errorPage`, `redirectSecret`, `frameRead` and `bfcacheRestore` steps) records the reason in the row's `incomplete` as `<leg> <probe>: <reason>`. Its unmeasured observations read `"incomplete"`, and so does guarded liveness when the probe never measured it. A leg whose measured observations all match is then `incomplete`, never `pass`, and `live` is `incomplete` when only its evidence is missing; a measured mismatch still makes the leg `fail`, and any row error still fails both legs. `summary()` counts `incomplete` per leg, returns the number of rows with any `incomplete` status as `incomplete`, appends `incomplete <n>` to `line`, and never passes such a run. A leg that throws keeps the errors it recorded before the throw.

`onStart(row)` receives each row's `id`, `target`, `variant`, `transport` and `via` as the row starts. `run()` returns a promise that also has `inFlight()`, and its result has `inFlight` too. `inFlight()` lists the rows that are running now, each as `{ id, target, variant, leg, phase, step, clients }`, where `step` is the index of the current step in its `phase` (`setup`, `trigger` or `child`), and `clients` lists each client's pending CDP calls as `{ method, session, ageMs }` (`client`, plus `unguarded` when it is a separate client). With `rowTimeoutMs`, a row still running after that many milliseconds fails on its own. Its `errors` hold `row timed out after <ms>ms: <the in-flight view>`, `inFlight` holds the view, and the clients that `clientFactory` made for it are closed. The run then goes on to the next row. It is off by default, and a client passed as `client` is never closed.

`log(row)` receives completed rows. Besides `control`, `guarded`, `live`, `why` and `errors`, a row may carry `notSupported` (unavailable observation fields), `ran` (steps that ran on one leg only) and `notes` (settles skipped because their registration was refused). Both are informational: they explain a row's verdict, and adopters (bios, slicc-cli, slicc-cdp) must not count them as failures, or as passes. The verdict is `control`, `guarded` and `live`. A variant supplies the wait before an
explicit `Target.detachFromTarget` step and for a `settle.variant` step.

Every runnable vector has a declarative `liveCheck`; every observation has a
declarative `check`. Each check declares its `observer`: `fixture` reads request
logs, `client` reads already-delivered transport data, and `unguarded` requires
an independent CDP observer. `all` needs the observers for every operand; `any`
can use an available fixture or client alternative without an unguarded observer.
Unavailable optional observer alternatives are false, never substituted with guarded reads.
Checks include: `beacon`, `served`, `header` with
`on`, `event` with `where`, `result` with `path` and `equals`, `cookie` with `from`,
`compare`, `refused`, `reached`, `attached`, `delivered`, `title`, `expression`,
`hops` (each exact nested redirect URL), `detached`, `loaded`, `pre`, `blocked`,
`history`, `frameBlocked`, `registration`, `state` and `filtered`. The diagnostic `executed` and `live`
checks are not valid liveness proofs. A `beacon`, `served` or `header` check with
`exit: "before"` reads only the requests logged before the leg's client exit, and with
`exit: "after"` only those logged after it; on a leg that never exited it is false.
Compose checks with `all`, `any` or `not`. Predicates support nested partial
objects, `$contains`, `$regex`, `$some`, nonempty `$every`, and `$encoded` with
`{ value, prefix }` for a base64-encoded value with an optional prefix. Reads of titles and
expressions use the unguarded observer. A `refused` check can declare `refusal.match` to match protocol errors. Transport timeouts, timeout sentinel values and evaluation exceptions fail result,
comparison and observer-read
observations; they are never comparable values. Registration refusals must match the
step's declared expression; dependent observations are omitted and reported by
the existing result evaluator.

`liveCheck` applies only to the guarded leg. Controls are judged by their positive
observations: a missing or failing effect fails the control. Guarded liveness
requires the exact target URL in the fixture log or a target-origin `/live`
heartbeat; alternatively a pre-action `/live?tag=...&step=pre&to=...` request and
an exact-URL block/error from the client or unguarded frame tree. An error for a
different URL is not evidence. Before judging, the runner waits, bounded at 5 s (scaled by `settleScale`), for the
pre-action beacon of every trigger step it ran, since a keepalive beacon has no ordering
guarantee. When one never arrives, an `eitherWhen` that needs it is `"incomplete"` and
excluded from that field's expectations, and the guarded leg is not live with
`not live: pre beacon not observed for <url>` in the row's `why`, never a false
mismatch. Once the beacon is in, a failing `eitherWhen` whose field mismatches, and a
failing `liveCheck`, are rechecked for up to 1.5 s (scaled) before they count. `blocked` accepts either `{ url }` for one exact URL
or `{ anyOf: [url, ...] }` for a nonempty list of exact URLs; each URL can be a
string or `{ hops, to, index? }`. Both forms allow `session` and `frame`. With `frame`,
the unguarded observer also reads the page's out-of-process iframe targets (matched by
their parent frame): a site-isolated iframe isn't in the parent's frame tree, so its
chrome-error main frame with the exact `unreachableUrl` is the block. `history` (unguarded,
same URL forms) is for guards that replace the error page, such as with `about:blank#blocked`: it
needs the pre-action beacon, an entry with the exact URL in the observer's
`Page.getNavigationHistory` of the page or child, and no fixture request for that URL.
`frameBlocked` (unguarded) is that out-of-process chrome-error iframe target, and the
client must be unable to attach to it; the cross-site `C4` rows accept it as `errorFrame`.
A step that the guard refuses in every context, such as `Network.clearBrowserCookies`
in `C6.clear-cookies`, is refusable, so refusing it on both legs passes and allowing it
is judged on its effect. A child step that fails after its child session detached is
recorded as detached, not as a refusal, and the runner awaits a child's started
`children` steps before any later `session: "child"` step and before the trigger. A page
navigation waits for the load of its own `loaderId` (its `Page.frameNavigated` and then a
load event), and a settle waits for a main-frame commit followed by its load, so a stale
load event never ends a wait. After a child's `children` steps that include `Page.enable`,
the runner waits, bounded at 5 s, for the child's first document to commit and load before
any later child step. `{ "settle": { "beacon", "required": true, "dependsOn"? } }` waits
for that beacon at the fixture and fails the row with `settle: no beacon from <origin>
within <ms>ms` when it never arrives, unless a refusal it `dependsOn` was recorded. It checks `dependsOn` again while it waits, since a child's `children` steps may still be running. When the registration it depends on was refused, the settle is skipped, the row's `notes` gets `<leg> settle:skipped-refused beacon <origin>`, and the row is judged on its other observations. The rows
whose `allowedBeacon` comes from an earlier document settle on it before their trigger.
Beacons use `navigator.sendBeacon`, with a `fetch(…, { keepalive: true })` fallback. An observation that reads a background step's `as` result
waits for that step, up to 10 s, and fails with `<as> did not complete within …` past it. Redirect
vectors list every nested hop URL and the final destination because Chromium
reports the URL intercepted by the guard. A matching block still requires the
pre-action beacon alongside it; an unrelated error cannot certify the chain.
A declared setup refusal can supply liveness only
when its `refusal.match` matched. Transport connectivity and command completion
alone never prove liveness. Cookie and storage rows seed a canary outside the
guard and read it back outside the guard; refused writes require unchanged
canary state and a refusal or filtered call response. Their control can clear or
modify state as required by its positive observations. `C5.auth` and
`C5.guessed-id.continue-with-auth` use fixture Authorization logs and refusal of
candidate auth ids; `C5.auth` also checks delivered auth events. Their liveness
requires an auth request at the fixture, not a completed fetch. Neither uses a
plain-tab baseline: headless Chromium can leave a credentials-including fetch
to a Basic 401 pending even without an attached client.

Beacon settlement uses only requests recorded after the page action starts. For
redirect chains it also requires the exact final destination request in the
fixture log. A setup beacon on the same origin and tag cannot settle an unfinished
redirect chain. This does not change the observations used to judge either leg.

The fixture log is shared by every row in a run, and `C8.unparseable` leaves entries such
as `http://exa%20mple.sliccy.ai:<port>/doc?n=<tag>-create-0` that `new URL` rejects. A
row reads only the entries that carry its own tag; a tagged `liveCheck`, `served`,
`on` or `beacon` check never sees another row's entries, and an entry that does not
parse is matched only by its raw or canonical string, never parsed into a throw.
`hops` checks compare exact URLs. `"tagged": false` reads every entry and skips the ones
that don't parse.

The separately exported Node module `@ai-ecoverse/slicc-browsers/fixture` exposes
`fixtureServer({ host, port, tls, latency })`, defaulting to a random loopback port. `latency(url)` returns milliseconds to hold that response, for timing tests.
Pass `tls: { key, cert }` to serve HTTPS using Node TLS key and certificate
values. The returned origin, request logs, redirect URLs and document heartbeats
use `https://<Host>` with TLS, so `served`, `hops` and `liveCheck` compare against
the mapped HTTPS origins, including an extension client at `https://*.sliccy.ai`.
Without `tls`, the server and logged URLs remain HTTP. It returns
`origin`, `port`, `log()`, `reset()` and `close()`. Log entries contain `url`,
`method`, `headers` and `time`. Mirror that API when using another fixture.
The server serves document, frame, redirect, CSP, authentication, data, image,
canary and beacon paths. Configure host resolution in your test browser, not in
the runner. `npm run test:guard` exercises Chromium twice with no guard, one target per
invocation: controls must pass and guarded protection expectations must fail; the `C8.newtab` reachability control and `X1.after-exit`, whose plain client leaves nothing behind when it exits, must instead pass both legs. Rows that require `siteIsolationOff` run in one more Chromium launched without site isolation. For a single
target use `GUARD_TARGET=seven npm run test:guard-target`. The fixture also serves
`/live` image requests from stand-in documents, independently of injected code.

The integration launcher owns each Chrome process group and temporary profile. `close()` terminates the group, escalates to SIGKILL if necessary and removes the profile; node:test workers also register an after hook for every launch. Process exit, uncaught errors, SIGINT, SIGTERM and SIGHUP reap tracked groups synchronously. An independent POSIX watchdog watches the runner’s pipe and reaps Chrome and its profile even if the runner receives SIGKILL. `launch(fixture, { signal })` also accepts a test’s AbortSignal for timeout cleanup. `guard-lifecycle.test.mjs` interrupts real runner subprocesses and checks every Chrome PID returned by CDP’s `SystemInfo.getProcessInfo` plus profile removal, without consulting a host-wide process list.


```js
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { run } from '@ai-ecoverse/slicc-browsers/guard-runner';
import { fixtureServer } from '@ai-ecoverse/slicc-browsers/fixture';
const fixture = await fixtureServer();
const targets = await configureTestOrigins(fixture.port);
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  chromeUrlsAttach: true,
  discovery: true,
};
const execution = await run(set, {
  clientFactory: (metadata) => connectGuardAndObserver(metadata),
  targets,
  capabilities,
  variant: ['prompt', 'lagging'],
  parallel: 6,
  fixture,
});
console.log(execution.summary({ guard: 'my-guard', sha: 'build-sha' }));
await fixture.close();
```

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

`schema/browsers.schema.json` describes `slicc browsers --json`, which `playwright-cli list --json` also prints. [slicc-cli's README](https://github.com/ai-ecoverse/slicc-cli#slicc-browsers---json---cdp-url---no-bundle-scan) is the authoritative spec for it; this schema is a copy and follows it. Fields can be added; `source` is one of `devtools-active-port`, `flag`, `probe` and `process`. `tier` is 1 to 6, and `six: true` marks an endpoint in SLICC six's profile (tier 6). An endpoint may carry `tabs`: every page target except those on protected origins. Seven's own tabs are protected, so they are in `sevenTabs` only, never in `tabs`. In `sevenTabs`, `url` and `title` are the origin only, never a path, query, fragment or document title, including configured extra seven origins and default-port normalization. `playwright-cli list --json` prints it, and a corpus case that checks it needs `tabs`.

## The corpus

Each case is a fake machine: a home tree, `DevToolsActivePort` files, fake `/json/version` and `/json/list` answers, a fake process list, `--cdp` URLs, and installed browsers, with the ranked list it must produce in `expected.json`. `corpus.json` holds every case as `{ "name", "case", "expected" }`.

**`case.json`:**
- `description`, and `os?`: the OSes the case runs on (`darwin`, `linux`, `windows`; default all).
- `needs`: what a program must support to run the case: `user-data-dirs` (`DevToolsActivePort` in browsers' default user-data dirs), `seven-profiles` (in the profile roots), `flag` (`--cdp` URLs), `process`, `probe` (port probes), `origins` (extra seven origins), `installed` (ranking installed browsers), `six` (finding and marking SLICC six's profiles), `tabs` (each endpoint's `tabs` list). A program skips a case that needs something it doesn't do.
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
- `npm run validate` checks `catalog.json`, `corpus.json`, `protected.json` and `guard-vectors.json` against the schemas, runs the protected-origin vectors through `protected.mjs`, loads `protected.mjs` and `seven.mjs` with only `URL`, and checks what a schema can't say: unique ids, bundle ids and names, known Windows roots, rising tiers, compiling patterns, known tokens, tier order, `sevenOpen`, `tabs` (which holds no entry of `sevenTabs`), `six` and `auto` in each `expected.json`, and no port from 9222 to 9229.
- Every gate prints one verdict line when it passes: `validate: PASS …`, `corpus: PASS <n> cases` (`node scripts/corpus.mjs --check`), `major-guard: PASS v<version> fits <module>`, and `guard-sweep: PASS 14 targets` (`npm run test:guard-sweep`). CI runs each through `scripts/gate.mjs --expect <regex> -- <command>`, which fails when the command exits non-zero or prints no matching line, so a silent or early exit never reads as a pass. `gate.mjs --expect <regex> --in <file>` checks a log instead; the release job uses it on semantic-release's log for the major-guard line. `npm run test:gates` tests the gates, including runs through a symlinked checkout and a symlinked script.
- `npm run lint`: the slicc lint tools (Biome, no comments, no unit tests in git, `AGENTS.md`), `gofmt`, `go mod tidy -diff`, `go vet`, golangci-lint, `cargo fmt --check` and clippy.
- `npm test`: `validate`, `test/integration/self-contained.test.mjs`, `test/integration/git-retry.test.mjs`, the Go tests in `test/integration/`, and `cargo test --all-features`.
- `npm run build`: the Go module, the crate (also for `wasm32-wasip1`), and `npm pack --dry-run`.

Changing a table in `slicc-cli/internal/browser` means changing `catalog.json` here, releasing, and bumping the dependency; slicc-cli has no tables of its own. A new behaviour gets a corpus case.

## Releases

semantic-release cuts one version from `main` for all three packages (`.github/workflows/release.yml`).
1. The tag `vX.Y.Z` and a GitHub release are the Go module's release. `scripts/major-guard.mjs` fails the release when the major doesn't fit the module path in `go.mod` (no suffix allows v0 and v1, `/vN` only vN). The workflow then asks `proxy.golang.org` for the new version and `pkg.go.dev` to fetch it; both only warn.
2. **npm:** with the repository variable `SLICC_BROWSERS_NPM_PUBLISH` set to `true`, the package is stamped with the version and published through npm trusted publishing (OIDC, with provenance). A version that is already on npm is skipped. It goes out on the `latest` dist-tag without `--tag`, so npm refuses a version below the current `latest`.
3. **crates.io:** with the repository variable `SLICC_BROWSERS_CRATES_PUBLISH` set to `true`, `Cargo.toml` is stamped with the version and `cargo publish` runs with a short-lived token from crates.io trusted publishing (`rust-lang/crates-io-auth-action`). A version that is already on crates.io is skipped.
4. **Cert line:** after the npm publish, the workflow runs `npm pack @ai-ecoverse/slicc-browsers@X.Y.Z` against the registry and appends `cert: @ai-ecoverse/slicc-browsers@X.Y.Z sha256=<hex> gitHead=<sha>` to the `vX.Y.Z` GitHub release and the job summary, once; the cert lane copies it from there.

GitHub sometimes rejects the push of `refs/notes/semantic-release-vX.Y.Z` with a bare `(failed)` right after the tag push; no ruleset covers `refs/notes/*`. The semantic-release step runs with `pipefail` and puts `scripts/git-retry.mjs` first on `PATH` as `git`: it runs the real git (`REAL_GIT`) and retries a push of a `refs/notes/` ref up to five times, 5, 10, 15 and 20 seconds apart; any other git command runs once. When semantic-release still fails, the job fails before npm and crates.io publish. Recover without moving the tag: create the GitHub release on the existing tag, then run `gh workflow run release.yml --ref main -f tag=vX.Y.Z`. A tag without its note counts as on the default channel (semantic-release reads a missing note as `channels: [null]`), so the next release builds on it. `test/integration/git-retry.test.mjs` tests the retry with a fake git.

A run started by hand publishes what's missing without a new release: `gh workflow run release.yml --ref main` when `main`'s head has its tag, or `gh workflow run release.yml --ref main -f tag=vX.Y.Z` for any existing tag. `gh workflow run release.yml --ref main -f cert-only=true` only adds the cert line for the latest npm version.

**Go module versions.** A pushed tag is the release: `proxy.golang.org` caches it and `sum.golang.org` records its hash for good. Never move or delete a pushed tag; retract a bad version in `go.mod` and release anew. A `BREAKING CHANGE` needs a `/vN` module path first.

**First publish (by a maintainer with 2FA):**
1. npm: `npx fledgling add --new @ai-ecoverse/slicc-browsers` claims the name with a `0.0.0` placeholder and trusts `ai-ecoverse/slicc-browsers`' `release.yml`. Then set `SLICC_BROWSERS_NPM_PUBLISH` to `true`.
2. crates.io: trusted publishing needs the crate to exist. Publish it once by hand from the latest tag: `git checkout vX.Y.Z && node scripts/set-crate-version.mjs X.Y.Z && cargo publish --allow-dirty`, logged in with `cargo login`. Then, on crates.io, add a trusted publisher to `slicc-browsers`: GitHub, owner `ai-ecoverse`, repository `slicc-browsers`, workflow `release.yml`, no environment. Then set `SLICC_BROWSERS_CRATES_PUBLISH` to `true`.
