import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const vectors = JSON.parse(await readFile(new URL('../../debugger-stage1.json', import.meta.url)));
const ordinary = [
  'Debugger.enable',
  'Debugger.disable',
  'Debugger.resume',
  'Debugger.getScriptSource',
  'Debugger.evaluateOnCallFrame',
  'Debugger.setInstrumentationBreakpoint',
  'Debugger.removeBreakpoint',
];

test('Stage1 is exactly the seven-method subset and preserves distinct lifetimes', () => {
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
