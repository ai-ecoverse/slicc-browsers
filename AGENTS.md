# slicc-browsers

Shared browser data for slicc-cli (Go), slicc-cdp (Rust, also wasm32-wasip1), slicc-agent and the CDP guards: `catalog.json`, the discovery corpus in `corpus/<case>/` (bundled by `npm run corpus`), the protected-origin vectors (`protected.json`, `protected.mjs`), the guard vectors (`guard-vectors.json`) and their runner, and `schema/`. One version for the Go module, the Rust crate (`src/`) and the npm package.

README.md is for users: what this is and how to use it, under 20,000 characters. It is not the spec and never documents single rows, probes or timeouts: the schemas, data files and tests are.

No comments in any file except Go directives and `# renovate:` annotations. No CLAUDE.md. Tests live in `test/integration/`. `npm run validate`, `lint`, `test` and `build` must pass. Never use ports 9222-9229 in the corpus or tests; fake the process list. Releases come from `main` via semantic-release; never move or delete a pushed tag, fix forward instead.
