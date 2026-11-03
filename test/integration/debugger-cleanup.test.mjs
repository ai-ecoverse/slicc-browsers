import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  debuggerCleanup,
  debuggerPaused,
  idleDebuggerCleanup,
  isRefusal,
  outcome,
} from '../../guard-driver.mjs';

const source = await readFile(new URL('../../guard-runner.mjs', import.meta.url), 'utf8');
const cdpStart = source.indexOf('  async cdp(step, sessionId');
const cdpEnd = source.indexOf('\n  async seedContext', cdpStart);
const recordStart = source.indexOf('  record(step, out, session, phase, gone)');
const recordEnd = source.indexOf('\n  async execute', recordStart);
assert.ok(cdpStart >= 0 && cdpEnd > cdpStart && recordStart >= 0 && recordEnd > recordStart);
const methods = new Function(
  'debuggerCleanup',
  'debuggerPaused',
  'idleDebuggerCleanup',
  'outcome',
  'supported',
  'sleep',
  'refusedOut',
  'exitsClient',
  `return { ${source.slice(cdpStart, cdpEnd)}, ${source.slice(recordStart, recordEnd)} };`
)(
  debuggerCleanup,
  debuggerPaused,
  idleDebuggerCleanup,
  outcome,
  () => false,
  async () => {},
  (step, out) => isRefusal(out, step),
  () => false
);
const step = {
  cdp: 'Debugger.resume',
  refusable: true,
  refusal: { name: 'refused.7', match: 'refused' },
};
const idle = 'Can only perform operation while paused.';

function lane(id, events, error) {
  const calls = [];
  const execution = {
    vector: { id },
    client: { events },
    eventStart: 0,
    options: {},
    vars: {},
    trace: [],
    refused: {},
    incomplete: [],
    errors: [],
    calls: {},
    actor: () => ({
      send: async (method, params, session) => {
        calls.push({ method, params, session });
        if (error) throw new Error(error);
        return {};
      },
    }),
  };
  return { execution, calls };
}

for (const id of ['E4.instrumentation', 'E4.event-listener']) {
  test(`${id} skips only its trigger cleanup when the lane never paused`, async () => {
    const { execution, calls } = lane(
      id,
      [{ method: 'Debugger.paused', sessionId: 'other' }],
      idle
    );
    const out = await methods.cdp.call(execution, step, 'session', 'trigger');
    methods.record.call(execution, step, out, 'session', 'trigger', false);
    assert.equal(calls.length, 0);
    assert.equal(out.result.cleanup, 'never paused');
    assert.deepEqual(execution.errors, []);
    assert.equal(execution.refused['refused.7'], false);
  });

  test(`${id} accepts only Chrome's exact idle error at cleanup after a real lane pause`, async () => {
    for (const error of [
      idle,
      `${idle} `,
      'socket closed',
      'slicc: refused: protected document',
      undefined,
    ]) {
      const { execution, calls } = lane(
        id,
        [{ method: 'Debugger.paused', sessionId: 'session' }],
        error
      );
      const out = await methods.cdp.call(execution, step, 'session', 'trigger');
      methods.record.call(execution, step, out, 'session', 'trigger', false);
      assert.equal(calls.length, 1);
      assert.equal(
        execution.errors.length,
        error === `${idle} ` || error === 'socket closed' ? 1 : 0
      );
      assert.equal(execution.refused['refused.7'], error?.startsWith('slicc: refused:') ?? false);
      assert.equal(out.ok, error === undefined);
    }
  });
}

test('other vectors, setup and non-resume failures keep their original error accounting', async () => {
  for (const [id, phase, command] of [
    ['E4', 'trigger', 'Debugger.resume'],
    ['E4.instrumentation', 'setup', 'Debugger.resume'],
    ['E4.event-listener', 'trigger', 'Debugger.disable'],
  ]) {
    const { execution, calls } = lane(id, [], idle);
    const declaration = { ...step, cdp: command };
    const out = await methods.cdp.call(execution, declaration, 'session', phase);
    methods.record.call(execution, declaration, out, 'session', phase, false);
    assert.equal(calls.length, 1);
    assert.equal(execution.errors.length, 1);
  }
});
