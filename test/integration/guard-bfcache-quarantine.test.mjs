import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';
import { bfcacheQuarantineClients } from './fixtures/bfcache-quarantine-client.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const ids = ['C8.protected-bfcache-restore', 'C8.protected-bfcache-restore.history'];
const targets = {
  ordinary: 'http://ordinary.example.test:4811',
  seven: 'http://seven.sliccy.ai:4811',
};

async function rows({ missingAcknowledgement, ...options } = {}) {
  const browser = bfcacheQuarantineClients(options);
  const acknowledgementSessions = new Set();
  for (const transport of [browser.client, browser.unguarded]) {
    const send = transport.send;
    transport.send = async (method, params, sessionId) => {
      if (method === 'Page.getFrameTree' && acknowledgementSessions.has(sessionId)) return {};
      const result = await send(method, params, sessionId);
      if (
        method === 'Target.attachToTarget' &&
        browser.targets.get(params.targetId)?.url.endsWith('-b') &&
        (missingAcknowledgement === transport.name || missingAcknowledgement === 'both')
      )
        acknowledgementSessions.add(result.sessionId);
      return result;
    };
  }
  const execution = await run(
    {
      ...set,
      vectors: ids.map((id) => ({
        ...set.vectors.find((vector) => vector.id === id),
        targets: ['seven'],
      })),
      variants: { prompt: 0 },
    },
    {
      ...browser,
      capabilities: { inboundDelay: true, forwardAudit: true },
      targets,
      fixture: { log: () => [] },
      settleScale: 0.01,
    }
  );
  assert.equal(execution.results.length, 2);
  return { execution, browser };
}

for (const options of [{}, { blockProtectedLoads: false, refuseHistory: true }]) {
  test(`history quarantine reaches verdicts ${JSON.stringify(options)}`, {
    timeout: 30000,
  }, async () => {
    const { execution, browser } = await rows(options);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', row.why);
      assert.equal(row.guarded, 'pass', row.why);
      assert.equal(row.live, 'pass', row.why);
      assert.deepEqual(row.errors, []);
      assert.equal(row.incomplete, undefined);
      const control = row.evidence.control.restore;
      const guarded = row.evidence.guarded.restore;
      assert.equal(control.methodsProven, true);
      assert.equal(control.probeRanInProtected, true);
      assert.equal(control.touched, true);
      assert.equal(guarded.sessionLive, true);
      assert(guarded.seed.ordinaryAnswer.result.frameTree.frame.url.endsWith('-b'));
      assert.equal(guarded.delay.acknowledged, true);
      assert.equal(guarded.restoredObserved, true);
      assert.equal(guarded.commandsUnforwarded, true);
      assert.equal(guarded.sideEffectAbsent, true);
      assert(guarded.probes.some((probe) => probe.outcome === 'refused'));
      if (row.id.endsWith('.history')) assert.equal(guarded.trigger.ok, !options.refuseHistory);
    }
    assert.deepEqual(browser.blockedLoads, []);
    assert(browser.scriptRefusals.length > 0);
    assert(
      browser.calls
        .filter((call) => call.name === 'client' && call.method === 'Target.attachToTarget')
        .every((call) => {
          const attach = browser.calls.indexOf(call);
          const seed = browser.calls
            .slice(0, attach)
            .filter((entry) => entry.name === 'observer' && entry.method === 'Page.navigate');
          return seed.at(-1).params.url.endsWith('-b');
        })
    );
    assert(
      !browser.calls.some(
        (call) =>
          call.name === 'client' &&
          call.method === 'Runtime.evaluate' &&
          call.params.expression === 'location.href'
      )
    );
    assert.equal(execution.summary().pass, true);
  });
}

for (const missingAcknowledgement of ['client', 'observer', 'both']) {
  test(`missing ${missingAcknowledgement} B acknowledgement stays incomplete in affected columns`, {
    timeout: 30000,
  }, async () => {
    const { execution } = await rows({ missingAcknowledgement });
    for (const row of execution.results) {
      const controlMissing = missingAcknowledgement !== 'client';
      const guardedMissing = missingAcknowledgement !== 'observer';
      assert.equal(row.control, controlMissing ? 'incomplete' : 'pass', row.why);
      assert.equal(row.guarded, guardedMissing ? 'incomplete' : 'pass', row.why);
      assert.equal(row.live, guardedMissing ? 'incomplete' : 'pass', row.why);
      assert.deepEqual(row.errors, []);
      assert(
        row.incomplete.some((reason) => reason.includes('ordinary B acknowledgement unavailable'))
      );
      for (const leg of ['control', 'guarded']) {
        if (!(leg === 'control' ? controlMissing : guardedMissing)) continue;
        const evidence = row.evidence[leg].restore;
        assert.equal(evidence.sessionLive, undefined);
        assert.equal(evidence.delay.acknowledged, undefined);
        assert.deepEqual(evidence.probes, []);
      }
    }
    assert.equal(execution.summary().pass, false);
  });
}

test('history quarantine still fails a guard that leaks after restoration', {
  timeout: 30000,
}, async () => {
  const { execution, browser } = await rows({ leak: true });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', row.why);
    assert.equal(row.guarded, 'fail', row.why);
    assert.equal(row.live, 'pass', row.why);
    assert.deepEqual(row.errors, []);
    assert.equal(row.incomplete, undefined);
    assert.equal(row.observations.guarded.markerHidden, false);
    assert.equal(row.observations.guarded.originHidden, false);
    assert.equal(row.observations.guarded.sideEffectAbsent, false);
    assert.equal(row.observations.guarded.commandsUnforwarded, false);
  }
  assert.deepEqual(browser.blockedLoads, []);
  assert.equal(execution.summary().pass, false);
});
