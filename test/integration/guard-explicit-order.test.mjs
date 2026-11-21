import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { origins } from './cdp-client.mjs';
import { explicitBrowser } from './explicit-attach-fake.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const ids = ['C3.tab-attach.explicit', 'C3.tab-protected.explicit'];
const capabilities = { explicitAttach: true, browserSession: true, discovery: true };
const current = set.vectors.filter((vector) => ids.includes(vector.id));
const previous = current.map((vector) => ({
  ...structuredClone(vector),
  trigger: structuredClone(vector.trigger).filter((step) => step.as !== 'mapped'),
}));
const names = (vector) =>
  [...vector.setup, ...vector.trigger].map((step) => step.as ?? Object.keys(step)[0]);
const rawId = (id) => typeof id === 'string' && /^(PAGE|TAB)\d+$/.test(id);

function tabTransport({ client, unguarded }, { hide = false } = {}) {
  const tabs = new Map();
  const raws = new Map();
  const given = new Set();
  const alias = (raw) => {
    if (!tabs.has(raw)) {
      const tab = String(tabs.size + 1);
      tabs.set(raw, tab);
      raws.set(tab, raw);
    }
    return tabs.get(raw);
  };
  const use = (params) => {
    if (rawId(params?.targetId)) given.add(params.targetId);
  };
  const shown = (value) => {
    if (Array.isArray(value)) return value.map(shown);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value))
      out[key] =
        key === 'targetId' && rawId(item) ? (given.has(item) ? item : alias(item)) : shown(item);
    return out;
  };
  const seen = [];
  const events = () => {
    for (const event of client.events.slice(seen.length)) seen.push(shown(event));
    return seen;
  };
  const guarded = {
    transport: 'tab',
    get events() {
      return events();
    },
    async send(method, params = {}, sessionId) {
      use(params);
      const local =
        typeof params.targetId === 'string' && raws.has(params.targetId)
          ? { ...params, targetId: raws.get(params.targetId) }
          : params;
      const reply = shown(await client.send(method, local, sessionId));
      if (hide && method === 'Target.getTargets')
        reply.targetInfos = reply.targetInfos.filter((info) => !/\/doc\?n=/.test(info.url));
      return reply;
    },
    async waitEvent(predicate, ms = 10000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = events().find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('CDP event timed out');
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
  const observer = {
    events: unguarded.events,
    waitEvent: unguarded.waitEvent,
    async send(method, params = {}, sessionId) {
      use(params);
      return unguarded.send(method, params, sessionId);
    },
  };
  return { client: guarded, unguarded: observer };
}

async function execute(vectors, { tab, mutant = {} } = {}) {
  const fixture = await fixtureServer();
  const targets = origins(fixture);
  const browser = explicitBrowser({ record: (url) => fixture.record(url) });
  const guard = emulatedGuard(browser, {
    explicitAttach: mutant,
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
  });
  const wired = tab
    ? tabTransport({ client: guard.client, unguarded: browser.unguarded }, tab)
    : { client: guard.client, unguarded: browser.unguarded };
  const sent = [];
  const client = {
    transport: wired.client.transport,
    get events() {
      return wired.client.events;
    },
    waitEvent: (...args) => wired.client.waitEvent(...args),
    send(method, params = {}, sessionId) {
      sent.push({ method, params: structuredClone(params), sessionId });
      return wired.client.send(method, params, sessionId);
    },
  };
  try {
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client,
        unguarded: wired.unguarded,
        fixture,
        targets,
        settleScale: 0.2,
        namedResultMs: 2000,
        capabilities,
      }
    );
    return { execution, trace: normalized(sent, fixture.port) };
  } finally {
    await guard.stop();
    await fixture.close();
  }
}

function normalized(sent, port) {
  const seen = new Map();
  const text = JSON.stringify(sent)
    .replaceAll(`:${port}`, ':{port}')
    .replace(/guard-\d+-\d+-\d+-[a-z]+-[0-9a-z]+/g, '{tag}')
    .replace(/\b(PAGE|TAB|SESSION|LOADER|CONTEXT)\d+\b/g, (id) => {
      if (!seen.has(id)) seen.set(id, `id${seen.size + 1}`);
      return seen.get(id);
    });
  return JSON.parse(text);
}

const verdicts = (execution) =>
  execution.results.map((row) => ({
    id: row.id,
    target: row.target,
    legs: [row.control, row.guarded, row.live],
    observations: row.observations,
  }));
const ordinary = (vectors) => vectors.filter((vector) => vector.id === ids[0]);

test('the observer uses the raw target id before the first guarded listing', () => {
  assert.deepEqual(names(previous[0]), [
    'discover',
    'created',
    'settle',
    'raw',
    'listed',
    'info',
    'attach',
    'childPage',
    'childRuntime',
    'childNavigate',
    'settle',
    'reach',
    'settle',
    'relisted',
  ]);
  for (const [index, vector] of current.entries()) {
    const order = names(vector);
    assert.deepEqual(
      order.filter((name) => name !== 'mapped'),
      names(previous[index])
    );
    assert.equal(order.indexOf('mapped'), order.indexOf('raw') + 1, vector.id);
    assert.equal(order.indexOf('listed'), order.indexOf('mapped') + 1, vector.id);
    const mapped = vector.trigger.find((step) => step.as === 'mapped');
    assert.deepEqual(mapped, {
      cdp: 'Target.getTargetInfo',
      params: { targetId: '{rawTarget}' },
      session: 'browser',
      via: 'unguarded',
      as: 'mapped',
      requires: ['explicitAttach'],
    });
    assert.match(vector.observe.listed.means, /after the unguarded observer used that id/);
  }
});

for (const mutant of [{}, { redact: true }])
  test(`${mutant.redact ? 'redacting' : 'hiding'} guard: the guarded client sends the same messages and a raw-id transport gets the same verdicts`, async () => {
    const before = await execute(previous, { mutant });
    const after = await execute(current, { mutant });
    assert.deepEqual(after.trace, before.trace);
    const methods = before.trace.map((call) => call.method);
    assert.equal(methods.filter((method) => method === 'Target.getTargets').length, 6);
    assert.ok(methods.indexOf('Target.getTargets') < methods.indexOf('Target.getTargetInfo'));
    assert.deepEqual(verdicts(after.execution), verdicts(before.execution));
    for (const row of after.execution.results)
      assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], row.why);
  });

test('a transport with tab ids lists the raw target once the observer used it first', async () => {
  const before = await execute(ordinary(previous), { tab: {} });
  const [old] = before.execution.results;
  assert.equal(old.observations.guarded.listed, false);
  assert.equal(old.guarded, 'fail');
  assert.match(old.why, /listed: got false, want true/);
  const after = await execute(ordinary(current), { tab: {} });
  const [row] = after.execution.results;
  assert.equal(row.observations.guarded.listed, true);
  assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], row.why);
  assert.deepEqual(after.trace, before.trace);
});

test('a transport with tab ids that does not list the tab still fails listed', async () => {
  const { execution } = await execute(ordinary(current), { tab: { hide: true } });
  const [row] = execution.results;
  assert.equal(row.observations.guarded.listed, false);
  assert.equal(row.guarded, 'fail');
  assert.match(row.why, /listed: got false, want true/);
});
