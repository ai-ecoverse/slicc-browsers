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
  - `originScheme` and `originHostPattern`: a seven origin is `https://<host>` with a host matching the pattern, except for the `excludedLabels` (`www`, `vault`, `vault-preview`, `get`, `mcpcat`, `echo`) and the `excludedLabelPrefixes` (`vault-`, which excludes `vault-feature-x` and any other vault branch preview). The bare apex (`sliccy.ai`, i.e. an empty label) never matches. An origin is compared without the scheme's default port (443 for `https`, 80 for `http`), so `https://seven.sliccy.ai:443` is seven and `https://seven.sliccy.ai:8443` is not. The same goes for extra seven origins;
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

This is wider than the rule for finding seven (`seven.originHostPattern`, which leaves out the `excludedLabels` and `excludedLabelPrefixes`—`www`, `vault`, `vault-preview`, `get`, `mcpcat`, `echo`, and any `vault-*` prefix). Every `sliccy.ai` host shares the `sliccy.ai` cookies, and cookies ignore the port and, without `Secure`, the scheme. SLICC six lives on `www.sliccy.ai` and the apex, and its cookies matter. `*.kernel.localhost` is not protected: each port is its own origin, and the agent's own servers live there. An extra origin is matched exactly, so `http://127.0.0.1:5710` doesn't protect `http://127.0.0.1:5711`.

**The vault.** `vault.sliccy.ai` is in `hosts` by name, and vault branch previews (`vault-preview.sliccy.ai`, `vault-*.sliccy.ai`) are covered by the `sliccy.ai` domain rule. `sliccy.ai` already covers them all, but vault must stay protected even if `domains` ever changes: the vault must never be a CDP target for agent tools. The one exception is slicc-cli's own pairing attach for the vault, which is the CLI's own connection and not browser control handed to the agent.

**Targets.** A target's effective origin is its URL's (`TargetInfo.url`), except when the URL inherits the origin of whoever made the document: the empty URL, and `inheriting` with any query or fragment. Such a target is protected when it was protected before this URL (a seven tab that went to `about:blank` keeps seven's origin), or when its opener (`openerId`, else `openerFrameId`) is protected or unknown, for an opener closed before the program saw it. The URL, `openerFrameId` and `browserContextId` alone can't tell: a blank popup that seven opens has seven's origin and the URL `about:blank`. A program that holds a session to the target also has the document's real origin: the main frame's `securityOrigin` in `Page.frameNavigated`, and the default context's `origin` in `Runtime.executionContextCreated`. When one of those is protected, the target is protected too, until a URL with an origin of its own replaces it.

A same-site frame shares its parent's process and has no target of its own. Every `sliccy.ai` host is protected, and site isolation gives a seven frame inside any other site its own target, so this only matters for an extra origin whose site has other origins (another port of `127.0.0.1`, say).

**Cookies.** A cookie domain, lower-cased and without a leading or trailing dot, is protected when it is one of `domains` or under one, or when it is one of `hosts`, the host of a protected domain or an extra origin, or a parent of one: a cookie on `.example.test` reaches `https://seven.example.test`.

**Storage keys** (`Storage`, `IndexedDB`, `CacheStorage` and `FileSystem` in CDP): a key is protected when its origin (up to the first `^`) or its top-level site (a part after `^0`) is a protected URL.

**Refusals** carry the text in `refusal`, `slicc: refused: target is on seven's origin`.

**`protected.json`** (schema `schema/protected.schema.json`): `origins`, the extra origins every vector runs with; `urls` (`url`, `protected`); `targets` (`url`, `previous?`, whether the target was protected before; `opener?`, `protected`, `unprotected` or `unknown`, and no `opener` for a target without one; `protected`); `cookieDomains` (`domain`, `protected`); `storageKeys` (`key`, `protected`). `npm run validate` runs every vector through `protected.mjs`, and no vector uses a port from 9222 to 9229.

## Guard vectors

Every CDP guard runs the vectors in `guard-vectors.json` (schema `schema/guard-vectors.schema.json`): bios, slicc-cdp, slicc-extension and slicc-cli. The sources are listed in `sources`:
- slicc-cli's `protectVectors` at `2d5d981` (`test/integration/testdata/link/protect.js`), with the ids kept;
- slicc-cdp's `test/integration/guard-vectors.json` at `4907a45`, where its `E1`, `E2`, `E3`, `E5` and `B2` are renamed `E1.onload`, `E2.binding`, `E3.bypass-csp`, `E5.console` and `B2.headers`;
- the cert lane's E and B rows;
- `C5.continue-request` and `C5.continue-response`, added next to `C5.document`.

**Top level.**
- `schemaVersion` (1): guards pin it.
- `setVersion`: the package version. The release flow stamps it into the npm package and the crate (`scripts/set-crate-version.mjs`). In git, and so in the Go module, it reads `0.0.0`; Go code gets the version from the module.
- `targets`: the names a runner maps to a scheme, host and port: `seven`, `vault`, `vault-x` (a vault branch preview), `apex`, `own` (the client page's origin, `{client}`), `ordinary` and `ordinary-same-site`. Each has a `description` and, for the protected ones, a default `host`. Nothing in the file is a URL a runner must use.
- `variants`: the detach variants in ms. `prompt` and `lagging` are documented; a runner may add others, such as `lagging-8s`, and reports the name it ran.
- `capabilities`: what a transport may lack. `autoAttach` covers `Target.setAutoAttach`, `children` steps and child sessions; `browserSession` covers calls on the browser session; `browserContexts` covers `Target.createBrowserContext` and `Target.disposeBrowserContext`.
- `placeholders`: every `{name}` used in the vectors, with what it stands for. `{client}` is the client page's origin, which the runner maps.

**A vector** has:
- `id`, and `family` (`C`, `E` or `B`, the id's first letter);
- `kind`: `cdp` (runnable steps) or `text` (rows in words, which runners report as `not-run`, never `pass`);
- `scope`: `any`, or the one guard the vector is for;
- `setup` and `trigger`, both lists of steps;
- `targets`: the protected targets it runs against;
- `requires?`: the capabilities it needs, the union of its steps' and observations' `requires`. A runner whose transport lacks one reports the vector as `skip` with the reason `not-supported:<capability>`. A row with a `page-or-browser` cookie step that would carry a `browserContextId` reports `not-supported:browserSession` without a browser session, because that parameter is only allowed on the browser target;
- `observe?`: each observed name, as `{ "means", "dependsOn"?, "requires"?, "eitherWhen"? }`. `dependsOn` lists the refusals the observation depends on (see Refusals). `eitherWhen` is a check: when it holds on the guarded leg, that observation's expectation becomes `"either"` there (see Design-dependent outcomes);
- `live`: the liveness check;
- `control` (`origin: "ordinary"`, `via`, `expected`) and `expected`: an object of names and booleans, or text;
- `skip?` (`target`, `reason`): `reason` starts with a code, as in `not-applicable: …`.

**Steps** are declarative and transport-neutral. Any step can take `on` (`control` or `guarded`), which runs it on that leg only.
Any `cdp`, `page` or `children` step can take `requires`, the capabilities it needs: `autoAttach` for `Target.setAutoAttach`, `children` and `session: "child"`, `browserSession` for `session: "browser"`, and `browserContexts` for `Target.createBrowserContext` and `Target.disposeBrowserContext`.
- `{ "cdp": method, "params"?, "session"?, "as"?, "refusable"?, "refusal"? }`: a CDP call. It runs on the page session by default, on the browser with `browser`, on either with `page-or-browser` (the driver uses the page session), or on the current auto-attached target with `child`. `as` names its outcome. `refusable: true` with `refusal: { "match" }` (a regular expression for the error message or code) marks a call that a guard may refuse at registration.
- `{ "page": action, … }`:
  - `tab`: a new tab at `url`, in `context`, which becomes the page. `background` defaults to `true`;
  - `navigate`: go to `url` and wait for the load;
  - `href`, `replace`, `form`, `post`: navigate from the page, 50 ms later;
  - `open`: `window.open` with a user gesture;
  - `iframe`: add an iframe;
  - `framed`: load the `/framed` page from `from`, with `url` in an iframe;
  - `fetch`, `xhr`, `image`: load `url` and name the body (`width N` for an image, or `<status> <body>` with `status`); `background` doesn't wait;
  - `eval`: evaluate `expression`.
  `hops` routes `url` through `/hop` on each `origin`, with its `code`.
- `{ "answer": { "url", "stage"?, "cdp"?, "params"?, "hold"? } }`: answer each paused request or auth challenge for `url` with that call; `hold` leaves it paused. Every other paused request continues unchanged.
- `{ "children": steps, "where"? }`: run these steps on each target auto-attached from then on, then resume it. `where` scopes them to the row's own target: `{ "openerId": "page" }` (opened by the row's page) or `{ "urlPrefix": url }`; other attached targets are resumed and otherwise left alone.
- `{ "settle": { "beacon"?, "title"?, "ms"?, "variant"?, "session"? } }`: wait for a beacon from `beacon`, for the page `title`, or for the session to detach. It waits up to `ms` (10000 by default), then another 600 ms. `variant` waits the run's detach variant instead.
- `{ "wait": ms }`.
- `{ "paused": { "url", "ms" } }`: wait until the client has seen the pause that an `answer` rule for `url` matches (`Fetch.requestPaused` at the rule's stage, or `Fetch.authRequired` for a `Fetch.continueWithAuth` rule). It waits up to `ms`. On the control leg, a pause that never comes fails the row with `paused: no pause for <url> within <ms>ms`. On the guarded leg the guard may hide that pause, so the step waits the full `ms` and doesn't fail. The C5 guessed-id vectors and `C5.auth` use it before their second request, so the probe's interception id falls between the two ids the guess spans.
- `{ "guess": { "between", "cdp", "params" }, "as" }`: the call for each request id between the ids paused for the two URLs.
- `{ "text": … }`: a step in words.

Popups are observed by `Target.targetCreated` with the opener's `openerId`, or by the child's `Target.attachedToTarget`, never by the URL: a popup waiting for the debugger can still be `about:blank`.

**The stand-in** serves these routes on every origin. It never listens on 9222 to 9229.
- `/doc?n=`: an HTML page with the `data-canary` marker; `csp=1` adds `Content-Security-Policy: script-src 'none'` and an inline script that sends a beacon tagged `inline-<n>` to the log, which the CSP blocks unless it is bypassed;
- `/hop?code=&to=` and `/framed?src=`;
- `/data?n=`: `real-<n>`, with CORS;
- `/img`: a 1×1 PNG;
- `/auth`: Basic `u`:`p`, then `authed`;
- `/rewritten` (title `rewritten`);
- `/plant`: sets the canary;
- `/beacon`, and `/log?n=`, which returns `{ hits, beacons }`.

**The control rule.** Every vector has a control on an ordinary origin: the same setup and trigger against an unprotected origin must succeed. A missing or failing control fails the id. With `via: "guard"`, the control runs through the guard. With `via: "unguarded"`, the runner runs setup and trigger through its own CDP against the ordinary origin and against the protected stand-in, and both must show the effect. The runner reports the control's transport as `via`.

**Refusals.** Each refusable step has a refusal name: its `as`, or `refused.<i>`, where `i` is its index in the vector's steps, setup then trigger, with each `children` step's steps right after it, counted from 0 before `on` is applied. When a guard refuses the step and the error matches `refusal.match`, the runner sets that name to `true` in the leg's observations. On that leg, an observation whose `dependsOn` lists the name is skipped; every other observation is checked as usual. A guard that refuses the step on every origin passes in one of two ways: through the guard, with the step refused on both legs, or with an unguarded control and the guard's matched refusal on the guarded leg. With `via: "guard"`, a refusal on one leg only fails that leg. The comparison only counts steps that ran on both legs. A step that ran on one leg only (for example a `children` step on the control's popup, when the guarded leg never gets that popup attached) doesn't fail the row by itself, and the row reports it in `ran`, as `{ "refused.5": "control-only" }` or `"guarded-only"`. Observations that depend on such a step follow their `dependsOn` on each leg. A refusable step that fails without a matching refusal, for example with an internal error or a timeout, is not a refusal: it fails the row with `<name> failed without a refusal: <message>`. A step skipped because an earlier step failed therefore never passes through `ran`, and only a matched refusal skips the observations that depend on it. A guard that allows the step must pass its control through the guard.

**Liveness.** A runner checks `live` through its own CDP, never through the guard path: either the protected document loaded (title, marker or URL), or the guard returned its own refusal for a refusable step. A failing `live` fails the id.

**Design-dependent outcomes.** A key listed in `designDependent` may expect `"either"`, which `true` and `false` both match: a guard that refuses a setup step lets the real document load, and one that blocks before commit doesn't. `detached` is design-dependent on the rows whose guarded leg proves the block (the pre-action beacon plus an exact-URL block or the history form): its `eitherWhen` holds the same proof, so a guard that blocks without detaching passes, and one that neither blocks nor detaches still fails. The hard negatives stay required.

**Observability.** `observable.own: false` marks a vector the guard host's own origin can't show (headers, auth, redirects); a runner whose `own` is a static server reports it as `skip` with `not-observable`.

**Applies to.** `appliesTo` lists the triggers a vector runs with (`href`, `iframe`, `popup`, `redirect`). Chrome doesn't apply some session overrides inside a cross-site iframe, so those E6 rows list `href` only.

**Variants.** `variants` gives the delay in milliseconds before the client's `Target.detachFromTarget`: `prompt` 0, `lagging` 8000. A runner may add its own variant names.

**Reports.** There is one row per id, target, variant and transport. `control`, `guarded` and `live` are each `pass`, `fail`, `skip` (with the skip's `reason`) or `not-run` (for text rows):

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
- `judge(vector, side, observed)`: `{ pass, refused, skipped, mismatches }`, where `refused` lists the leg's refusals and `skipped` the observations that depend on them;
- `result(vector, run)`: a report row from `{ target, variant, transport, via?, capabilities?, control, guarded, live }`. `capabilities` is the transport's; without it, the transport has them all;
- `summary({ guard, sha, set, results })`: `set` is the parsed `guard-vectors.json`. It returns `{ set, schemaVersion, guard, sha, variants, targets, transports, results, skipped, notRun, missing, pass, line }`. `missing` lists each `{ id, target, variant, transport }` without a row, for every vector whose `scope` is `any` or the guard, every target it lists, every variant in `variants` or `results`, and every transport in `results`; `pass` needs it empty, where `line` is `GUARD-PASS <guard>@<sha> (vectors @ai-ecoverse/slicc-browsers@X.Y.Z)` or `GUARD-FAIL …`.

**`npm run validate`** checks that:
- the file matches the schema, and ids are unique;
- every vector has a control and an `expected`, text rows included;
- each id is in its family;
- a `cdp` vector has a `cdp` or `page` step, and a `text` vector has neither;
- every CDP method on the guarded leg also runs on the control;
- a skip names one of the vector's targets;
- `observe` defines every expected name;
- in a vector with a refusable step, every observation, except an `as` of a step before the first refusable one, has `dependsOn`, and each name in it is a refusable step's refusal name;
- every `Target.setAutoAttach`, `children`, child-session, browser-session and browser-context step has the matching `requires`, and a vector's `requires` is the union of its steps' and observations';
- every `{name}` is in `placeholders`;
- no URL uses a port from 9222 to 9229.

## Reference runner

`guard-runner.mjs` is dependency-free browser ESM. `run(set, options)` returns
`{ results, summary(metadata) }`; the module also exports `summary`. Results have
`id`, `target`, `variant`, `control`, `guarded`, `live`, boolean observations and
errors. Statuses are `pass`, `fail`, `skip` and `not-run`. Text vectors are reported
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
`clientFactory({ variant, detachDelay, vector, target, slot })` is called per row
and may return either a client or `{ client, unguarded, close, transportVariant }`.
The factory can configure the guard's own transport delay from this metadata;
the runner never reaches into the guard. `transportVariant: true` acknowledges
that configuration, and every result records that boolean (false by default).
`slot` allows pooling browsers while keeping each row's clients independent.
The optional `close` releases the row's clients; release pooled browsers after
`run` completes. Each parallel slot needs an independent browser for
browser-wide settings. Without a factory execution is serial. Cookie and storage
rows use fresh browser contexts when `capabilities.browserContexts` is true;
otherwise they run serially. `capabilities` is an object of booleans or an array
of supported names. `capabilities.scope` selects owner-specific rows.

Map `ordinary`, `ordinary-same-site`, `seven`, `vault`, `vault-x`, `apex`, `own`
and `client` to origins. Optionally map `plain`, `cross` and `log`; their defaults
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
`log(row)` receives completed rows. Besides `control`, `guarded`, `live`, `why` and `errors`, a row may carry `ran` (steps that ran on one leg only) and `notes` (settles skipped because their registration was refused). Both are informational: they explain a row's verdict, and adopters (bios, slicc-cli, slicc-cdp) must not count them as failures, or as passes. The verdict is `control`, `guarded` and `live`. A variant supplies the wait before an
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
checks are not valid liveness proofs.
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
different URL is not evidence. `blocked` accepts either `{ url }` for one exact URL
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
invocation: controls must pass and guarded expectations must fail. For a single
target use `GUARD_TARGET=seven npm run test:guard-target`. The fixture also serves
`/live` image requests from stand-in documents, independently of injected code.

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
- `npm run validate` checks `catalog.json`, `corpus.json`, `protected.json` and `guard-vectors.json` against the schemas, runs the protected-origin vectors through `protected.mjs`, and checks what a schema can't say: unique ids, bundle ids and names, known Windows roots, rising tiers, compiling patterns, known tokens, tier order, `sevenOpen`, `six` and `auto` in each `expected.json`, and no port from 9222 to 9229.
- `npm run lint`: the slicc lint tools (Biome, no comments, no unit tests in git, `AGENTS.md`), `gofmt`, `go mod tidy -diff`, `go vet`, golangci-lint, `cargo fmt --check` and clippy.
- `npm test`: `validate`, the Go tests in `test/integration/`, and `cargo test --all-features`.
- `npm run build`: the Go module, the crate (also for `wasm32-wasip1`), and `npm pack --dry-run`.

Changing a table in `slicc-cli/internal/browser` means changing `catalog.json` here, releasing, and bumping the dependency; slicc-cli has no tables of its own. A new behaviour gets a corpus case.

## Releases

semantic-release cuts one version from `main` for all three packages (`.github/workflows/release.yml`):
1. The tag `vX.Y.Z` and a GitHub release are the Go module's release. `scripts/major-guard.mjs` fails the release when the major doesn't fit the module path in `go.mod` (no suffix allows v0 and v1, `/vN` only vN). The workflow then asks `proxy.golang.org` for the new version and `pkg.go.dev` to fetch it; both only warn.
2. **npm:** with the repository variable `SLICC_BROWSERS_NPM_PUBLISH` set to `true`, the package is stamped with the version and published through npm trusted publishing (OIDC, with provenance). A version that is already on npm is skipped.
3. **crates.io:** with the repository variable `SLICC_BROWSERS_CRATES_PUBLISH` set to `true`, `Cargo.toml` is stamped with the version and `cargo publish` runs with a short-lived token from crates.io trusted publishing (`rust-lang/crates-io-auth-action`). A version that is already on crates.io is skipped.
4. **Cert line:** after the npm publish, the workflow runs `npm pack @ai-ecoverse/slicc-browsers@X.Y.Z` against the registry and appends `cert: @ai-ecoverse/slicc-browsers@X.Y.Z sha256=<hex> gitHead=<sha>` to the `vX.Y.Z` GitHub release and the job summary, once; the cert lane copies it from there.

A run started by hand publishes what's missing without a new release: `gh workflow run release.yml --ref main` when `main`'s head has its tag, or `gh workflow run release.yml --ref main -f tag=vX.Y.Z` for any existing tag. `gh workflow run release.yml --ref main -f cert-only=true` only adds the cert line for the latest npm version.

**Go module versions.** A pushed tag is the release: `proxy.golang.org` caches it and `sum.golang.org` records its hash for good. Never move or delete a pushed tag; retract a bad version in `go.mod` and release anew. A `BREAKING CHANGE` needs a `/vN` module path first.

**First publish (by a maintainer with 2FA):**
1. npm: `npx fledgling add --new @ai-ecoverse/slicc-browsers` claims the name with a `0.0.0` placeholder and trusts `ai-ecoverse/slicc-browsers`' `release.yml`. Then set `SLICC_BROWSERS_NPM_PUBLISH` to `true`.
2. crates.io: trusted publishing needs the crate to exist. Publish it once by hand from the latest tag: `git checkout vX.Y.Z && node scripts/set-crate-version.mjs X.Y.Z && cargo publish --allow-dirty`, logged in with `cargo login`. Then, on crates.io, add a trusted publisher to `slicc-browsers`: GitHub, owner `ai-ecoverse`, repository `slicc-browsers`, workflow `release.yml`, no environment. Then set `SLICC_BROWSERS_CRATES_PUBLISH` to `true`.
