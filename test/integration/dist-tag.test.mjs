import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/dist-tag.mjs', import.meta.url));

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const cases = [
  ['1.14.1', 'refs/heads/main', '1.14.0', 'latest'],
  ['1.15.0', 'refs/heads/main', '', 'latest'],
  ['1.13.3', 'refs/heads/1.13.x', '1.14.0', 'release-1.13.x'],
  ['1.13.4', 'refs/heads/1.13.x', '1.13.3', 'release-1.13.x'],
  ['1.13.3', 'refs/heads/main', '1.14.0', 'release-1.13.x'],
];

for (const [version, ref, latest, want] of cases) {
  test(`${version} from ${ref} with latest ${latest || 'unset'} publishes to ${want}`, () => {
    const result = run(version, ref, latest);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${want}\n`);
  });
}

test('a version that is not X.Y.Z fails', () => {
  const result = run('v1.13.3', 'refs/heads/1.13.x', '1.14.0');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /dist-tag: version "v1\.13\.3" is not X\.Y\.Z/);
});
