import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';
import { bfcacheHistoryClients } from './fixtures/bfcache-history-client.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vector = set.vectors.find((item) => item.id === 'C8.protected-bfcache-restore.history');

async function row(options = {}, forwardAudit = true) {
  const browser = bfcacheHistoryClients(options);
  const execution = await run(
    { ...set, vectors: [{ ...vector, targets: ['seven'] }], variants: { prompt: 0 } },
    {
      ...browser,
      capabilities: { inboundDelay: true, forwardAudit },
      targets: {
        ordinary: 'http://ordinary.example.test:4811',
        seven: 'http://seven.sliccy.ai:4811',
      },
      fixture: { log: () => [] },
      settleScale: 0.01,
    }
  );
  return { row: execution.results[0], transport: browser.evidence };
}

test('a slow history refusal with terminal non-forwarding evidence restores through the observer', {
  timeout: 15000,
}, async () => {
  const { row: result, transport } = await row();
  assert.equal(result.control, 'pass', result.why);
  assert.equal(result.guarded, 'pass', result.why);
  assert.equal(result.live, 'pass', result.why);
  assert.equal(transport.fallbacks, 1);
  assert.equal(transport.audits.length, 1);
  assert.equal(transport.audits[0].final, false);
  assert.deepEqual(transport.audits[0].probes, []);
  assert.equal(transport.audits[0].historyTrigger.id, 'history-trigger');
  const evidence = result.evidence.guarded.restore;
  assert.equal(evidence.triggerPath, 'observer-after-audited-timeout');
  assert.equal(evidence.trigger.error.message, 'no answer');
  assert.equal(evidence.triggerAudit.result.complete, false);
  assert.equal(evidence.triggerAudit.result.historyTrigger.complete, true);
  assert.equal(evidence.triggerAudit.result.historyTrigger.forwarded, false);
  assert.equal(evidence.restoredObserved, true);
  assert.equal(evidence.fallback.ok, true);
  assert.equal(evidence.delay.acknowledged, true);
  assert(evidence.delay.release.result.delayedEvents > 0);
});

test('a terminal history-trigger decision never closes the probe forwarding ledger', {
  timeout: 15000,
}, async () => {
  const { row: result, transport } = await row({ closeOnFinal: true });
  assert.equal(result.control, 'pass', result.why);
  assert.equal(result.guarded, 'pass', result.why);
  assert.equal(transport.fallbacks, 1);
  const evidence = result.evidence.guarded.restore;
  assert.equal(evidence.commandsUnforwarded, true);
  assert.equal(evidence.delay.finalAudit.result.probes.length, evidence.probes.length);
  assert(evidence.delay.finalAudit.result.probes.every((entry) => entry.forwarded === false));
});

test('a slow history navigation without a declared audit stays incomplete', {
  timeout: 15000,
}, async () => {
  const { row: result, transport } = await row({}, false);
  assert.equal(result.control, 'pass', result.why);
  assert.equal(result.guarded, 'incomplete', result.why);
  assert.equal(transport.fallbacks, 0);
  assert.equal(transport.audits.length, 0);
  assert.equal(result.evidence.guarded.restore.triggerPath, 'client-timeout');
});

test('a forwarded slow history navigation is not treated as refused', {
  timeout: 15000,
}, async () => {
  const { row: result, transport } = await row({ forwarded: true });
  assert.equal(result.guarded, 'incomplete', result.why);
  assert.equal(transport.fallbacks, 0);
  assert.equal(result.evidence.guarded.restore.triggerPath, 'client-timeout');
  assert.equal(result.evidence.guarded.restore.triggerAudit.result.historyTrigger.forwarded, true);
});

test('a late successful history reply overrides a non-forwarding ledger', {
  timeout: 15000,
}, async () => {
  const { row: result, transport } = await row({ lateAnswer: true });
  assert.equal(result.guarded, 'incomplete', result.why);
  assert.equal(transport.fallbacks, 0);
  assert.equal(result.evidence.guarded.restore.triggerReply.ok, true);
  assert.equal(result.evidence.guarded.restore.triggerPath, 'client-timeout');
});

test('a forwarded slow history navigation that restores the document needs no fallback', {
  timeout: 15000,
}, async () => {
  const { row: result, transport } = await row({ forwarded: true, takesEffect: true });
  assert.equal(result.guarded, 'pass', result.why);
  assert.equal(transport.fallbacks, 0);
  assert.equal(result.evidence.guarded.restore.triggerPath, 'client-timeout');
  assert.equal(result.evidence.guarded.restore.restoredObserved, true);
});

test('a successful reply after fallback contradicts terminal non-forwarding evidence', {
  timeout: 15000,
}, async () => {
  const { row: result } = await row({ lateAfterFallback: true });
  assert.equal(result.guarded, 'incomplete', result.why);
  assert.equal(result.evidence.guarded.restore.triggerPath, 'client-late-answer');
  assert.equal(result.evidence.guarded.restore.triggerReply.ok, true);
  assert(result.incomplete.some((reason) => reason.includes('history navigation answered')));
});

for (const audit of ['partial', 'missing', 'duplicate', 'error']) {
  test(`a slow history navigation with ${audit} audit evidence stays incomplete`, {
    timeout: 15000,
  }, async () => {
    const { row: result, transport } = await row({ audit });
    assert.equal(result.guarded, 'incomplete', result.why);
    assert.equal(transport.fallbacks, 0);
    assert.equal(result.evidence.guarded.restore.triggerPath, 'client-timeout');
  });
}
