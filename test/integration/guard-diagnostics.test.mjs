import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { connect, launch, origins } from './cdp-client.mjs';

const set = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);

const vector = (id) => ({
  id,
  kind: 'cdp',
  scope: 'any',
  targets: ['seven'],
  setup: [{ page: 'tab', url: '{ordinary}/doc?n={tag}' }],
  trigger: [{ cdp: 'Page.getFrameTree', as: 'tree' }],
  observe: {
    tree: { check: { result: 'tree', path: 'ok', equals: true, observer: 'client' } },
  },
  liveCheck: { loaded: '{ordinary}/doc?n={tag}', observer: 'fixture' },
  control: { origin: 'ordinary', via: 'guard', expected: { tree: true } },
  expected: { tree: true },
});

test('onStart, the in-flight view and rowTimeoutMs fail only the stuck row', {
  timeout: 180000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const started = [];
  const closed = [];
  const seen = [];
  try {
    const running = run(
      { ...set, vectors: [vector('D1.stuck'), vector('D1.after')], variants: { prompt: 0 } },
      {
        targets: origins(fixture),
        fixture,
        rowTimeoutMs: 4000,
        onStart: (row) => started.push(row.id),
        clientFactory: async ({ vector: { id } }) => {
          const client = await connect(browser.ws);
          const hung = new Set();
          return {
            client: {
              ...client,
              send: (method, params, sessionId) =>
                id === 'D1.stuck' && method === 'Page.getFrameTree'
                  ? new Promise((_, reject) => hung.add(reject))
                  : client.send(method, params, sessionId),
            },
            unguarded: client,
            close: async () => {
              closed.push(id);
              for (const reject of hung) reject(new Error('closed'));
              client.close();
            },
          };
        },
      }
    );
    const sampling = (async () => {
      for (let i = 0; i < 400 && seen.length === 0; i++) {
        const views = running.inFlight();
        if (views.some((item) => item.clients.client.length > 0)) seen.push(...views);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();
    const { results, inFlight } = await running;
    await sampling;
    assert.deepEqual(started, ['D1.stuck', 'D1.after']);
    assert.deepEqual(closed, ['D1.stuck', 'D1.after']);
    assert.deepEqual(inFlight(), []);
    const [stuck, after] = results;
    assert.equal(stuck.control, 'fail');
    assert.equal(stuck.guarded, 'fail');
    assert.match(stuck.errors[0], /^row timed out after 4000ms: /);
    assert.equal(stuck.inFlight.id, 'D1.stuck');
    assert.equal(stuck.inFlight.leg, 'control');
    assert.equal(stuck.inFlight.phase, 'trigger');
    assert.equal(stuck.inFlight.step, 0);
    const call = stuck.inFlight.clients.client.find((item) => item.method === 'Page.getFrameTree');
    assert.ok(
      call && call.ageMs >= 3000 && typeof call.session === 'string',
      JSON.stringify(stuck)
    );
    assert.equal(after.control, 'pass', JSON.stringify(after));
    assert.equal(after.guarded, 'pass', JSON.stringify(after));
    assert.ok(seen.some((item) => item.id === 'D1.stuck' && item.target === 'seven'));
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('a Target.createBrowserContext that times out once is retried, and the row still runs', {
  timeout: 120000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const client = await connect(browser.ws);
  let first = true;
  const slow = {
    ...client,
    send: async (method, params, sessionId) => {
      if (method === 'Target.createBrowserContext' && first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        throw new Error('CDP timeout Target.createBrowserContext');
      }
      return client.send(method, params, sessionId);
    },
  };
  try {
    const { results } = await run(
      { ...set, vectors: [vector('D1.context')], variants: { prompt: 0 } },
      {
        client: slow,
        unguarded: slow,
        targets: origins(fixture),
        fixture,
        capabilities: { browserContexts: true, browserSession: true },
      }
    );
    assert.equal(results[0].control, 'pass', JSON.stringify(results[0]));
    assert.equal(results[0].guarded, 'pass', JSON.stringify(results[0]));
    assert.deepEqual(results[0].notes, [
      'control Target.createBrowserContext retried once after: CDP timeout Target.createBrowserContext',
    ]);
  } finally {
    client.close();
    await browser.close();
    await fixture.close();
  }
});

test('a browser_ui target that auto-attaches and never answers is left alone', {
  timeout: 180000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const client = await connect(browser.ws);
  const ui = {
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 'UI-SESSION',
      targetInfo: {
        targetId: 'UI-TARGET',
        type: 'browser_ui',
        url: 'chrome://omnibox-popup.top-chrome/',
        attached: true,
      },
      waitingForDebugger: false,
    },
  };
  const hung = [];
  const chrome = {
    ...client,
    send: (method, params, sessionId) => {
      if (sessionId === 'UI-SESSION') {
        hung.push(method);
        return new Promise(() => {});
      }
      const sent = client.send(method, params, sessionId);
      if (method !== 'Target.setAutoAttach' || sessionId || !params?.autoAttach) return sent;
      client.events.push(ui);
      return sent.then(
        (result) => new Promise((resolve) => setTimeout(() => resolve(result), 300))
      );
    },
  };
  try {
    const vector = set.vectors.find((item) => item.id === 'C3.popup-on-redirect-302');
    const { results } = await run(
      { ...set, vectors: [{ ...vector, targets: ['seven'] }], variants: { prompt: 0 } },
      {
        client: chrome,
        unguarded: chrome,
        targets: origins(fixture),
        fixture,
        capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
        rowTimeoutMs: 60000,
      }
    );
    assert.equal(results[0].control, 'pass', JSON.stringify(results[0]));
    assert.deepEqual(hung, []);
  } finally {
    client.close();
    await browser.close();
    await fixture.close();
  }
});
