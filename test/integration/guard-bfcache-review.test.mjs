import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { bfcacheRestore } from '../../bfcache-restore.mjs';
import { run } from '../../guard-runner.mjs';
import { bfcacheClients } from './fixtures/bfcache-client.mjs';
import { bfcacheReviewClient } from './fixtures/bfcache-review-client.mjs';

const origin = 'http://seven.sliccy.ai:4811';
const ordinary = 'http://ordinary.example.test:4811';
const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));

async function probe(fault, { side = 'guarded', ...options } = {}) {
  const browser = bfcacheReviewClient({ fault, ...options });
  return bfcacheRestore({
    client: side === 'control' ? browser.unguarded : browser.client,
    reader: browser.unguarded,
    delayClient: browser.client,
    ordinary,
    protectedOrigin: origin,
    tag: 'review-case',
    mode: 'observer',
    side,
    budget: 50,
    delayMs: 5,
    windowMs: 80,
    ...options,
  });
}

async function row(fault) {
  const vector = set.vectors.find((item) => item.id === 'C8.protected-bfcache-restore');
  const execution = await run(
    { ...set, vectors: [{ ...vector, targets: ['seven'] }], variants: { prompt: 0 } },
    {
      ...bfcacheReviewClient({ fault }),
      capabilities: { inboundDelay: true, forwardAudit: true },
      targets: { ordinary, seven: origin },
      fixture: { log: () => [] },
      settleScale: 0.01,
    }
  );
  return execution.results[0];
}

test('a missing hold prevents an otherwise matching guarded leg passing', {
  timeout: 15000,
}, async () => {
  const result = await row('hold');
  assert.equal(result.control, 'pass', result.why);
  assert.equal(result.guarded, 'incomplete', result.why);
  assert(result.incomplete.some((reason) => reason.includes('held restore events not proven')));
});

for (const fault of ['origin', 'flag']) {
  test(`a measured ${fault} failure takes precedence over missing hold evidence`, {
    timeout: 15000,
  }, async () => {
    const result = await row(['hold', fault]);
    assert.equal(result.guarded, 'fail', result.why);
    assert(result.incomplete.some((reason) => reason.includes('held restore events not proven')));
  });
}

test('every gate-window forward fails even with an unknown frame flag', async () => {
  const result = await probe('flag');
  assert(result.probes.some((item) => !item.protectedCurrent && item.forwarded));
  assert.equal(result.commandsUnforwarded, false);
});

for (const method of [
  'DOM.getDocument',
  'Accessibility.getFullAXTree',
  'Page.captureScreenshot',
  'IO.read',
  'Input.dispatchKeyEvent',
]) {
  test(`a refused ${method} reply cannot carry the protected origin`, async () => {
    const result = await probe('origin', { method });
    assert.equal(result.originHidden, false);
  });
}

test('a partial forwarding ledger preserves an observed forward', async () => {
  const result = await probe(['flag', 'partial']);
  assert.equal(result.commandsUnforwarded, false);
  assert(result.incomplete.includes('forwarding audit unavailable'));
});

test('unresolved replies without terminal forwarding evidence are incomplete', async () => {
  const browser = bfcacheClients({ guard: 'queue' });
  const result = await bfcacheRestore({
    ...browser,
    reader: browser.unguarded,
    ordinary,
    protectedOrigin: origin,
    tag: 'unresolved-review',
    mode: 'observer',
    side: 'guarded',
    budget: 5,
    delayMs: 2,
    windowMs: 10,
    forwardAudit: false,
  });
  assert(result.incomplete.includes('terminal non-forwarding evidence unavailable'));
});

test('late probe replies are included before judgement', async () => {
  const result = await probe('late', { budget: 250, windowMs: 10, forwardAudit: false });
  assert.equal(result.markerHidden, false);
  assert.equal(result.originHidden, false);
  assert.equal(result.probesRefusedOrUnforwarded, false);
});

for (const fault of ['image', 'io']) {
  test(`unrelated ${fault} data cannot prove the control`, async () => {
    const result = await probe(fault, { side: 'control' });
    assert.equal(result.methodsProven, 'incomplete');
    assert(result.incomplete.includes('positive probe methods not observed'));
  });
}
