import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { DEFAULT_EXTENSION_WORLD_ID } from '../../extension-world.mjs';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { chrome } from './error-page-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vector = set.vectors.find((item) => item.id === 'C9.page-drivable');
const awaited = (call) =>
  call.method === 'Runtime.evaluate' &&
  call.params.awaitPromise === true &&
  /requestAnimationFrame\(\(\) => requestAnimationFrame\(/.test(call.params.expression);

function screen(paints) {
  const browser = chrome();
  const pages = new Map();
  const page = (tab) => {
    if (!pages.has(tab.targetId))
      pages.set(tab.targetId, {
        front: false,
        frames: 0,
        callbacks: [],
        scheduled: false,
        button: false,
        pressed: false,
        clicked: false,
        dropped: 0,
      });
    return pages.get(tab.targetId);
  };
  const schedule = (state) => {
    if (!paints || !state.front || state.scheduled) return;
    state.scheduled = true;
    setImmediate(() => {
      state.scheduled = false;
      for (const callback of state.callbacks.splice(0)) callback(state.frames * 16);
      state.frames++;
    });
  };
  const evaluate = async (tab, state, params, conn, sessionId) => {
    if (params.expression === 'self.origin')
      return { result: { type: 'string', value: new URL(tab.url).origin } };
    if (params.expression.includes('innerHTML')) {
      state.button = true;
      return { result: { type: 'string', value: 'C9 click' } };
    }
    if (params.expression === 'document.body.dataset.clicked')
      return { result: state.clicked ? { type: 'string', value: 'yes' } : { type: 'undefined' } };
    if (params.awaitPromise) {
      const context = vm.createContext({
        requestAnimationFrame: (callback) => {
          state.callbacks.push(callback);
          schedule(state);
          return state.callbacks.length;
        },
        setTimeout: () => 0,
      });
      const value = await vm.runInContext(params.expression, context);
      return { result: { type: typeof value, value } };
    }
    return conn.raw('Runtime.evaluate', params, sessionId);
  };
  const contexts = (tab, origin) => [
    { id: 1, uniqueId: `${tab.targetId}-page`, origin, name: '', auxData: { isDefault: true } },
    {
      id: 2,
      uniqueId: `${tab.targetId}-world`,
      origin: `chrome-extension://${DEFAULT_EXTENSION_WORLD_ID}`,
      name: 'C9 harness',
      auxData: { isDefault: false },
    },
  ];
  const connect = () => {
    const conn = browser.connect();
    conn.sent = [];
    conn.send = async (method, params = {}, sessionId) => {
      conn.sent.push({ method, params, sessionId });
      const tab = browser.tabOf(sessionId, params.targetId);
      const state = tab && page(tab);
      if (method === 'Runtime.enable' && tab) {
        await conn.raw(method, params, sessionId);
        for (const context of contexts(tab, new URL(tab.url).origin))
          conn.events.push({
            method: 'Runtime.executionContextCreated',
            params: {
              context: { ...context, auxData: { ...context.auxData, frameId: tab.targetId } },
            },
            sessionId,
          });
        return {};
      }
      if (method === 'Page.bringToFront' && tab) {
        state.front = true;
        return {};
      }
      if (method === 'DOMSnapshot.captureSnapshot' && tab)
        return { documents: [{ nodes: {} }], strings: [] };
      if (method === 'Input.dispatchMouseEvent' && tab) {
        const hit = state.button && state.frames >= 2 && params.x < 100 && params.y < 100;
        if (!hit) state.dropped++;
        if (hit && params.type === 'mousePressed') state.pressed = true;
        if (hit && params.type === 'mouseReleased' && state.pressed) state.clicked = true;
        return {};
      }
      if (method === 'Runtime.evaluate' && tab)
        return evaluate(tab, state, params, conn, sessionId);
      return conn.raw(method, params, sessionId);
    };
    return conn;
  };
  return { connect, pages };
}

async function row(paints) {
  const fixture = await fixtureServer();
  try {
    const fake = screen(paints);
    const client = fake.connect();
    const unguarded = fake.connect();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const execution = await run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      {
        client,
        unguarded,
        fixture,
        settleScale: 0.1,
        rowTimeoutMs: 20000,
        capabilities: { extensionWorld: true },
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    return { result: execution.results[0], client, unguarded, pages: [...fake.pages.values()] };
  } finally {
    await fixture.close();
  }
}

const dispatched = (conn) =>
  conn.sent
    .filter((call) => call.method === 'Input.dispatchMouseEvent')
    .map((call) => call.params.type);

test('C9.page-drivable waits two observer frames after bringToFront before it clicks', {
  timeout: 60000,
}, async () => {
  const { result, client, unguarded, pages } = await row(true);
  assert.equal(result.control, 'pass', JSON.stringify(result));
  assert.equal(result.guarded, 'pass', JSON.stringify(result));
  assert.equal(result.live, 'pass', JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.equal(pages.length, 2);
  for (const state of pages) {
    assert.equal(state.clicked, true);
    assert.equal(state.dropped, 0);
    assert(state.frames >= 2);
  }
  assert.equal(client.sent.filter(awaited).length, 0, JSON.stringify(client.sent));
  const waits = unguarded.sent.filter(awaited);
  assert.equal(waits.length, 2);
  for (const wait of waits) {
    const at = unguarded.sent.indexOf(wait);
    const front = unguarded.sent.findLastIndex(
      (call, index) => index < at && call.method === 'Page.bringToFront'
    );
    assert(front >= 0);
    assert.equal(unguarded.sent[front].sessionId, wait.sessionId);
  }
  assert.deepEqual(dispatched(client), ['mousePressed', 'mouseReleased']);
  assert.deepEqual(dispatched(unguarded), ['mousePressed', 'mouseReleased']);
});

test('C9.page-drivable bounds the frame wait on a page that never paints and still needs the click', {
  timeout: 60000,
}, async () => {
  const { result, client, unguarded, pages } = await row(false);
  assert.equal(result.control, 'fail', JSON.stringify(result));
  assert.equal(result.guarded, 'fail', JSON.stringify(result));
  assert.equal(result.live, 'pass', JSON.stringify(result));
  assert.equal(result.why, 'control click: got false, want true; click: got false, want true');
  assert.deepEqual(result.errors, []);
  assert.equal(result.observations.control.click, false);
  assert.equal(result.observations.guarded.click, false);
  assert.equal(pages.length, 2);
  for (const state of pages) {
    assert.equal(state.frames, 0);
    assert.equal(state.clicked, false);
    assert.equal(state.dropped, 2);
    assert.equal(state.callbacks.length, 1);
  }
  assert.equal(unguarded.sent.filter(awaited).length, 2);
  assert.deepEqual(dispatched(client), ['mousePressed', 'mouseReleased']);
  assert.deepEqual(dispatched(unguarded), ['mousePressed', 'mouseReleased']);
});
