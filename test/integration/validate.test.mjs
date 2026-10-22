import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const node = (...args) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });

test('every data file passes its schema and the rules a schema cannot express', () => {
  const run = node('scripts/validate.mjs');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^validate: PASS catalog\.json \(\d+ browsers\), \d+ corpus cases, /m);
});

test('corpus.json is the bundle of corpus/', () => {
  const run = node('scripts/corpus.mjs', '--check');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^corpus: PASS \d+ cases\n$/);
});
