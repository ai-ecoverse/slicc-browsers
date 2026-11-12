# slicc-browsers

The browser knowledge that SLICC's tools share. SLICC drives a real Chromium browser over the Chrome DevTools Protocol (CDP), and several programs, written in different languages, need to agree on the same facts:

- which browsers exist, where they are installed, and how to launch them for SLICC;
- how to find a browser that is already running with a debugging port, and which one to pick;
- which origins browser control must **never** touch, starting with seven's own origin and the vault;
- how to prove that a CDP guard really keeps a client away from them.

These programs can't share code, so they share data: one catalog, four vector sets and schemas, as a Go module, Rust crate and npm package at one version.

| who | uses it for |
| --- | --- |
| [slicc-cli](https://github.com/ai-ecoverse/slicc-cli) (Go) | `slicc browsers`, `slicc launch`, and its CDP relay's guard |
| [slicc-cdp](https://github.com/ai-ecoverse/slicc-cdp) (Rust, also `wasm32-wasip1`) | `playwright-cli list` and `open`, and its guard |
| [slicc-agent](https://github.com/ai-ecoverse/slicc-agent) | refusing protected origins in its browser tools |
| [slicc-bios](https://github.com/ai-ecoverse/slicc-bios), [slicc-extension](https://github.com/ai-ecoverse/slicc-extension) | their CDP guards, tested against the guard vectors |

## What's inside

| file | what it is |
| --- | --- |
| [`catalog.json`](catalog.json) | every known Chromium browser and Electron app, with install paths per OS, discovery and ranking rules, seven's launch flags and prefs, profile locations and the protected origins |
| [`corpus/`](corpus), `corpus.json` | discovery conformance cases: a fake machine each, with the ranked browser list it must produce |
| [`protected.json`](protected.json), [`protected.mjs`](protected.mjs) | protected-origin test vectors, and a reference matcher in JavaScript |
| [`guard-vectors.json`](guard-vectors.json) | the CDP scenarios every guard must pass |
| [`debugger-stage1.json`](debugger-stage1.json) | shared Stage 1 debugger conformance data |
| [`guard-runner.mjs`](guard-runner.mjs), [`guard-driver.mjs`](guard-driver.mjs), [`fixture-server.mjs`](fixture-server.mjs) | a reference runner for the guard vectors, its helpers, and the test server they run against |
| [`schema/`](schema) | JSON Schema (2020-12) for each file above, and for the `--json` output of `slicc browsers` and `playwright-cli list` |

## Install

### Go

```sh
go get github.com/ai-ecoverse/slicc-browsers
```

```go
import sliccbrowsers "github.com/ai-ecoverse/slicc-browsers"

c := sliccbrowsers.Default()
chrome, ok := c.Browser("chrome")
rank := c.Priority("chrome")
```

The files are embedded, so nothing is read from disk at run time.
- `Default()` parses the embedded catalog once and panics if it can't, which CI rules out; `Load()` returns the error instead, and `Parse(b)` reads another copy.
- `Corpus()`, `Protected()`, `Guard()` and `DebuggerStage1()` return the vectors as typed structs.
- `CatalogJSON()`, `CorpusJSON()`, `ProtectedJSON()`, `GuardVectorsJSON()`, `DebuggerStage1JSON()` and the `…SchemaJSON()` functions return the raw files.

### Rust

```toml
[dependencies]
slicc-browsers = { version = "1", features = ["serde"] }

[dev-dependencies]
slicc-browsers = { version = "1", features = ["corpus"] }
```

| feature | adds |
| --- | --- |
| none | `CATALOG` and the schemas as `&str` constants, with no dependencies |
| `serde` | typed `Catalog`, `catalog()`, `Catalog::browser` and `Catalog::priority` |
| `corpus` | the vectors (`CORPUS`, `PROTECTED`, `GUARD_VECTORS`, `DEBUGGER_STAGE1`) and the modules `corpus`, `protected`, `guard` and `debugger_stage1`, for tests |

Every feature builds for `wasm32-wasip1`. Keep `corpus` in `[dev-dependencies]` so it stays out of release builds.

### npm

```sh
npm install @ai-ecoverse/slicc-browsers
```

```js
import catalog from '@ai-ecoverse/slicc-browsers' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';
```

| export | what it is |
| --- | --- |
| `.`, `./catalog.json`, `./corpus.json`, `./protected.json`, `./guard-vectors.json`, `./debugger-stage1.json` | the data |
| `./schema/<name>.schema.json` | the schemas |
| `./protected.mjs` | the protected-origin matcher |
| `./seven.mjs` | `isSevenLabel(seven, label)`: whether a `sliccy.ai` host label can be a seven instance |
| `./guard-runner`, `./guard-driver.mjs` | the guard vector runner and its helpers |
| `./fixture`, `./fixture-client` | the test server (Node only) and a client for a remote one |

Everything except `./fixture` runs in a browser as well as in Node. `protected.mjs` and `seven.mjs` import nothing, so an extension or a service worker can ship either file on its own.

## The catalog

`catalog.json` holds everything a program needs to know about browsers:

- **Browsers.** Chrome, Edge, Brave, Opera, Vivaldi, Arc, Atlas, Dia and their pre-release channels, Chrome for Testing and Chromium, **in priority order**. Each has its macOS bundle, Windows install roots and registry keys, Linux binaries, `.desktop` ids, flatpak and snap names, and its default user-data dir.
- **Electron apps**: known apps by bundle id, and the ones that block remote debugging.
- **Ranking**: endpoints with a seven tab come first, then other running endpoints, then installed Chrome, other installed Chromium browsers, Electron apps, and SLICC six's profile last. Browsers older than Chromium 116 are left out.
- **Discovery**: `DevToolsActivePort` files, the ports to probe, the process scan, and how endpoints are named, normalized and merged.
- **Seven**: which `sliccy.ai` hosts are seven instances, and the switches, disabled features and profile prefs a launch for seven needs.
- **Profiles and platforms**: where SLICC keeps its browser profiles, and the config dirs and registry keys per OS.
- **Protected origins**: see [below](#protected-origins).

The catalog is `"schema": 1`. Minor releases only add fields; changing or removing one takes schema 2 and a major release. slicc-cli keeps no browser tables of its own: to add or change a browser, change `catalog.json`, release, and bump the dependency.

## Discovery

A program lists the browsers it can attach to, from four sources: `DevToolsActivePort` files in known user-data dirs and SLICC profiles, `--cdp` URLs, a probe of ports 9222 to 9229, and the process list. It ranks the endpoints, adds the installed browsers it could launch, and prints the list in the shape of [`schema/browsers.schema.json`](schema/browsers.schema.json). [slicc-cli's README](https://github.com/ai-ecoverse/slicc-cli#slicc-browsers---json---cdp-url---no-bundle-scan) describes that output. Seven's tabs are reported by origin only, never with a path, query or title.

### The process source

The process scan finds browsers that something else started with `--remote-debugging-port`. It reads `ps` on Unix and `Get-CimInstance Win32_Process` on Windows, skips wrappers such as `node`, `npx` or a shell, and takes the port and the `--user-data-dir` from the command line, even when the path has spaces. With port 0 it reads the port from that dir's `DevToolsActivePort`. The exact parsing rules are in `catalog.json`'s `discovery.process` and the corpus's `process-*` cases. Tests always fake the process list.

### SLICC six's profiles

SLICC six, the previous generation, launches Chrome in a profile of its own (`browser-coding-agent-chrome` under six's profile root, or `SLICC_USER_DATA_DIR`). Discovery lists such an endpoint, marks it `six: true` and ranks it last, but **never picks it by itself**. Only an explicit request, such as `slicc --profile six`, uses it. The roots per OS are in `catalog.json`'s `profiles.six`.

## The corpus

Each case in `corpus/<case>/` is a fake machine: a home directory, `DevToolsActivePort` files, fake `/json/version` and `/json/list` answers, a fake process list, `--cdp` URLs and installed browsers. `expected.json` holds the ranked list it must produce. `case.json`'s `needs` say what a program must support to run the case (`process`, `probe`, `six`, `tabs`, …), and a program skips cases it can't run.

For each case, a test harness:
1. writes the case's files into a temporary home;
2. points discovery at that home and the case's environment only;
3. feeds it the fake process list, and routes every HTTP request and TCP dial to the fakes;
4. compares the result with `expected.json`.

Both libraries come with helpers for this:

```go
cases, _ := sliccbrowsers.Corpus()
for _, c := range cases {
    if !c.Runs(runtime.GOOS, sliccbrowsers.NeedFlag, sliccbrowsers.NeedProcess) {
        continue
    }
    l := sliccbrowsers.Layout{OS: runtime.GOOS, Home: t.TempDir(), Getenv: func(k string) string { return c.Input.Env[k] }}
    // write c.Files(l); fake c.PSOutput(l, os.Getpid()); use c.Transport() and c.DialContext;
    // compare with c.ExpectedJSON(l)
}
```

```rust
use slicc_browsers::corpus::{corpus, Layout, NEED_PROCESS, NEED_PROFILES};

let cat = slicc_browsers::catalog();
for case in corpus().cases {
    if !case.runs(os, &[NEED_PROFILES, NEED_PROCESS]) {
        continue;
    }
    let env = |k: &str| case.input.env.get(k).cloned();
    let layout = Layout { os, home, env: &env, catalog: &cat };
    // write case.files(&layout); fake case.ps_output(…); answer with case.http_get(…);
    // compare with case.expected(&layout)
}
```

slicc-cli's `test/integration/corpus_test.go` is a complete harness. The corpus never uses ports 9222 to 9229, where a developer's own Chrome may be listening.

## Protected origins

Browser control must never navigate to, open, attach to, or read the cookies or storage of:
- **seven and the vault**: every `sliccy.ai` host, on any port and scheme, and `vault.sliccy.ai` by name;
- **the browser's own privileged pages**: `chrome://` and the other Chromium browsers' equivalents, `devtools://`, `chrome-extension://` (where password managers and wallets live), `file://`, and Chrome's own UI targets. The new tab page is the one exception;
- **a program's extra seven origins**, such as slicc-cli's `--origin`.

URLs are judged the way the browser parses them, so `blob:`, `view-source:` and `about:` aliases, backslashes, encoded dots and full-width letters can't sneak past. A URL the guard can't parse counts as protected wherever the browser might load it. A tab that seven opened keeps seven's origin when it goes to `about:blank`. A refused call fails with `slicc: refused: target is on seven's origin`.

A browser extension's frame inside an ordinary page, such as a password manager's autofill list, doesn't make the tab protected. The frame itself stays out of reach: it can't be attached or read, and its URL never appears in target discovery, page reads, snapshots, accessibility trees or evaluate results. The tab's own page can still be read and snapshotted. Screenshots and input are allowed only while every extension frame is hidden (no layout box or `visibility: hidden`) and none holds focus through nested documents or shadow roots; a screenshot taken while one became shown is thrown away. Opacity and position don't count as hidden. A race between the visibility or focus check and the CDP reply is accepted. Whole-page captures and starting a screencast are refused while any extension frame is in the tab. If a screencast is already running when an extension frame appears, the guard stops it or drops every later `Page.screencastFrame` until the frame is gone; refusing `Page.startScreencast` on a clean tab is also fine. These refusals name the extension frame, not seven. A frame from the program's own extension, and any other protected frame, still makes the whole tab protected. `protectedOrigins.extensionFrames` lists the schemes, the methods and the refusals, and `protected.mjs` offers `extensionFrame(url)`.

`catalog.json`'s `protectedOrigins` holds the rules, and `protected.json` the vectors: URLs, targets, cookie domains and storage keys, each with the expected answer. `protected.mjs` is the reference implementation:

```js
import catalog from '@ai-ecoverse/slicc-browsers' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

const guard = protectedOrigins(catalog.protectedOrigins, ['http://127.0.0.1:5710']);
guard.url('https://seven.sliccy.ai/');
guard.cookieDomain('.sliccy.ai');
guard.target({ url: 'about:blank', opener: 'protected' });
```

It also offers `storageKey(key)` and `unparseable(text)`. A Go or Rust implementation needs a WHATWG URL parser, not `net/url`, and must pass every vector in `protected.json`.

## Guard vectors

A guard sits between a CDP client and the browser and keeps the client away from protected origins. `guard-vectors.json` holds the attacks every guard must pass: navigation, redirects, popups, frames, interception, cookies, storage, privileged and error pages, foreign worlds, debugger tricks and session overrides.

Each vector runs twice. The **control** runs against an ordinary origin and must work. The **guarded** leg runs through the guard against a protected target and must be refused or have no effect. A **liveness** check outside the guard proves the target was really there. All three must pass.

A guard may refuse every client navigation to an `about:` URL that inherits an origin, such as `about:blank`. Refusing an ordinary navigation away from a protected page still fails.

### What a guard must let through

For stock Playwright, Puppeteer and raw CDP clients, a guard that declares `stockSetup` admits on ordinary pages:
- `Page.addScriptToEvaluateOnNewDocument` whose `source` matches `^(?:[ \t\n]|//[^\n\r\u2028\u2029]*)*$` on the whole string without the multiline flag (no code), with any `worldName` or `runImmediately`, and its removal;
- exactly `Emulation.setFocusEmulationEnabled`, `setEmulatedMedia`, `setDeviceMetricsOverride` and `setTouchEmulationEnabled`;
- `Page.createIsolatedWorld` on a frame the guard already classifies as ordinary: strip `grantUniveralAccess` and `contentSecurityPolicy`, return no `executionContextId` for any other frame; `Runtime.addBinding` scoped to such a world by a non-empty `executionContextName` or its `executionContextId`, with `Runtime.bindingCalled` only from those worlds;
- `Target.setAutoAttach`: either narrow the filter to tab targets or hide per target; no protected-origin page, iframe or worker (dedicated, shared or service) may reach the client; pages under the tab are held like pages (same URL redaction in `targetInfo`); a transport that synthesizes it declares `syntheticAutoAttach`.

The strip holds whether or not a given Chrome lets that world reach another origin. Code init scripts, main-world bindings and other overrides stay refused or harmless. Admitted display overrides and no-code init scripts must not remain in effect on a protected document — refuse that navigation, or clear them before it runs. Undeclared, they skip, never pass.

### Running them

The reference runner works with any guard that speaks CDP:

```js
import set from '@ai-ecoverse/slicc-browsers/guard-vectors.json' with { type: 'json' };
import { run } from '@ai-ecoverse/slicc-browsers/guard-runner';
import { fixtureServer } from '@ai-ecoverse/slicc-browsers/fixture';

const fixture = await fixtureServer();
const execution = await run(set, {
  clientFactory: (row) => connectGuardAndObserver(row),
  targets: originsFor(fixture),
  capabilities: { autoAttach: true, browserSession: true, browserContexts: true, discovery: true },
  parallel: 4,
  fixture,
});
console.log(execution.summary({ guard: 'my-guard', sha: process.env.GITHUB_SHA }).line);
await fixture.close();
```

You supply:
- **a guarded client** per row: your guard's CDP connection, with `send(method, params, sessionId)`, `waitEvent(predicate, ms)` and an `events` array;
- **an unguarded observer**: a direct CDP connection to the same browser, which runs the controls and checks liveness;
- **origins**: the fixture server reachable as seven, the vault and an ordinary site. Point the protected hostnames at it with Chrome's `--host-resolver-rules`, so tests never touch the real seven;
- **capabilities**: what your transport can do. A row that needs something you don't declare is skipped as `not-supported:<capability>`.

| capability | means the transport can |
| --- | --- |
| `autoAttach` | auto-attach to child targets such as popups and iframes |
| `browserSession` | send commands on the browser session, not only a page |
| `browserContexts` | create isolated browser contexts |
| `discovery` | report target create/change without a session |
| `chromeUrlsAttach` | attach to `chrome://` pages (DevTools-port CDP; not `chrome.debugger`) |
| `extensionWorld` | host a foreign extension content script on the test page |
| `extensionFrame` | host the harness extension frame an ordinary test page embeds |
| `clientExit` | close the guarded client mid-row |
| `siteIsolationOff`, `inboundDelay`, `forwardAudit` | no site isolation; hold inbound; audit forwarded commands |
| `secureOrigin` | HTTPS origins (service workers) |
| `stockSetup`, `syntheticAutoAttach` | admit stock clients' setup calls; synthesize auto-attach |
| `closeProtected` | close a protected tab, except live vault/seven-UI disguises |

### Reading the result

Each row reports `control`, `guarded` and `live` as `pass`, `fail`, `skip`, `incomplete` (evidence missing) or `not-run` (words only). `summary()` makes one line:

```text
GUARD-PASS my-guard@1a2b3c4 (vectors @ai-ecoverse/slicc-browsers@1.18.5)
```

The run passes only when every row passes and none is missing. A skip with a reason the runner would never give is forged; skipped and incomplete rows are counted on the line, so it can't overstate what was tested.

To find out what a vector checks, read it in `guard-vectors.json`: each one lists its steps, each observation's `means`, its `live` condition and its expected outcome. [`schema/guard-vectors.schema.json`](schema/guard-vectors.schema.json) defines the format.

## Development

You need Go 1.26, Rust stable with `wasm32-wasip1`, Node 24+, and Chrome or Chromium for the browser tests: they take `CHROME_PATH`, or Chrome for Testing from `npx slicc-cdp install-browser`, and run headless unless `CI` is set (`SLICC_HEADLESS=1` or `0` overrides).

| command | what it does |
| --- | --- |
| `npm run corpus` | rebuilds `corpus.json` from `corpus/` |
| `npm run validate` | checks every file against its schema and the rules a schema can't express, and runs `protected.json` through `protected.mjs` |
| `npm run lint` | Biome, the slicc lint rules, `gofmt`, `go vet` for Linux, macOS and Windows, golangci-lint, `cargo fmt`, clippy and a `wasm32-wasip1` check of each feature |
| `npm test` | every file in `test/integration/`: validation, the Node, Go and Rust tests, and the reference runner against real Chromium with no guard, where every control must pass and every protection must fail |
| `npm run build` | the Go module, the crate (also for `wasm32-wasip1`), and the npm package |

A new discovery behaviour gets a corpus case, and a new guard behaviour gets a guard vector.

## CI and releases

CI is [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline), called from `.github/workflows/ci.yml`. A pull request gets lint, then `npm test` split over shards by timing, then a Claude and a Codex review; the merge queue runs lint and the tests again. Tests run on Linux only.

Every merge to `main` that warrants it is released by semantic-release as one version for all three packages. Pushed tags are never moved or deleted: a bad release is fixed by the next one.

## License

[Apache-2.0](LICENSE)
