import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the crate tests pass with every feature on the locked dependencies', () => {
  const run = spawnSync('cargo', ['test', '--locked', '--all-features'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 0, output.slice(-20000));
  const passed = [...output.matchAll(/^test result: ok\. (\d+) passed; 0 failed/gm)].reduce(
    (sum, match) => sum + Number(match[1]),
    0
  );
  assert.ok(passed > 0, 'no Rust test ran');
  assert.doesNotMatch(output, /^test result: FAILED/m);
});
