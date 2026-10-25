import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, matchesGlob } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFile(join(root, path), 'utf8');
const ci = await read('.github/workflows/ci.yml');
const pkg = JSON.parse(await read('package.json'));
const release = JSON.parse(await read('.releaserc.json'));
const pipeline = ci.split('\n  released:\n')[0];
const input = (name) => pipeline.match(new RegExp(`\\n {6}${name}: (.+)\\n`))?.[1];
const block = (name) =>
  pipeline.match(new RegExp(`\\n {6}${name}: \\|\\n((?: {8}.*\\n|\\n)+)`))?.[1] ?? '';
const job = (name) => ci.match(new RegExp(`\\n {2}${name}:\\n((?: {4}.*\\n|\\n)+)`))?.[1] ?? '';

test('CI is one caller of slicc-shared-web pipeline.yml, at the version of the devDependency', async () => {
  assert.deepEqual(await readdir(join(root, '.github')), ['workflows']);
  assert.deepEqual(await readdir(join(root, '.github/workflows')), ['ci.yml']);
  const version = pkg.devDependencies['@ai-ecoverse/slicc-shared-web'];
  assert.match(version, /^2\.\d+\.\d+$/);
  assert.match(
    ci,
    new RegExp(
      `\\njobs:\\n {2}ci:\\n {4}uses: ai-ecoverse/slicc-shared-web/\\.github/workflows/pipeline\\.yml@v${version.replaceAll('.', '\\.')}\\n {4}secrets: inherit\\n {4}with:\\n`
    )
  );
  assert.equal(ci.match(/uses: ai-ecoverse\/slicc-shared-web\//g).length, 1);
  assert.deepEqual(ci.split('\njobs:\n')[1].match(/^ {2}[a-z-]+:$/gm), [
    '  ci:',
    '  released:',
    '  crates:',
    '  go:',
  ]);
});

test('CI runs on pull requests, merge groups and pushes to main with the pipeline permissions, and cancels only a superseded pull request run', () => {
  const head = ci.split('\njobs:\n')[0];
  assert.match(
    head,
    /\non:\n {2}pull_request:\n {2}merge_group:\n {2}push:\n {4}branches: \[main\]\n\n/
  );
  assert.match(
    head,
    /\nconcurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/
  );
  assert.deepEqual(
    head
      .match(/\npermissions:\n((?: {2}.*\n)+)/)[1]
      .trim()
      .split(/\n\s*/)
      .sort(),
    [
      'actions: read',
      'attestations: write',
      'contents: write',
      'id-token: write',
      'issues: write',
      'pull-requests: write',
      'statuses: write',
    ]
  );
  assert.doesNotMatch(
    ci,
    /workflow_dispatch|schedule:|workflow_run|inputs\.|vars\.|CERT_|\bcert[-:]/
  );
});

test('the pipeline runs on its own runners with the repo lint, and nothing after its release', () => {
  for (const name of [
    'runs-on',
    'node-version',
    'test',
    'after-release',
    'release-secrets',
    'deploy',
    'node-options',
    'require-tests',
  ])
    assert.equal(input(name), undefined, name);
  assert.doesNotMatch(pipeline, /runs-on/);
  assert.equal(input('shards'), '4');
  assert.equal(input('timeout-minutes'), '30');
  assert.equal(pkg.engines.node, '>=24');
  const lint = block('lint');
  assert.match(
    lint,
    /# renovate: datasource=github-releases depName=golangci\/golangci-lint\n {8}GOLANGCI_LINT=v\d+\.\d+\.\d+\n/
  );
  assert.match(lint, /--target wasm32-wasip1/);
  assert.match(lint, /npm run lint\n$/);
  assert.match(pkg.scripts.lint, /GOOS=darwin go vet \.\/\.\.\. && GOOS=windows go vet \.\/\.\.\./);
  for (const features of ['--no-default-features', '--features serde', '--all-features'])
    assert.ok(
      pkg.scripts.lint.includes(`cargo check --target wasm32-wasip1 ${features}`),
      features
    );
  assert.match(block('review-prompt'), /^ {8}SLICC-BROWSERS\n/);
});

test('npm test runs every test-glob file in exactly one node --test call, so the shards split them all', () => {
  assert.equal(input('test-glob'), 'test/integration/*.test.mjs');
  assert.doesNotMatch(pkg.scripts.test, /NODE_OPTIONS|npm run/);
  const calls = pkg.scripts.test.split(' && ').filter((part) => part.startsWith('node --test '));
  assert.equal(calls.length, 2);
  const named = calls.flatMap((call) =>
    call.split(' ').filter((word) => word.endsWith('.test.mjs'))
  );
  assert.equal(new Set(named).size, named.length, 'a file is named twice');
  const files = globSync(input('test-glob'), { cwd: root }).sort();
  assert.deepEqual([...named].sort(), files);
  assert.ok(files.includes('test/integration/go.test.mjs'));
  assert.ok(files.includes('test/integration/cargo.test.mjs'));
  assert.ok(files.includes('test/integration/validate.test.mjs'));
  for (const name of ['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core'])
    assert.equal(pkg.devDependencies[name], undefined, name);
  assert.match(pkg.devDependencies['@ai-ecoverse/slicc-cdp'], /^\d+\.\d+\.\d+$/);
  for (const name of Object.keys(pkg.scripts)) assert.doesNotMatch(name, /^test:(guard|gates)/);
});

test('every integration test file but chromium-launch, gates and workflows is a strict row for the flaky hunter, which keeps the default globs and its default retry', () => {
  assert.equal(input('flaky-retry'), undefined);
  const strict = block('strict-tests')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(strict.includes('**/*guard*.test.*'));
  assert.ok(strict.includes('**/*security*.test.*'));
  const files = globSync(input('test-glob'), { cwd: root }).sort();
  assert.ok(files.includes('test/integration/guard-runner.test.mjs'));
  assert.deepEqual(
    files.filter((file) => !strict.some((glob) => matchesGlob(file, glob))),
    [
      'test/integration/chromium-launch.test.mjs',
      'test/integration/gates.test.mjs',
      'test/integration/workflows.test.mjs',
    ]
  );
});

test('semantic-release cuts versions from main alone and publishes npm from ci.yml with provenance', () => {
  assert.deepEqual(release.branches, ['main']);
  assert.equal(release.tagFormat, 'v${version}');
  assert.deepEqual(release.plugins, [
    '@semantic-release/commit-analyzer',
    './scripts/major-guard.mjs',
    '@semantic-release/release-notes-generator',
    '@semantic-release/npm',
    '@semantic-release/github',
  ]);
  assert.equal(pkg.fledgling.workflow, 'ci.yml');
  assert.equal(pkg.fledgling.repo, 'ai-ecoverse/slicc-browsers');
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true });
  assert.equal(pkg.version, '0.0.0');
});

test('npm publish stamps the release version into Cargo.toml and guard-vectors.json, and never publishes 0.0.0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-browsers-stamp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  for (const file of ['Cargo.toml', 'guard-vectors.json', 'scripts/set-crate-version.mjs'])
    cpSync(join(root, file), join(dir, file));
  const stamp = (version) => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'stamp',
        version,
        scripts: { prepublishOnly: pkg.scripts.prepublishOnly },
      })
    );
    return spawnSync('npm', ['run', '--silent', 'prepublishOnly'], { cwd: dir, encoding: 'utf8' });
  };
  const refused = stamp('0.0.0');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to stamp crate version "0\.0\.0"/);
  const stamped = stamp('1.42.7');
  assert.equal(stamped.status, 0, stamped.stderr);
  assert.match(readFileSync(join(dir, 'Cargo.toml'), 'utf8'), /^version = "1\.42\.7"$/m);
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'guard-vectors.json'), 'utf8')).setVersion,
    '1.42.7'
  );
});

test('the crate and the Go module follow only a new release tag on main', () => {
  assert.match(job('released'), /needs: ci\n/);
  assert.match(
    job('released'),
    /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n/
  );
  assert.match(job('released'), /git tag --points-at HEAD --list 'v\*'/);
  for (const name of ['crates', 'go']) {
    assert.match(job(name), /needs: released\n/, name);
    assert.match(job(name), /if: needs\.released\.outputs\.version != ''\n/, name);
  }
  for (const name of ['released', 'crates', 'go'])
    assert.match(job(name), /\n {4}permissions:\n/, name);
  assert.match(job('crates'), /id-token: write/);
  assert.match(job('crates'), /uses: rust-lang\/crates-io-auth-action@/);
  assert.match(
    job('crates'),
    /node scripts\/set-crate-version\.mjs "\$VERSION"\n(?: {10}.*\n)* {10}if cargo publish --allow-dirty /
  );
  assert.match(
    job('go'),
    /GOPROXY=https:\/\/proxy\.golang\.org GOFLAGS=-mod=mod go list -m "\$MODULE@\$TAG"/
  );
  assert.match(job('go'), /https:\/\/pkg\.go\.dev\/fetch\/\$MODULE@\$TAG/);
  assert.doesNotMatch(job('go'), /id-token|contents: write/);
});

test('the crates job takes only the crates.io 429 for too many versions of the crate in 24 hours as a warning, and fails on every other publish error', (t) => {
  const step = job('crates')
    .split(/\n {6}- /)
    .find((part) => part.includes('cargo publish'));
  assert.doesNotMatch(step, /\n {8}shell:/);
  const script = step.match(/\n {8}run: \|\n((?: {10}.*\n|\n)+)/)[1].replace(/^ {10}/gm, '');
  const dir = mkdtempSync(join(tmpdir(), 'slicc-browsers-crates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  cpSync(join(root, 'scripts/set-crate-version.mjs'), join(dir, 'scripts/set-crate-version.mjs'));
  writeFileSync(join(dir, 'step.sh'), script);
  writeFileSync(
    join(dir, 'bin', 'cargo'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CARGO_ARGS"\nprintf \'%s\\n\' "$CARGO_OUT" >&2\nexit "$CARGO_STATUS"\n',
    { mode: 0o755 }
  );
  const publish = (status, out, version = '1.42.7') => {
    for (const file of ['Cargo.toml', 'guard-vectors.json'])
      cpSync(join(root, file), join(dir, file));
    const run = spawnSync('bash', ['-e', 'step.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
        VERSION: version,
        CARGO_ARGS: join(dir, 'cargo-args'),
        CARGO_STATUS: String(status),
        CARGO_OUT: out,
      },
    });
    return { ...run, output: run.stdout + run.stderr };
  };
  const failed = (status, cause) =>
    `    Uploading slicc-browsers v1.42.7 (${dir})\nerror: failed to publish slicc-browsers v1.42.7 to registry at https://crates.io\n\nCaused by:\n  the remote server responded with an error (status ${status}): ${cause}`;
  const daily = 'You have published too many versions of this crate in the last 24 hours';
  const warning =
    '::warning::slicc-browsers 1.42.7 is skipped on crates.io: 429, too many versions of this crate in the last 24 hours; the next release publishes the newest crate';

  const published = publish(0, '    Published slicc-browsers v1.42.7 at registry `crates-io`');
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.output, /Published slicc-browsers v1\.42\.7/);
  assert.doesNotMatch(published.output, /::warning::/);
  assert.match(readFileSync(join(dir, 'Cargo.toml'), 'utf8'), /^version = "1\.42\.7"$/m);
  assert.equal(readFileSync(join(dir, 'cargo-args'), 'utf8'), 'publish --allow-dirty\n');

  const limited = publish(101, failed('429 Too Many Requests', daily));
  assert.equal(limited.status, 0, limited.stderr);
  assert.ok(limited.output.includes(failed('429 Too Many Requests', daily)));
  assert.equal(limited.stdout.trimEnd().split('\n').at(-1), warning);

  for (const out of [
    failed(
      '429 Too Many Requests',
      'You have published too many updates to existing crates in a short period of time'
    ),
    failed(
      '429 Too Many Requests',
      'You have published too many new crates in a short period of time'
    ),
    failed('500 Internal Server Error', daily),
    failed('403 Forbidden', "this crate exists but you don't seem to be an owner"),
    `error: failed to verify package tarball\n${daily}`,
  ]) {
    const refused = publish(101, out);
    assert.notEqual(refused.status, 0, out);
    assert.ok(refused.output.includes(out), out);
    assert.doesNotMatch(refused.output, /::warning::/, out);
  }

  const stamped = publish(0, '', '0.0.0');
  assert.notEqual(stamped.status, 0);
  assert.match(stamped.stderr, /refusing to stamp crate version "0\.0\.0"/);
  assert.equal(readFileSync(join(dir, 'cargo-args'), 'utf8').trimEnd().split('\n').length, 7);
});

test('the workflow has no comments but renovate annotations', () => {
  for (const line of ci.split('\n')) if (/^\s*#/.test(line)) assert.match(line, /^\s*# renovate: /);
});
