import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the Go module builds without cgo and its tests pass under the race detector', () => {
  const build = spawnSync('go', ['build', './...'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
  });
  assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
  const run = spawnSync('go', ['test', '-race', '-count=1', '-json', './test/integration/...'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const events = run.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((event) => event.Test && !event.Test.includes('/'));
  const failed = events.filter((event) => event.Action === 'fail').map((event) => event.Test);
  const passed = events.filter((event) => event.Action === 'pass').length;
  assert.equal(run.status, 0, `${run.stderr}${run.stdout.slice(-20000)}`);
  assert.deepEqual(failed, []);
  assert.ok(passed > 0, 'no Go test ran');
});
