import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';

const full = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const targets = {
  ordinary: 'http://ordinary.test',
  seven: 'http://seven.test',
  vault: 'http://vault.test',
  'vault-x': 'http://x.vault.test',
  apex: 'http://apex.test',
  own: 'http://own.test',
  client: 'http://client.test',
};

function browser() {
  const log = [];
  const sessions = new Map();
  let next = 0;
  const pages = new Map();
  const connect = () => {
    const client = { events: [], closed: false, evaluated: [] };
    client.close = () => {
      client.closed = true;
    };
    client.send = async (method, params = {}, sessionId) => {
      if (client.closed) throw new Error('CDP closed');
      if (method === 'Target.createTarget') {
        const targetId = `target-${++next}`;
        pages.set(targetId, 'about:blank');
        return { targetId };
      }
      if (method === 'Target.attachToTarget') {
        const id = `session-${++next}`;
        sessions.set(id, { client, targetId: params.targetId });
        return { sessionId: id };
      }
      if (method === 'Target.detachFromTarget') {
        sessions.delete(params.sessionId);
        return {};
      }
      if (method === 'Target.getTargetInfo')
        return {
          targetInfo: {
            targetId: params.targetId,
            attached: [...sessions.values()].some(
              (s) => s.targetId === params.targetId && !s.client.closed
            ),
          },
        };
      const session = sessions.get(sessionId);
      if (method === 'Page.navigate') {
        log.push({ url: params.url, headers: {} });
        pages.set(session.targetId, params.url);
        const loaderId = `loader-${++next}`;
        client.events.push(
          { method: 'Page.frameNavigated', sessionId, params: { frame: { loaderId } } },
          { method: 'Page.loadEventFired', sessionId, params: {} }
        );
        return { loaderId };
      }
      if (method === 'Runtime.evaluate') {
        client.evaluated.push(params.expression);
        const went = /^go\('(.+)'\)$/.exec(params.expression)?.[1];
        if (went) {
          log.push({ url: went, headers: {} });
          pages.set(session.targetId, went);
          return { result: { value: 'went' } };
        }
        if (params.expression === 'document.title')
          return {
            result: { value: pages.get(session.targetId).includes('/canary/') ? 'canary' : 'doc' },
          };
        return { result: { value: true } };
      }
      return {};
    };
    return client;
  };
  return { log, connect };
}

const vector = {
  id: 'X9.fake-exit',
  family: 'X',
  kind: 'cdp',
  scope: 'any',
  requires: ['clientExit'],
  setup: [{ page: 'tab', url: '{ordinary}/doc?n={tag}' }],
  trigger: [{ client: 'exit' }, { page: 'eval', expression: "go('{target}/canary/{tag}')" }],
  targets: ['seven'],
  observe: {
    before: {
      means: 'the page loaded before the exit',
      check: { served: '/doc', exit: 'before', observer: 'fixture' },
    },
    early: {
      means: 'the destination was served before the exit',
      check: { served: '/canary/{tag}', exit: 'before', observer: 'fixture' },
    },
    after: {
      means: 'the destination was served after the exit',
      check: { served: '{target}/canary/{tag}', exit: 'after', observer: 'fixture' },
    },
    document: {
      means: 'the observer reads the destination',
      check: { title: 'canary', via: 'unguarded', observer: 'unguarded' },
    },
  },
  live: 'the destination loads after the exit',
  liveCheck: { loaded: '{target}/canary/{tag}', observer: 'fixture' },
  control: {
    origin: 'ordinary',
    via: 'guard',
    expected: { before: true, early: false, after: true, document: true },
  },
  expected: { before: true, early: false, after: true, document: true },
};

const execute = (options, vectors = [vector]) =>
  run(
    { ...full, vectors, variants: { prompt: 0 } },
    { targets, capabilities: { clientExit: true }, ...options }
  );

test('a client exit closes the guarded client and drives the rest of the leg through the observer', async () => {
  const b = browser();
  const made = [];
  const execution = await execute({
    fixture: { log: async () => b.log },
    clientFactory: (metadata) => {
      const pair = { leg: metadata.leg, client: b.connect(), unguarded: b.connect() };
      made.push(pair);
      return { ...pair, close: () => pair.unguarded.close() };
    },
  });
  const [row] = execution.results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.live, 'pass', JSON.stringify(row));
  assert.deepEqual(
    made.map((pair) => pair.leg),
    [undefined, 'guarded']
  );
  for (const pair of made) {
    assert.equal(pair.client.closed, true);
    assert.ok(!pair.client.evaluated.some((e) => e.startsWith('go(')));
    assert.ok(pair.unguarded.evaluated.some((e) => e.startsWith("go('")));
  }
  assert.equal(made[1].unguarded.closed, true);
});

test('a client exit row skips with a runner reason when it cannot exit or observe', async () => {
  const b = browser();
  const fixture = { log: async () => b.log };
  const one = b.connect();
  const bare = await execute({ fixture, client: one, unguarded: b.connect() });
  assert.equal(bare.results[0].reason, 'not-supported:clientExit');
  const shared = await execute({ fixture, clientFactory: () => ({ client: one, unguarded: one }) });
  assert.equal(shared.results[0].reason, 'not-supported:unguarded-observer');
  const undeclared = await execute({
    fixture,
    capabilities: {},
    clientFactory: () => ({ client: b.connect(), unguarded: b.connect() }),
  });
  assert.equal(undeclared.results[0].reason, 'not-supported:clientExit');
  for (const execution of [bare, shared, undeclared])
    assert.deepEqual(execution.summary().forged, []);
});

test('a failed second client leaves the guarded leg incomplete, never a pass', async () => {
  const b = browser();
  let calls = 0;
  const execution = await execute({
    fixture: { log: async () => b.log },
    clientFactory: () => {
      calls++;
      if (calls > 1) throw new Error('no second client');
      return { client: b.connect(), unguarded: b.connect() };
    },
  });
  const [row] = execution.results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.live, 'incomplete', JSON.stringify(row));
  assert.deepEqual(row.incomplete, ['guarded clientFactory: no second client']);
  assert.equal(execution.summary().pass, false);
});

test('the shared set has C5.script and X1.after-exit with positive controls', () => {
  const script = full.vectors.find((v) => v.id === 'C5.script');
  assert.deepEqual(script.trigger, [
    { page: 'script', url: '{target}/script?n={tag}', as: 'body' },
  ]);
  assert.equal(script.control.expected.fulfilled, true);
  assert.equal(script.expected.answered, true);
  const exit = full.vectors.find((v) => v.id === 'X1.after-exit');
  assert.deepEqual(exit.requires, ['clientExit']);
  assert.ok(exit.trigger.some((step) => step.client === 'exit'));
  assert.ok(Object.values(exit.control.expected).includes(true));
  assert.equal(exit.expected.served, true);
  assert.equal(exit.expected.paused, false);
  assert.ok(exit.liveCheck);
});

function redacting(tagged) {
  const log = [];
  let next = 0;
  const client = { events: [] };
  client.close = () => {};
  client.send = async (method, params = {}, sessionId) => {
    if (method === 'Target.createTarget') return { targetId: `target-${++next}` };
    if (method === 'Target.attachToTarget') return { sessionId: `session-${++next}` };
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { targetId: params.targetId, attached: true } };
    if (method === 'Page.navigate') {
      log.push({ url: params.url, headers: {} });
      const loaderId = `loader-${++next}`;
      const url = new URL(params.url).searchParams.has('k')
        ? tagged(params.url.replace(/([?&]to=https?:\/\/(?:seven|vault)\.test).*$/, '$1'))
        : params.url;
      client.events.push(
        { method: 'Fetch.requestPaused', sessionId, params: { requestId: 'r', request: { url } } },
        { method: 'Page.frameNavigated', sessionId, params: { frame: { loaderId } } },
        { method: 'Page.loadEventFired', sessionId, params: {} }
      );
      return { loaderId };
    }
    if (method === 'Runtime.evaluate') return { result: { value: true } };
    return {};
  };
  return { log, client };
}

const exitRow = full.vectors.find((v) => v.id === 'X1.after-exit');
const intercepted = (target) => ({
  id: 'X9.redacted-trigger',
  family: 'X',
  kind: 'cdp',
  scope: 'any',
  setup: [{ page: 'tab', url: '{ordinary}/doc?n={tag}' }],
  trigger: [exitRow.trigger[0]],
  targets: [target],
  observe: { intercepted: exitRow.observe.intercepted },
  live: 'the trigger page loads',
  liveCheck: { loaded: exitRow.trigger[0].url, observer: 'fixture' },
  control: { origin: 'ordinary', via: 'guard', expected: { intercepted: true } },
  expected: { intercepted: true },
});

for (const target of ['seven', 'vault'])
  test(`X1.after-exit matches its trigger's Fetch.requestPaused when a guard redacts the protected URL after to= (${target})`, async () => {
    const b = redacting((url) => url);
    const execution = await run(
      { ...full, vectors: [intercepted(target)], variants: { prompt: 0 } },
      { targets, client: b.client, unguarded: b.client, fixture: { log: async () => b.log } }
    );
    const [row] = execution.results;
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.match(
      b.client.events.find((e) => e.params.request?.url.includes(targets[target])).params.request
        .url,
      new RegExp(`&to=${targets[target]}$`)
    );
  });

test("X1.after-exit's intercepted check does not match a paused trigger for another tag", async () => {
  const b = redacting((url) => url.replace(/tag=[^&]+/, 'tag=guard-other'));
  const execution = await run(
    { ...full, vectors: [intercepted('seven')], variants: { prompt: 0 } },
    { targets, client: b.client, unguarded: b.client, fixture: { log: async () => b.log } }
  );
  const [row] = execution.results;
  assert.deepEqual(row.observations, {
    control: { intercepted: false },
    guarded: { intercepted: false },
  });
});
