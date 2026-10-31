import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const vectors = JSON.parse(await readFile(new URL('../../debugger-stage1.json', import.meta.url)));
const ordinary = [
  'Debugger.enable',
  'Debugger.disable',
  'Debugger.resume',
  'Debugger.setInstrumentationBreakpoint',
  'Debugger.removeBreakpoint',
];

test('Stage1 is exactly the five-method subset and preserves distinct lifetimes', () => {
  assert.equal(vectors.schemaVersion, 1);
  assert.deepEqual(
    vectors.methods.filter((item) => item.admitted).map((item) => item.method),
    ordinary
  );
  assert.equal(new Set(vectors.methods.map((item) => item.method)).size, vectors.methods.length);
  assert.equal(
    vectors.methods.find((item) => item.method === 'Debugger.setInstrumentationBreakpoint')
      .lifetime,
    'persistent'
  );
  assert.equal(
    vectors.methods.find((item) => item.method === 'Debugger.getScriptSource').lifetime,
    'document'
  );
  assert.equal(
    vectors.methods.find((item) => item.method === 'Debugger.removeBreakpoint').lifetime,
    'cleanup'
  );
  const pause = vectors.methods.find((item) => item.method === 'Debugger.pause');
  assert.equal(pause.admitted, false);
  assert.equal(pause.ownedInstrumentationOnly, true);
  for (const method of [
    'Debugger.getScriptSource',
    'Debugger.evaluateOnCallFrame',
    'Debugger.setBreakpoint',
    'DOMDebugger.setEventListenerBreakpoint',
    'EventBreakpoints.setInstrumentationBreakpoint',
    'Page.addScriptToEvaluateOnNewDocument',
    'Runtime.addBinding',
    'Debugger.stage1Unknown',
  ])
    assert.equal(vectors.methods.find((item) => item.method === method).admitted, false, method);
});

test('every rescue and scrub row requires a guard-origin ledger, never an observer resume', () => {
  assert.equal(new Set(vectors.rows.map((row) => row.id)).size, vectors.rows.length);
  for (const id of [
    'ordinary-install',
    'holder-death',
    'session-loss',
    'worker-restart',
    'protected-seven-hop',
    'protected-vault-hop',
    'protected-error-page',
    'late-foreign-world',
    'pending-protected-hop',
  ]) {
    const row = vectors.rows.find((item) => item.id === id);
    assert.equal(row.expected.admitted, true, id);
    assert.equal(row.requires.includes('privateRescueAudit'), true, id);
    assert.equal(row.expected.released, true, id);
    if (row.destination !== 'ordinary') {
      assert.equal(row.expected.committed, false, id);
      assert.equal(row.expected.published, false, id);
    }
  }
  assert.deepEqual(vectors.rescueEvidence, {
    origin: 'guard',
    noObserverResume: true,
    ownerUnchanged: true,
    generationUnchanged: true,
    deadlineUnchanged: true,
  });
});

test('the lease rows include unplaced reachability and every measured navigation class', () => {
  for (const item of [
    'protected-top',
    'protected-subframe',
    'nested-protected-subframe',
    'protected-world',
    'foreign-extension-world',
    'protected-worker',
    'unplaced-frame',
    'unplaced-world',
    'unplaced-worker',
    'incomplete-read',
  ])
    assert.equal(vectors.leaseRefusals.includes(item), true, item);
  assert.deepEqual(vectors.navigation, [
    'navigate',
    'href',
    'replace',
    'redirect',
    'reload',
    'history',
    'bfcache',
    'prerender',
  ]);
});

test('E4 ordinary controls prove Stage1 refusals and the converted positive without weakening protected expectations', async () => {
  const { vectors: rows } = JSON.parse(
    await readFile(new URL('../../guard-vectors.json', import.meta.url))
  );
  const condition = rows.find(({ id }) => id === 'E4');
  const instrumentation = rows.find(({ id }) => id === 'E4.instrumentation');
  const listener = rows.find(({ id }) => id === 'E4.event-listener');
  assert.deepEqual(condition.control.expected, { condition: false, admissionRefused: true });
  assert.deepEqual(condition.observe.admissionRefused.check, {
    registration: 'any',
    observer: 'client',
  });
  assert.equal(condition.setup[3].refusable, true);
  assert.deepEqual(listener.control.expected, { paused: false, admissionRefused: true });
  assert.deepEqual(listener.observe.admissionRefused.check, {
    registration: 'any',
    observer: 'client',
  });
  assert.equal(listener.setup[3].refusable, true);
  assert.deepEqual(instrumentation.control.expected, { paused: true, convertedPause: true });
  assert.deepEqual(instrumentation.observe.convertedPause.check, {
    event: 'Debugger.paused',
    where: { params: { reason: 'other' } },
    observer: 'client',
  });
  assert.deepEqual(condition.expected, { condition: false, paused: false, served: 'either' });
  for (const row of [instrumentation, listener])
    assert.deepEqual(row.expected, { paused: false, served: 'either' });
});
