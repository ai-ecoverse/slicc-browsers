import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const shim = fileURLToPath(new URL('../../scripts/git-retry.mjs', import.meta.url));

function fakeGit(t, failures) {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-browsers-git-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const git = join(dir, 'git');
  writeFileSync(
    git,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nn=$(wc -l < '${calls}')\nif [ "$n" -le ${failures} ]; then echo ' ! [remote rejected] (failed)' >&2; exit 1; fi\necho ok\n`
  );
  chmodSync(git, 0o755);
  const run = (args, env = { REAL_GIT: git }) =>
    spawnSync(process.execPath, [shim, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GIT_RETRY_DELAY_MS: '1', ...env },
    });
  const count = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).length;
  return { run, count };
}

const notes = [
  'push',
  '--',
  'https://example.invalid/repo.git',
  'refs/notes/semantic-release-v1.2.3',
];

test('a rejected notes push is retried until it lands', (t) => {
  const { run, count } = fakeGit(t, 2);
  const result = run(notes);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(count(), 3);
  assert.match(result.stdout, /ok/);
  assert.match(result.stderr, /attempt 2 of 5/);
});

test('a notes push that keeps failing fails after five attempts', (t) => {
  const { run, count } = fakeGit(t, 99);
  const result = run(notes);
  assert.equal(result.status, 1);
  assert.equal(count(), 5);
});

test('other git commands run once and keep their status', (t) => {
  const failing = fakeGit(t, 99);
  const tags = failing.run(['push', '--tags', '--', 'https://example.invalid/repo.git']);
  assert.equal(tags.status, 1);
  assert.equal(failing.count(), 1);
  const passing = fakeGit(t, 0);
  const status = passing.run(['status']);
  assert.equal(status.status, 0);
  assert.equal(passing.count(), 1);
});

test('without REAL_GIT or with a missing git it fails', (t) => {
  const { run } = fakeGit(t, 0);
  assert.equal(run(notes, {}).status, 1);
  const missing = run(['status'], { REAL_GIT: join(tmpdir(), 'slicc-browsers-no-git') });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /git-retry: /);
});
