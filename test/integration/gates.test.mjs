import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const gate = join(root, 'scripts/gate.mjs');
const node = (args, cwd = root) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });

function linked(t) {
  const base = mkdtempSync(join(tmpdir(), 'slicc-browsers-gates-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = join(base, 'real');
  for (const part of ['scripts', 'corpus', 'corpus.json', 'go.mod', 'package.json'])
    cpSync(join(root, part), join(real, part), { recursive: true });
  const link = join(base, 'link');
  symlinkSync(real, link, 'dir');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  symlinkSync(join(real, 'scripts', 'corpus.mjs'), join(bin, 'corpus'));
  symlinkSync(join(real, 'scripts', 'major-guard.mjs'), join(bin, 'major-guard'));
  return { real, link, bin };
}

test('corpus --check runs through a symlinked checkout and a symlinked script', (t) => {
  const { real, link, bin } = linked(t);
  for (const script of [join(link, 'scripts', 'corpus.mjs'), join(bin, 'corpus')]) {
    const fresh = node([script, '--check'], link);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /^corpus: PASS \d+ cases\n$/);
  }
  const corpus = join(real, 'corpus.json');
  writeFileSync(corpus, readFileSync(corpus, 'utf8').replace('"schema": 1', '"schema": 1 '));
  for (const script of [join(link, 'scripts', 'corpus.mjs'), join(bin, 'corpus')]) {
    const stale = node([script, '--check'], link);
    assert.equal(stale.status, 1, stale.stdout);
    assert.equal(stale.stderr, 'corpus.json is out of date; run npm run corpus\n');
  }
});

test('major-guard runs through a symlinked checkout and a symlinked script', (t) => {
  const { link, bin } = linked(t);
  for (const script of [join(link, 'scripts', 'major-guard.mjs'), join(bin, 'major-guard')]) {
    const fits = node([script, '1.7.9'], link);
    assert.equal(fits.status, 0, fits.stderr);
    assert.match(fits.stdout, /^major-guard: PASS v1\.7\.9 fits \S+\n$/);
    const wrong = node([script, '2.0.0'], link);
    assert.equal(wrong.status, 1, wrong.stdout);
    assert.match(
      wrong.stderr,
      /^major-guard: v2\.0\.0 needs module path \S+\/v2, go\.mod declares /
    );
  }
});

test('a gate fails a command that is silent, exits early or fails, and passes its verdict', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'slicc-browsers-gate-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const script = (name, body) => {
    const file = join(base, `${name}.mjs`);
    writeFileSync(file, body);
    return file;
  };
  const expect = ['--expect', '^check: PASS \\d+ items$', '--'];
  const silent = node([gate, ...expect, process.execPath, script('silent', '')]);
  assert.equal(silent.status, 1);
  assert.match(silent.stderr, /gate: FAIL no line matching/);
  const early = node([
    gate,
    ...expect,
    process.execPath,
    script('early', "process.stdout.write('check: starting\\n'); process.exit(0);"),
  ]);
  assert.equal(early.status, 1);
  const failed = node([
    gate,
    ...expect,
    process.execPath,
    script('failed', "process.stdout.write('check: PASS 3 items\\n'); process.exit(4);"),
  ]);
  assert.equal(failed.status, 4);
  assert.match(failed.stderr, /exited 4/);
  const passed = node([
    gate,
    ...expect,
    process.execPath,
    script('passed', "process.stdout.write('check: PASS 3 items\\n');"),
  ]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, 'check: PASS 3 items\n');
  const log = join(base, 'release.log');
  writeFileSync(log, '[semantic-release] › ℹ  major-guard: PASS v1.7.9 fits example\n');
  const found = node([gate, '--expect', 'major-guard: PASS v1\\.7\\.9 fits ', '--in', log]);
  assert.equal(found.status, 0, found.stderr);
  writeFileSync(log, '');
  const empty = node([gate, '--expect', 'major-guard: PASS v1\\.7\\.9 fits ', '--in', log]);
  assert.equal(empty.status, 1);
  const absent = node([gate, '--expect', 'x', '--in', join(base, 'missing.log')]);
  assert.equal(absent.status, 1);
});

test('the real gates print their verdict lines', () => {
  const validate = node([
    gate,
    '--expect',
    '^validate: PASS ',
    '--',
    process.execPath,
    'scripts/validate.mjs',
  ]);
  assert.equal(validate.status, 0, validate.stderr);
  const corpus = node([
    gate,
    '--expect',
    '^corpus: PASS [0-9]+ cases$',
    '--',
    process.execPath,
    'scripts/corpus.mjs',
    '--check',
  ]);
  assert.equal(corpus.status, 0, corpus.stderr);
});
