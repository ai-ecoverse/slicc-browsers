import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { bfcacheRestore } from '../../bfcache-restore.mjs';
import { run } from '../../guard-runner.mjs';
import { containsSecret } from '../../redirect-secret.mjs';
import { bfcacheMarkerClients, markerMethods } from './fixtures/bfcache-marker-client.mjs';

const targets = {
  ordinary: 'http://ordinary.example.test:4811',
  seven: 'http://seven.sliccy.ai:4811',
};
const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));

for (const mode of ['observer', 'history']) {
  for (const page of ['ordinary', 'protected']) {
    for (const [channel, methods] of [
      ['reply', markerMethods],
      ['error', markerMethods],
      ['event', ['Runtime.evaluate']],
      ['message', ['Runtime.evaluate']],
    ]) {
      for (const method of methods) {
        test(`${mode} ${method} ${channel} distinguishes the ${page} marker`, async () => {
          const browser = bfcacheMarkerClients({ page, channel, method });
          const result = await bfcacheRestore({
            ...browser,
            reader: browser.unguarded,
            ordinary: targets.ordinary,
            protectedOrigin: targets.seven,
            tag: 'marker-identity',
            mode,
            side: 'guarded',
            budget: 50,
            delayMs: 1,
            windowMs: 1,
          });
          assert.equal(result.incomplete, undefined);
          assert.equal(result.restoredObserved, true);
          assert(result.probes.length > 0);
          assert(result.probes.every((probe) => probe.protectedCurrent === false));
          assert.equal(result.markerHidden, page === 'ordinary');
          assert.equal(result.originHidden, true);
          assert.equal(result.sideEffectAbsent, true);
          assert.equal(containsSecret(browser.markers.ordinary, browser.markers.protected), false);
          assert.equal(containsSecret(browser.markers.protected, browser.markers.ordinary), false);
        });
      }
    }
  }
}

for (const page of ['ordinary', 'protected']) {
  test(`both restore vectors judge ${page} marker events independently`, {
    timeout: 15000,
  }, async () => {
    const execution = await run(
      {
        ...set,
        vectors: ['C8.protected-bfcache-restore', 'C8.protected-bfcache-restore.history'].map(
          (id) => ({ ...set.vectors.find((vector) => vector.id === id), targets: ['seven'] })
        ),
        variants: { prompt: 0 },
      },
      {
        ...bfcacheMarkerClients({ page, channel: 'event', protectedCurrent: true }),
        capabilities: { inboundDelay: true, forwardAudit: true },
        targets,
        fixture: { log: () => [] },
        settleScale: 0.01,
      }
    );
    assert.equal(execution.results.length, 2);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', row.why);
      assert.equal(row.live, 'pass', row.why);
      assert.equal(row.guarded, page === 'ordinary' ? 'pass' : 'fail', row.why);
      assert.equal(row.observations.guarded.markerHidden, page === 'ordinary');
    }
  });
}
