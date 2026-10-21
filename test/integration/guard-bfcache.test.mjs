import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';
import { bfcacheClients } from './fixtures/bfcache-client.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const ids = ['C8.protected-bfcache-restore', 'C8.protected-bfcache-restore.history'];
const targets = {
  ordinary: 'http://ordinary.example.test:4811',
  seven: 'http://seven.sliccy.ai:4811',
  vault: 'http://vault.sliccy.ai:4811',
};

async function rows(options, capabilities = { inboundDelay: true, forwardAudit: true }) {
  const vectors = ids.map((id) => {
    const vector = set.vectors.find((item) => item.id === id);
    assert(vector, `${id} required`);
    assert.deepEqual(vector.targets, ['seven', 'vault']);
    return { ...vector, targets: ['seven'] };
  });
  return run(
    { ...set, vectors, variants: { prompt: 0 } },
    {
      ...bfcacheClients(options),
      capabilities,
      targets,
      fixture: { log: () => [] },
      settleScale: 0.01,
    }
  );
}

for (const [guard, verdict] of [
  ['none', 'fail'],
  ['drop', 'fail'],
  ['refuse', 'pass'],
  ['queue', 'pass'],
]) {
  test(`history restore measures ${guard} transport`, { timeout: 30000 }, async () => {
    const execution = await rows({ guard });
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', row.why);
      assert.equal(row.guarded, verdict, row.why);
      assert.equal(row.live, 'pass', row.why);
      const evidence = row.evidence.guarded.restore;
      assert.equal(evidence.delay.requestedMs, 1500);
      assert.equal(evidence.delay.acknowledged, true);
      assert(evidence.delay.release.result.delayedEvents > 0);
      assert(evidence.restoreAt >= evidence.delay.startedAt);
      assert(evidence.probes.every((item) => item.sentAt >= evidence.delay.startedAt));
      assert(evidence.probes.some((item) => item.method === 'Runtime.callFunctionOn'));
      assert.equal(row.observations.guarded.sideEffectAbsent, ['refuse', 'queue'].includes(guard));
      assert.equal(
        row.observations.guarded.commandsUnforwarded,
        ['refuse', 'queue'].includes(guard)
      );
      if (guard === 'none') {
        assert.equal(row.observations.guarded.markerHidden, false);
        assert.equal(row.observations.guarded.originHidden, false);
      }
      if (guard === 'drop') {
        assert.equal(row.observations.guarded.markerHidden, true);
        assert.equal(row.observations.guarded.originHidden, true);
        assert.equal(row.observations.guarded.probesRefusedOrUnforwarded, true);
        assert(evidence.probes.some((item) => item.outcome === 'no answer'));
      }
    }
  });
}

for (const [options, capabilities] of [
  [{ hooks: false }, { inboundDelay: true }],
  [{}, {}],
]) {
  test('history restore without an injection hook is not supported', async () => {
    const execution = await rows(options, capabilities);
    assert(
      execution.results.every(
        (row) =>
          row.control === 'skip' &&
          row.guarded === 'skip' &&
          row.reason === 'not-supported:inboundDelay'
      )
    );
    assert(execution.results.every((row) => row.live === 'skip'));
  });
}

test('history restore without a forwarding audit keeps independent checks', {
  timeout: 30000,
}, async () => {
  const execution = await rows({ guard: 'refuse' }, { inboundDelay: true });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', row.why);
    assert.equal(row.guarded, 'pass', row.why);
    assert.equal(row.observations.guarded.commandsUnforwarded, 'not-supported');
    assert(row.notSupported.includes('commandsUnforwarded'));
  }
});

test('history restore with an advertised but missing audit is incomplete', {
  timeout: 30000,
}, async () => {
  const execution = await rows({ guard: 'refuse', missing: 'audit' });
  for (const row of execution.results) {
    assert.equal(row.guarded, 'incomplete', row.why);
    assert(row.incomplete.some((reason) => reason.includes('forwarding audit unavailable')));
  }
});

test('history restore without a real cache restore is incomplete', { timeout: 30000 }, async () => {
  const execution = await rows({ guard: 'refuse', missing: 'restore' });
  for (const row of execution.results) {
    assert.equal(row.control, 'incomplete', row.why);
    assert.notEqual(row.guarded, 'pass');
    assert(row.incomplete.some((reason) => reason.includes('real protected BFCache restore')));
  }
});
