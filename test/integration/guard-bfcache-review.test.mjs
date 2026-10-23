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

async function snapshotRows({ earlyForwarded = false, finalComplete = true } = {}) {
  const browser = bfcacheClients({ guard: 'refuse' });
  const install = browser.client.inboundDelay;
  browser.client.inboundDelay = async (args) => {
    const gate = await install(args);
    const audit = gate.audit;
    return {
      ...gate,
      audit: async ({ probes, final }) => {
        const ledger = await audit({ probes, final });
        if (args.side === 'control') return ledger;
        if (final)
          return finalComplete
            ? ledger
            : { ...ledger, complete: false, probes: ledger.probes.slice(0, -1) };
        return {
          ...ledger,
          complete: false,
          probes: ledger.probes
            .slice(0, 1)
            .map((entry) => ({ ...entry, forwarded: earlyForwarded })),
        };
      },
    };
  };
  return run(
    {
      ...set,
      vectors: set.vectors
        .filter((vector) => vector.id.startsWith('C8.protected-bfcache-restore'))
        .map((vector) => ({ ...vector, targets: ['seven'] })),
      variants: { prompt: 0 },
    },
    {
      ...browser,
      capabilities: { inboundDelay: true, forwardAudit: true },
      targets: { ordinary, seven: origin },
      fixture: { log: () => [] },
      settleScale: 0.01,
    }
  );
}

test('a partial early audit is superseded by complete non-forwarding evidence', {
  timeout: 30000,
}, async () => {
  const execution = await snapshotRows();
  assert.equal(execution.results.length, 2);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', row.why);
    assert.equal(row.guarded, 'pass', row.why);
    assert.equal(row.live, 'pass', row.why);
    assert.equal(row.observations.guarded.commandsUnforwarded, true);
    const evidence = row.evidence.guarded.restore;
    assert.equal(evidence.delay.audit.result.complete, false);
    assert.equal(evidence.delay.audit.result.probes.length, 1);
    assert(evidence.delay.audit.result.probes.every((entry) => entry.forwarded === false));
    assert(evidence.delay.audit.result.probes.length < evidence.probes.length);
    assert.equal(evidence.delay.finalAudit.result.complete, true);
    assert.equal(evidence.delay.finalAudit.result.probes.length, evidence.probes.length);
    assert(evidence.delay.finalAudit.result.probes.every((entry) => entry.forwarded === false));
    assert.equal(evidence.incomplete, undefined);
  }
});

test('an early forward still fails after a complete non-forwarding final audit', {
  timeout: 30000,
}, async () => {
  const execution = await snapshotRows({ earlyForwarded: true });
  assert.equal(execution.results.length, 2);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', row.why);
    assert.equal(row.guarded, 'fail', row.why);
    assert.equal(row.live, 'pass', row.why);
    assert.equal(row.observations.guarded.commandsUnforwarded, false);
    const evidence = row.evidence.guarded.restore;
    assert(evidence.delay.audit.result.probes.some((entry) => entry.forwarded === true));
    assert.equal(evidence.delay.finalAudit.result.complete, true);
    assert(evidence.delay.finalAudit.result.probes.every((entry) => entry.forwarded === false));
    assert.equal(evidence.incomplete, undefined);
  }
});

test('an incomplete final audit remains missing evidence', { timeout: 30000 }, async () => {
  const execution = await snapshotRows({ finalComplete: false });
  assert.equal(execution.results.length, 2);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', row.why);
    assert.equal(row.guarded, 'incomplete', row.why);
    assert.equal(row.live, 'pass', row.why);
    assert.equal(row.observations.guarded.commandsUnforwarded, 'incomplete');
    const evidence = row.evidence.guarded.restore;
    assert.equal(evidence.delay.finalAudit.result.complete, false);
    assert(evidence.delay.finalAudit.result.probes.every((entry) => entry.forwarded === false));
    assert(evidence.incomplete.includes('forwarding audit unavailable'));
  }
});

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
