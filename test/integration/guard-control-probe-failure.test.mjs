import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { shownRefusal } from '../../extension-frames-rules.mjs';
import { fixtureServer } from '../../fixture-server.mjs';
import * as real from '../../guard-runner.mjs';
import { transport } from './extension-frame-fake.mjs';
import { fakeBrowser as frameReadBrowser, refusal } from './frame-read-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const byId = Object.fromEntries(set.vectors.map((vector) => [vector.id, vector]));
const secret = 'probe-secret-value';
const leaky = `Runtime.evaluate: Uncaught TypeError at http://seven.sliccy.ai/nest/path-${secret}?q=${secret} sid=${secret} ${'x'.repeat(400)}`;
const leakyBounded = 'Runtime.evaluate: Uncaught TypeError at <url> sid=<value> '.padEnd(200, 'x');

function pick(vector, names) {
  const only = (expected) =>
    Object.fromEntries(
      names.filter((name) => name in expected).map((name) => [name, expected[name]])
    );
  return {
    ...vector,
    observe: Object.fromEntries(names.map((name) => [name, vector.observe[name]])),
    expected: only(vector.expected),
    control: { ...vector.control, expected: only(vector.control.expected) },
  };
}

const failingControl = (vector) => ({
  ...vector,
  observe: {
    ...vector.observe,
    unseen: {
      means: 'an event the fake never sends',
      check: { event: 'Slicc.neverSent', observer: 'client' },
    },
  },
  expected: { ...vector.expected, unseen: false },
  control: { ...vector.control, expected: { ...vector.control.expected, unseen: true } },
});

function extensionFrameBrowser() {
  const make = () => {
    const { client } = transport();
    return {
      events: client.events,
      messages: [],
      waitEvent: () => new Promise(() => {}),
      async send(method, params = {}, sessionId) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (method === 'Target.createTarget') return { targetId: 'PAGE' };
        return client.send(method, params, sessionId);
      },
    };
  };
  return { client: make(), unguarded: make() };
}

function childBrowser() {
  const browser = extensionFrameBrowser();
  for (const client of [browser.client, browser.unguarded]) {
    const send = client.send.bind(client);
    client.send = async (method, params = {}, sessionId) => {
      if (method === 'Target.attachToTarget' && params.targetId === 'PAGE') browser.adopt?.();
      if (method !== 'Target.setAutoAttach' || !params.autoAttach || client.child)
        return send(method, params, sessionId);
      client.child = 'CHILD';
      const adopted = new Promise((resolve) => {
        browser.adopt = resolve;
        setTimeout(resolve, 5000).unref();
      });
      client.events.push({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: client.child,
          waitingForDebugger: false,
          targetInfo: { targetId: 'CHILD-TARGET', type: 'iframe', url: 'about:blank' },
        },
      });
      const out = await send(method, params, sessionId);
      await adopted;
      return out;
    };
  }
  return browser;
}

const onChild = (vector) => ({
  ...vector,
  trigger: [
    { children: vector.trigger },
    {
      cdp: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    },
    { cdp: 'Runtime.enable', session: 'child' },
  ],
});

const detached = {
  browser: childBrowser,
  hits: (method, params, browser) =>
    method === 'Target.attachToTarget' &&
    params.targetId === 'PAGE' &&
    Boolean(browser.unguarded.child) &&
    !browser.cut,
  fail: (text, browser) => {
    browser.cut = true;
    browser.adopt();
    browser.unguarded.events.push({
      method: 'Target.detachedFromTarget',
      params: { sessionId: browser.unguarded.child },
    });
    throw new Error(text);
  },
};

const probes = [
  {
    probe: 'extensionFrame',
    vector: pick(byId['C9.frame-transparent'], ['exists', 'attached', 'snapshot', 'frameVisible']),
    browser: extensionFrameBrowser,
    capabilities: { extensionFrame: true, chromeUrlsAttach: true, browserContexts: true },
    hits: (method, params) =>
      method === 'Runtime.evaluate' && String(params.expression).includes('slicc-extension-frame'),
    fail: (text) => ({ result: {}, exceptionDetails: { text } }),
    text: 'Uncaught',
    said: (text) => `extensionFrame observer: ${text}`,
    message: 'extensionFrame observer: Uncaught',
    bounded: 'extensionFrame observer: Uncaught',
  },
  {
    probe: 'frameRead',
    vector: byId['C4.iframe-preattach.blank'],
    browser: () => frameReadBrowser({ guard: 'refuse' }),
    hits: (method, params) => method === 'Page.navigate' && String(params.url).includes('/framed?'),
    fail: (text) => {
      throw new Error(text);
    },
    text: leaky,
    said: (text) => text,
    message: leaky,
    bounded: leakyBounded,
  },
];

function inject(browser, leg, spec, side, text) {
  const send = browser.unguarded.send.bind(browser.unguarded);
  browser.unguarded.send = async (method, params = {}, sessionId) => {
    if (leg.side === side && spec.hits(method, params, browser)) return spec.fail(text, browser);
    return send(method, params, sessionId);
  };
  return browser;
}

async function execute(spec, { side, text = spec.text, vector = spec.vector, runner = real } = {}) {
  const fixture = await fixtureServer();
  const leg = {};
  try {
    const browser = spec.browser();
    if (side) inject(browser, leg, spec, side, text);
    const origin = (host) => `http://${host}:${fixture.port}`;
    const execution = await runner.run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      {
        ...browser,
        fixture,
        settleScale: 0.05,
        ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
        debug: ({ side: at }) => {
          if (at) leg.side = at;
        },
        targets: {
          ordinary: origin('ordinary.example.test'),
          'ordinary-same-site': origin('ordinary.sliccy.ai'),
          plain: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    assert.equal(execution.results.length, 1);
    return { row: execution.results[0], summary: execution.summary() };
  } finally {
    await fixture.close();
  }
}

const shown = (row) =>
  JSON.stringify({
    legs: [row.control, row.guarded, row.live],
    errors: row.errors,
    incomplete: row.incomplete,
    why: row.why,
    control: row.observations?.control,
  });

function assertControlIncomplete({ row, summary }, spec) {
  const reason = `control ${spec.probe}: ${spec.bounded}`;
  assert.deepEqual(
    [row.control, row.guarded, row.live],
    ['incomplete', 'pass', 'pass'],
    shown(row)
  );
  assert.deepEqual(row.errors, [], shown(row));
  assert.deepEqual(row.incomplete, [reason], shown(row));
  assert.equal(row.why, `incomplete: ${reason}`, shown(row));
  for (const [name, want] of Object.entries(spec.vector.control.expected))
    if (want === true) assert.equal(row.observations.control[name], 'incomplete', name);
  assert.equal(JSON.stringify([row.incomplete, row.why]).includes(secret), false, shown(row));
  assert.equal(summary.incomplete, 1);
  assert.deepEqual(summary.forged, []);
}

function assertRowError({ row }, error) {
  assert.deepEqual([row.control, row.guarded], ['fail', 'fail'], shown(row));
  assert.deepEqual(row.errors, [error], shown(row));
  assert.deepEqual(row.incomplete ?? [], [], shown(row));
}

const assertGuardedError = (out, spec) => assertRowError(out, `${spec.probe}: ${spec.message}`);
const assertControlRefusal = (out, spec) =>
  assertRowError(out, `${spec.probe}: ${spec.said(refusal)}`);

function assertStillFails({ row }, spec) {
  assert.equal(row.control, 'fail', shown(row));
  assert.deepEqual(row.errors, [], shown(row));
  assert.deepEqual(row.incomplete, [`control ${spec.probe}: ${spec.bounded}`], shown(row));
  assert.equal(row.observations.control.unseen, false, shown(row));
  assert.match(row.why, /control unseen: got false, want true/, shown(row));
}

const cases = [
  {
    name: 'a non-refusal control probe failure is incomplete',
    side: 'control',
    check: assertControlIncomplete,
  },
  {
    name: 'the same failure on the guarded leg stays a row error',
    side: 'guarded',
    check: assertGuardedError,
  },
  {
    name: 'a control probe refusal stays a row error',
    side: 'control',
    text: refusal,
    check: assertControlRefusal,
  },
  {
    name: 'a control probe failure beside a really failing control observation still fails',
    side: 'control',
    vector: failingControl,
    check: assertStillFails,
  },
  {
    name: 'a control harness error that says refused stays a row error',
    side: 'control',
    text: 'Connection refused',
    check: (out, spec) => assertRowError(out, `${spec.probe}: ${spec.said('Connection refused')}`),
  },
  {
    name: 'a catalog refusal on a detached child session stays a row error',
    side: 'control',
    text: shownRefusal,
    only: 'extensionFrame',
    vector: onChild,
    with: detached,
    check: (out) => assertRowError(out, `extensionFrame: ${shownRefusal}`),
  },
];

const attempt = (spec, { side, text, vector, with: over }, runner = real) =>
  execute(
    { ...spec, ...over },
    {
      side,
      text: text ?? spec.text,
      vector: vector ? vector(spec.vector) : spec.vector,
      runner,
    }
  );

const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function swap(source, from, to) {
  assert.equal(source.split(from).length, 2, `mutation anchor not unique: ${from}`);
  return source.replace(from, () => to);
}

async function mutant(from, to) {
  const here = new URL('../../guard-runner.mjs', import.meta.url);
  const source = swap(await readFile(here, 'utf8'), from, to).replaceAll(
    /from '\.\/([^']+)'/g,
    (_, file) => `from '${new URL(file, here).href}'`
  );
  const dir = await mkdtemp(join(tmpdir(), 'control-probe-'));
  dirs.push(dir);
  const path = join(dir, 'guard-runner.mjs');
  await writeFile(path, source);
  return import(pathToFileURL(path).href);
}

const converted =
  "this.side !== 'control' || refused || protectedRefusal(out) || probe === 'unparseable'";
const strict = 'refused || protectedRefusal(out)';
const settled =
  "if (legs[side].incomplete?.length && filled[side] === 'pass') row[side] = 'incomplete';";
const mutants = [
  {
    name: 'keeps a control probe failure as a row error',
    from: converted,
    to: 'true',
    against: 0,
    shows: (row, spec) => assert.deepEqual(row.errors, [`${spec.probe}: ${spec.message}`]),
  },
  {
    name: 'converts a guarded probe failure too',
    from: converted,
    to: "refused || protectedRefusal(out) || probe === 'unparseable'",
    against: 1,
    shows: (row) => assert.deepEqual(row.errors, []),
  },
  {
    name: 'credits an unmeasured control probe as a pass',
    from: settled,
    to: "if (legs[side].incomplete?.length && filled[side] === 'pass') row[side] = 'pass';",
    against: 0,
    shows: (row) => assert.equal(row.control, 'pass'),
  },
  {
    name: 'drops the probe name from the reason',
    from: 'const reason = `${probe}: ${boundedError(message)}`;',
    to: 'const reason = boundedError(message);',
    against: 0,
    shows: (row, spec) => assert.deepEqual(row.incomplete, [`control ${spec.bounded}`]),
  },
  {
    name: 'keeps the error text unbounded',
    from: '`${probe}: ${boundedError(message)}`',
    to: '`${probe}: ${message}`',
    against: 0,
    only: 'frameRead',
    shows: (row) => assert.deepEqual(row.incomplete, [`control frameRead: ${leaky}`]),
  },
  {
    name: 'reports the failed call again unbounded',
    from: 'this.probeFailures.get(call) ?? ',
    to: '',
    against: 0,
    only: 'frameRead',
    shows: (row) =>
      assert.deepEqual(row.incomplete, [
        `control frameRead: ${leakyBounded}`,
        `control frames failed without a refusal: ${leaky}`,
      ]),
  },
  {
    name: 'converts a control refusal too',
    from: converted,
    to: "this.side !== 'control' || probe === 'unparseable'",
    against: 2,
    shows: (row, spec) =>
      assert.deepEqual(
        [row.errors, row.incomplete],
        [[], [`control ${spec.probe}: ${spec.said(refusal)}`]]
      ),
  },
  {
    name: 'detects a refusal by the substring flag only',
    from: strict,
    to: 'refused',
    against: 5,
    shows: (row) =>
      assert.deepEqual(
        [row.errors, row.incomplete],
        [[], [`control extensionFrame: ${shownRefusal.replace('chrome-extension://)', '<url>')}`]]
      ),
  },
  {
    name: 'detects a refusal by the strict check only',
    from: strict,
    to: 'protectedRefusal(out)',
    against: 2,
    only: 'extensionFrame',
    shows: (row) =>
      assert.deepEqual(
        [row.errors, row.incomplete],
        [[], [`control extensionFrame: extensionFrame observer: ${refusal}`]]
      ),
  },
  {
    name: 'detects a refusal by the strict check only',
    from: strict,
    to: 'protectedRefusal(out)',
    against: 4,
    shows: (row, spec) =>
      assert.deepEqual(
        [row.errors, row.incomplete],
        [[], [`control ${spec.probe}: ${spec.said('Connection refused')}`]]
      ),
  },
  {
    name: 'marks a failing control incomplete without the filled pass',
    from: settled,
    to: "if (legs[side].incomplete?.length) row[side] = 'incomplete';",
    against: 3,
    shows: (row) => assert.equal(row.control, 'incomplete'),
  },
];

test.describe('a control-leg probe that fails without a refusal', {
  concurrency: true,
  timeout: 120000,
}, () => {
  for (const spec of probes) {
    test(`${spec.probe}: the fake passes every leg without a failure`, async () => {
      const { row } = await execute(spec);
      assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], shown(row));
      assert.deepEqual(row.errors, [], shown(row));
    });

    for (const kase of cases.filter(({ only }) => !only || only === spec.probe))
      test(`${spec.probe}: ${kase.name}`, async () => kase.check(await attempt(spec, kase), spec));
  }

  for (const { name, from, to, against, only, shows } of mutants)
    test(`mutant: a runner that ${name} fails "${cases[against].name}"`, async () => {
      const runner = await mutant(from, to);
      const kase = cases[against];
      await Promise.all(
        probes
          .filter((spec) => [only, kase.only].every((name) => !name || spec.probe === name))
          .map(async (spec) => {
            const out = await attempt(spec, kase, runner);
            shows(out.row, spec);
            assert.throws(() => kase.check(out, spec), assert.AssertionError, spec.probe);
          })
      );
    });
});
