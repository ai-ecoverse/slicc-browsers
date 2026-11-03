import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { judge } from '../../guard-driver.mjs';

const { vectors } = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url))
);
const rows = vectors.filter(({ id }) =>
  ['E4', 'E4.instrumentation', 'E4.event-listener'].includes(id)
);

test('E4 stronger early refusal never skips a protected assertion', () => {
  for (const vector of rows) {
    const observed = {
      'refused.2': true,
      'refused.3': true,
      condition: false,
      paused: false,
      served: true,
    };
    const result = judge(vector, 'guarded', observed);
    assert.equal(result.pass, true, vector.id);
    assert.deepEqual(result.skipped, [], vector.id);
    assert.equal(judge(vector, 'guarded', { ...observed, paused: true }).pass, false, vector.id);
    const missing = { ...observed };
    delete missing.paused;
    assert.equal(judge(vector, 'guarded', missing).pass, false, vector.id);
    if (vector.id === 'E4')
      assert.equal(judge(vector, 'guarded', { ...observed, condition: true }).pass, false);
  }
});

test('E4 raw control cannot pass with guarded refusal or converted pause substituted', () => {
  for (const vector of rows) {
    assert.equal(
      judge(vector, 'control', {
        condition: true,
        paused: true,
        admissionRefused: false,
        convertedPause: false,
      }).pass,
      true,
      vector.id
    );
    const guarded = {
      condition: false,
      paused: false,
      admissionRefused: true,
      convertedPause: true,
    };
    assert.equal(judge(vector, 'control', guarded).pass, false, vector.id);
  }
});
