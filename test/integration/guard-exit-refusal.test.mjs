import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';

const full = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vector = full.vectors.find((row) => row.id === 'X1.after-exit');
const instruments = {
  'Page.addScriptToEvaluateOnNewDocument': 'initScript',
  'Network.setExtraHTTPHeaders': 'extraHeaders',
  'Fetch.enable': 'interception',
};
const targets = {
  ordinary: 'http://ordinary.test',
  seven: 'http://seven.test',
  vault: 'http://vault.test',
  client: 'http://client.test',
};

function transport({ refuse = [], unanswered = [], leak = false, missing = [] } = {}) {
  const log = [];
  const calls = [];
  const pages = new Map();
  const sessions = new Map();
  const pending = new Map();
  let next = 0;
  const commit = (page, url, forged = false) => {
    page.url = url;
    page.forged = forged;
    const active = [...sessions.values()].filter((session) => session.page === page);
    const headers = Object.assign({}, ...active.map((session) => session.headers));
    if (!forged) log.push({ url, headers });
    if (new URL(url).pathname === '/page') page.destination = new URL(url).searchParams.get('to');
    for (const session of active) {
      if (!session.source || missing.includes('beacon')) continue;
      const origin = new URL(url).origin;
      const endpoint = /const u = ("[^"]+")/.exec(session.source)[1];
      const tag = /'\/beacon\?tag=' \+ ("[^"]+")/.exec(session.source)[1];
      log.push({
        url: `${JSON.parse(endpoint)}/beacon?tag=${JSON.parse(tag)}&origin=${encodeURIComponent(origin)}`,
        headers: {},
      });
    }
  };
  const navigate = (page, url) => {
    const interceptor = [...sessions.entries()].find(
      ([, session]) => session.page === page && session.fetch
    );
    if (!interceptor || missing.includes('pause')) return commit(page, url);
    const [sessionId, session] = interceptor;
    const requestId = `request-${++next}`;
    pending.set(requestId, { page, url });
    session.client.events.push({
      method: 'Fetch.requestPaused',
      sessionId,
      params: { requestId, request: { url } },
    });
  };
  const connect = (role) => {
    const client = { events: [], closed: false };
    client.close = () => {
      if (role === 'guard' && leak) return;
      client.closed = true;
      for (const [id, session] of sessions) if (session.client === client) sessions.delete(id);
    };
    client.send = async (method, params = {}, sessionId) => {
      calls.push({ role, method, params, sessionId });
      if (client.closed) throw new Error('CDP closed');
      if (role === 'guard' && instruments[method]) {
        if (refuse.includes(method)) throw new Error('slicc: refused: persistent capability');
        if (unanswered.includes(method)) return new Promise(() => {});
      }
      if (method === 'Target.createTarget') {
        const targetId = `target-${++next}`;
        pages.set(targetId, { url: 'about:blank' });
        return { targetId };
      }
      if (method === 'Target.attachToTarget') {
        const id = `session-${++next}`;
        sessions.set(id, { client, page: pages.get(params.targetId), headers: {} });
        return { sessionId: id };
      }
      if (method === 'Target.detachFromTarget') {
        sessions.delete(params.sessionId);
        return {};
      }
      if (method === 'Target.getTargetInfo')
        return {
          targetInfo: {
            attached: [...sessions.values()].some(
              (session) => session.page === pages.get(params.targetId)
            ),
          },
        };
      if (method === 'Target.closeTarget') return { success: pages.delete(params.targetId) };
      const session = sessions.get(sessionId);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        session.source = params.source;
        return { identifier: `script-${++next}` };
      }
      if (method === 'Network.setExtraHTTPHeaders') {
        session.headers = params.headers;
        return {};
      }
      if (method === 'Fetch.enable') {
        session.fetch = true;
        return {};
      }
      if (method.startsWith('Fetch.continue') || method === 'Fetch.fulfillRequest') {
        const request = pending.get(params.requestId);
        pending.delete(params.requestId);
        commit(request.page, request.url, method === 'Fetch.fulfillRequest');
        return {};
      }
      if (method === 'Page.navigate') {
        navigate(session.page, params.url);
        const loaderId = `loader-${++next}`;
        client.events.push(
          { method: 'Page.frameNavigated', sessionId, params: { frame: { loaderId } } },
          { method: 'Page.loadEventFired', sessionId, params: {} }
        );
        return { loaderId };
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'go()') navigate(session.page, session.page.destination);
        const value =
          params.expression === 'document.title'
            ? session.page.forged
              ? 'forged'
              : session.page.url.includes('/canary/')
                ? 'canary'
                : 'doc'
            : params.expression.includes("includes('FULFILLED')")
              ? session.page.forged === true
              : true;
        return { result: { value } };
      }
      return {};
    };
    return client;
  };
  return { log, calls, connect };
}

async function execute(policy = {}, target = 'seven') {
  const fake = transport(policy);
  const execution = await run(
    { ...full, vectors: [{ ...vector, targets: [target] }], variants: { prompt: 0 } },
    {
      targets,
      capabilities: { clientExit: true },
      fixture: { log: async () => fake.log },
      clientFactory: () => {
        const client = fake.connect('guard');
        const observer = fake.connect('observer');
        const unguarded = policy.observerWithoutClose
          ? { send: observer.send, events: observer.events }
          : observer;
        return {
          client,
          unguarded,
          close: () => {
            client.close();
            observer.close();
          },
        };
      },
      settleScale: 0.01,
      namedResultMs: 1000,
      rowTimeoutMs: 1000,
    }
  );
  return { row: execution.results[0], fake, execution };
}

test('X1 supports an independent observer without close()', async () => {
  const { row } = await execute({
    refuse: Object.keys(instruments),
    observerWithoutClose: true,
  });
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.live, 'pass', JSON.stringify(row));
});

for (const target of ['seven', 'vault'])
  test(`X1 passes when the guard refuses every persistent instrument (${target})`, async () => {
    const { row, fake, execution } = await execute({ refuse: Object.keys(instruments) }, target);
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(execution.summary().pass, true);
    for (const name of Object.values(instruments)) {
      assert.equal(row.observations.control[name], false);
      assert.equal(row.observations.guarded[name], true);
    }
    for (const name of ['instrumented', 'headed', 'intercepted'])
      assert.equal(row.observations.control[name], true);
    for (const name of ['forged', 'scripted', 'probed', 'paused'])
      assert.equal(row.observations.guarded[name], false);
    assert.equal(
      fake.calls.filter((call) => call.method in instruments && call.role === 'guard').length,
      3
    );
  });

test('X1 fails when granted instruments leak after exit', async () => {
  const { row, execution } = await execute({ leak: true });
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  for (const name of ['forged', 'scripted', 'paused'])
    assert.equal(row.observations.guarded[name], true);
  assert.equal(execution.summary().pass, false);
});

test('X1 passes when granted instruments are cleaned up after exit', async () => {
  const { row, execution } = await execute();
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.live, 'pass', JSON.stringify(row));
  for (const name of ['instrumented', 'headed', 'intercepted'])
    assert.equal(row.observations.guarded[name], true);
  for (const name of ['forged', 'scripted', 'probed', 'paused'])
    assert.equal(row.observations.guarded[name], false);
  assert.equal(execution.summary().pass, true);
});

for (const method of Object.keys(instruments)) {
  test(`X1 keeps an unanswered ${method} incomplete`, async () => {
    const { row, execution } = await execute({ unanswered: [method] });
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
    assert.equal(row.observations.guarded[instruments[method]], 'incomplete');
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(execution.summary().pass, false);
    assert.match(row.why, /no answer/);
  });

  test(`X1 checks all post-exit effects when only ${method} is granted`, async () => {
    const refuse = Object.keys(instruments).filter((candidate) => candidate !== method);
    const clean = await execute({ refuse });
    assert.equal(clean.row.guarded, 'pass', JSON.stringify(clean.row));
    const leaky = await execute({ refuse, leak: true });
    assert.equal(leaky.row.guarded, 'fail', JSON.stringify(leaky.row));
  });
}

test('X1 gives leaks precedence over unanswered registration', async () => {
  const { row } = await execute({
    unanswered: ['Page.addScriptToEvaluateOnNewDocument'],
    leak: true,
  });
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.initScript, 'incomplete');
  assert.equal(row.observations.guarded.forged, true);
});

for (const missing of ['beacon', 'pause'])
  test(`X1 does not pass without its pre-exit ${missing} evidence`, async () => {
    const { row, execution } = await execute({ missing: [missing] });
    assert.equal(row.control, 'incomplete', JSON.stringify(row));
    assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
    assert.equal(execution.summary().pass, false);
  });
