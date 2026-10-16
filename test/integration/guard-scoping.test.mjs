import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const full = { autoAttach: true, browserSession: true, browserContexts: true };

async function row(id, { capabilities = full, extraTabs = 0, nullTargets = [], ...options } = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    const targets = {
      ...origins(fixture),
      ...Object.fromEntries(nullTargets.map((name) => [name, null])),
    };
    for (let i = 0; i < extraTabs; i++)
      await browser.unguarded.send('Target.createTarget', {
        url: `${targets.ordinary}/doc?n=other-${i}`,
      });
    const guard = emulatedGuard(browser, {
      protectedHosts: [new URL(targets.seven).host],
      ...options,
    });
    try {
      const vector = { ...data.vectors.find((v) => v.id === id), targets: ['seven'] };
      const execution = await run(
        { ...data, vectors: [vector], variants: { prompt: 0 } },
        { client: guard.client, unguarded: browser.unguarded, targets, fixture, capabilities }
      );
      return execution.results[0];
    } finally {
      await guard.stop();
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
}

const passes = (result) => {
  assert.equal(result.control, 'pass', JSON.stringify(result));
  assert.equal(result.guarded, 'pass', JSON.stringify(result));
  assert.equal(result.live, 'pass', JSON.stringify(result));
};

for (const id of ['C3.popup-on-redirect-302', 'C3.popup-on-redirect-chain'])
  test(`${id} instruments only its own popup when other tabs are open`, async () => {
    const result = await row(id, { extraTabs: 2, refuseForeign: true, foreignLatencyMs: 1000 });
    assert.equal(result.control, 'pass', JSON.stringify(result));
    assert.equal(result.live, 'pass', JSON.stringify(result));
    assert.doesNotMatch(result.why ?? '', /refused only/, JSON.stringify(result));
    for (const leg of ['control', 'guarded'])
      for (const [name, value] of Object.entries(result.observations[leg]))
        if (name.startsWith('refused.'))
          assert.equal(value, false, `${leg} ${name}: ${JSON.stringify(result)}`);
    assert.equal(result.observations.control.beacon, true, JSON.stringify(result));
    assert.equal(result.observations.guarded.beacon, false, JSON.stringify(result));
  });

test('C4.static-cross-site skips its control beacon when the page init script is refused', async () => {
  passes(
    await row('C4.static-cross-site', {
      refuseFrameAttach: true,
      refuse: (method, _params, child) =>
        method === 'Page.addScriptToEvaluateOnNewDocument' && !child,
    })
  );
});

test('a browser-context cookie row without a browser session is not supported, not sent to the page', async () => {
  const result = await row('C6.read-cookies', {
    capabilities: { autoAttach: true, browserSession: false, browserContexts: true },
  });
  assert.equal(result.control, 'skip', JSON.stringify(result));
  assert.equal(result.reason, 'not-supported:browserSession');
});

test('a row that requires a browser session reports not-supported:browserSession without one', async () => {
  const result = await row('C6.clear-cookies', {
    capabilities: { autoAttach: true, browserSession: false, browserContexts: true },
  });
  assert.equal(result.control, 'skip', JSON.stringify(result));
  assert.equal(result.reason, 'not-supported:browserSession');
});

test('a background result read by an observation is awaited, even when its reply arrives late', async () => {
  const result = await row('C5.guessed-id.continue-response', {
    replyLatency: (method, params) =>
      method === 'Runtime.evaluate' && String(params.expression).includes('/data?n=guard-')
        ? 2000
        : 0,
  });
  assert.equal(result.control, 'pass', JSON.stringify(result));
  assert.notEqual(result.observations.control.answered, undefined, JSON.stringify(result));
});

test('C3.popup-self-nav triggers only after the load of the navigation it started, not a stale one', async () => {
  const trace = [];
  await row('C3.popup-self-nav', {
    trace,
    staleLoad: (_session, child) => child,
    documentLatency: (url) => (url.includes('again=1') ? 800 : 0),
  });
  for (const leg of ['control', 'guarded']) {
    const again = trace.find(
      (entry) =>
        entry.method === 'Page.navigate' &&
        entry.params.url.includes(`${leg}-`) &&
        entry.params.url.includes('again=1')
    );
    assert(again, `${leg}: no again navigation`);
    const committed = trace.findIndex(
      (entry) =>
        entry.event?.method === 'Page.frameNavigated' &&
        entry.event.params.frame.url === again.params.url
    );
    const loaded = trace.findIndex(
      (entry, index) =>
        index > committed &&
        entry.event?.method === 'Page.loadEventFired' &&
        entry.event.sessionId === again.sessionId
    );
    const trigger = trace.findIndex(
      (entry) =>
        entry.method === 'Runtime.evaluate' &&
        entry.sessionId === again.sessionId &&
        entry.params.expression.includes('location.href')
    );
    assert(committed >= 0 && loaded > committed, `${leg}: the again document never loaded`);
    assert(trigger > loaded, `${leg}: the trigger ran before the again document loaded`);
  }
});

test('C1.script-nav runs with ordinary-same-site unavailable, through its other alternatives', async () => {
  const result = await row('C1.script-nav', { nullTargets: ['ordinary-same-site'] });
  assert.notEqual(result.control, 'skip', JSON.stringify(result));
  passes(result);
});
