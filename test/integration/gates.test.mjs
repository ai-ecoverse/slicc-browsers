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
