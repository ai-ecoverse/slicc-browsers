import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const stripId = 'E7.isolated-world';
const stripVectors = set.vectors.filter((vector) => vector.id === stripId);
const attackIds = [
  'E7.init-boundary',
  'E7.init-world-carry',
  'E7.init-world-error',
  'E7.emulation-carry',
  'E7.isolated-foreign',
  'E7.ua-empty',
  'E7.binding-main',
  'E7.binding-main-ctx',
  'C3.tab-protected',
  'C3.tab-blank',
  'C3.tab-protected.synthetic',
  'C3.tab-blank.synthetic',
  'C3.tab-worker-leak',
];
const attackVectors = set.vectors.filter((vector) => attackIds.includes(vector.id));
const base = { autoAttach: true, browserSession: true, browserContexts: true };
const stockCaps = { ...base, stockSetup: true, syntheticAutoAttach: true, forwardAudit: true };

function record(client) {
  const forwarded = client.forwarded ?? [];
  if (!client.forwarded) client.forwarded = forwarded;
  const send = client.send.bind(client);
  client.send = (method, params = {}, sessionId) => {
    forwarded.push({ method, params, sessionId, sentAt: Date.now() });
    return send(method, params, sessionId);
  };
  return client;
}

async function execute(mode, only = stripVectors) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.client);
  record(browser.unguarded);
  const guard =
    mode === 'none'
      ? { client: browser.client, stop: async () => {} }
      : emulatedGuard(browser, {
          stripUniversalAccess: mode === 'strip',
          narrowAutoAttach: mode === 'strip',
          refuse: mode === 'refuse' ? (method) => method === 'Page.createIsolatedWorld' : undefined,
        });
  try {
    return await run(
      { ...set, vectors: only, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: stockCaps,
        rowTimeoutMs: 60000,
      }
    );
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
}

test('the published attack and strip rows are present', () => {
  assert.deepEqual(attackVectors.map((vector) => vector.id).sort(), [...attackIds].sort());
  assert.equal(stripVectors.length, 1);
  assert.deepEqual(stripVectors[0].targets, ['ordinary']);
  assert.equal(stripVectors[0].control.via, 'unguarded');
  assert.ok(stripVectors[0].requires.includes('forwardAudit'));
});

test('a guard that strips grantUniveralAccess passes E7.isolated-world', {
  timeout: 180000,
}, async () => {
  const execution = await execute('strip');
  const [row] = execution.results;
  assert.deepEqual(
    [row.control, row.guarded, row.live],
    ['pass', 'pass', 'pass'],
    JSON.stringify(row)
  );
  assert.equal(row.observations.guarded.stripped, true);
});

test('a guard that forwards grantUniveralAccess true fails E7.isolated-world', {
  timeout: 180000,
}, async () => {
  const execution = await execute('none');
  const [row] = execution.results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.stripped, false, JSON.stringify(row));
});

test('without forwardAudit E7.isolated-world skips, never passes', async () => {
  const client = { events: [], forwarded: [], send: async () => assert.fail('skipped') };
  const fixture = await fixtureServer();
  try {
    const execution = await run(
      { ...set, vectors: stripVectors, variants: { prompt: 0 } },
      {
        client,
        unguarded: client,
        fixture,
        targets: origins(fixture),
        capabilities: { ...base, stockSetup: true },
      }
    );
    const [row] = execution.results;
    assert.deepEqual([row.control, row.guarded, row.live], ['skip', 'skip', 'skip']);
    assert.equal(row.reason, 'not-supported:forwardAudit');
  } finally {
    await fixture.close();
  }
});

test('without a guard every stock-setup attack control passes', {
  timeout: 900000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.client);
  record(browser.unguarded);
  try {
    const execution = await run(
      { ...set, vectors: attackVectors, variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: stockCaps,
        rowTimeoutMs: 90000,
      }
    );
    for (const row of execution.results) assert.equal(row.control, 'pass', JSON.stringify(row));
  } finally {
    await browser.close();
    await fixture.close();
  }
});

const attackStock = new Set([
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Emulation.setFocusEmulationEnabled',
  'Emulation.setEmulatedMedia',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setUserAgentOverride',
  'Runtime.addBinding',
  'Page.createIsolatedWorld',
  'Target.setAutoAttach',
]);

test('an admit-all reference fails every protected-target stock-setup attack row', {
  timeout: 900000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.client);
  record(browser.unguarded);
  try {
    const execution = await run(
      { ...set, vectors: attackVectors, variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: stockCaps,
        rowTimeoutMs: 90000,
      }
    );
    const leaking = execution.results.filter(
      (row) => row.target !== 'ordinary' && row.id !== 'E7.ua-empty'
    );
    assert.ok(leaking.length > 0);
    for (const row of leaking) assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(execution.summary({ guard: 'admit-all' }).pass, false);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('a refuse-all reference passes every E7 stock-setup attack row', {
  timeout: 900000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.client);
  record(browser.unguarded);
  const guard = emulatedGuard(browser, {
    refuse: (method) => attackStock.has(method),
  });
  const e7 = attackVectors.filter((vector) => vector.id.startsWith('E7.'));
  try {
    const execution = await run(
      { ...set, vectors: e7, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: stockCaps,
        rowTimeoutMs: 90000,
      }
    );
    for (const row of execution.results)
      assert.deepEqual(
        [row.control, row.guarded, row.live],
        ['pass', 'pass', 'pass'],
        JSON.stringify(row)
      );
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});
