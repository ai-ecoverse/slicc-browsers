import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fixtureServer } from '../../fixture-server.mjs';
import * as real from '../../guard-runner.mjs';
import { cookiePlantFake } from './cookie-plant-fake.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const vector = set.vectors.find((v) => v.id === 'C10.cookie-plant');
const caps = { requestInterception: true, fetchInterception: true, legacyInterception: true };
const generic = 'incomplete, no reason recorded';
const secret = 'secret-cookie-value';
const cap = 200;
const enables = ['Page.enable', 'Runtime.enable', 'Network.enable'];
const fail = (method) =>
  new Error(
    `${method} failed in the fake for http://ordinary.example.test/doc?n=x sid=${secret} ${'x'.repeat(400)}`
  );
const bounded = (method) => `${method} failed in the fake for <url> sid=<value> x`;

function pruned(paths) {
  const keys = new Set(
    paths.flatMap((p) => [`${p}Planted`, `${p}Answered`, `${p}Refused`, `${p}Cleared`])
  );
  const keep = (expected) =>
    Object.fromEntries(Object.entries(expected ?? {}).filter(([key]) => keys.has(key)));
  return {
    ...vector,
    targets: ['seven'],
    expected: keep(vector.expected),
    control: { ...vector.control, expected: keep(vector.control.expected) },
    observe: Object.fromEntries(Object.entries(vector.observe).filter(([key]) => keys.has(key))),
  };
}

const view = (base, send) => ({
  ...base,
  get events() {
    return base.events;
  },
  send,
});

function faulty(client, reader, step) {
  const tabs = new Set();
  const state = { attaches: 0, opened: false, fresh: undefined, session: undefined };
  const control = (url) => /cookie-plant-guard-.*-control-/.test(String(url ?? ''));
  const readerSend = async (method, params = {}, sessionId) => {
    if (step === 'context' && method === 'Target.createBrowserContext') return {};
    const fresh = method === 'Target.createTarget' && control(params.url);
    if (fresh && step === 'open' && state.attaches === 1 && !state.opened) {
      state.opened = true;
      throw fail(method);
    }
    const out = await reader.send(method, params, sessionId);
    if (fresh) tabs.add(out.targetId);
    if (
      step === 'context' &&
      method === 'Target.getTargetInfo' &&
      params.targetId === state.fresh
    ) {
      const { browserContextId: _, ...targetInfo } = out.targetInfo;
      return { ...out, targetInfo };
    }
    return out;
  };
  const clientSend = async (method, params = {}, sessionId) => {
    if (method === 'Target.attachToTarget' && tabs.has(params.targetId)) {
      state.attaches += 1;
      if (state.attaches === 2) {
        state.fresh = params.targetId;
        if (step === method) throw fail(method);
        if (step === 'missing page session') return {};
        const out = await client.send(method, params, sessionId);
        state.session = out.sessionId;
        return out;
      }
    }
    if (sessionId && sessionId === state.session) {
      if (method === step) throw fail(method);
      if (
        step === 'transport' &&
        ['Fetch.enable', 'Network.setRequestInterception'].includes(method)
      )
        throw fail(method);
    }
    return client.send(method, params, sessionId);
  };
  return { client: view(client, clientSend), reader: view(reader, readerSend) };
}

async function plant({ paths, only = paths, guard = true, step, runner = real }) {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake({
      protectedHosts: ['seven.sliccy.ai', 'vault.sliccy.ai', ...catalog.protectedOrigins.hosts],
      blockedMarkers: vector.blockedMarkers ?? [],
      onNavigate: (url) => fixture.record?.(url),
    });
    const origin = (host) => `http://${host}:${fixture.port}`;
    const guarded = guard
      ? emulatedGuard(browser, {
          protectedOrigins: catalog.protectedOrigins,
          credentialOrigins: catalog.credentialOrigins,
          extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
          cookiePlant: true,
        })
      : null;
    const base = guarded?.client ?? browser.client;
    const { client, reader } = step
      ? faulty(base, browser.unguarded, step)
      : { client: base, reader: browser.unguarded };
    try {
      const out = await runner.run(
        { ...set, vectors: [pruned(paths)], variants: { prompt: 0 } },
        {
          client,
          unguarded: reader,
          fixture,
          settleScale: 0.1,
          capabilities: step === 'context' ? { ...caps, browserContexts: true } : caps,
          targets: {
            ordinary: origin('ordinary.example.test'),
            seven: origin('seven.sliccy.ai'),
            vault: origin('vault.sliccy.ai'),
            idp: origin('ims-na1.adobelogin.com'),
            client: origin('client.example.test'),
            log: origin('log.example.test'),
          },
          cookiePlantOnlyPaths: only,
        }
      );
      assert.equal(out.results.length, 1);
      return { row: out.results[0], summary: out.summary() };
    } finally {
      await guarded?.stop?.();
    }
  } finally {
    await fixture.close();
  }
}

const shown = (row) => [row.control, row.guarded, row.live].join('/');
const dump = (row) =>
  JSON.stringify({ legs: shown(row), why: row.why, incomplete: row.incomplete, notes: row.notes });
const named = (side, names) => names.map((name) => `${side} ${name}: ${generic}`);

function assertLeak({ row, summary }) {
  assert.equal(shown(row), 'pass/fail/pass', dump(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, dump(row));
  assert.equal(row.observations.guarded.fulfillObjectPlanted, 'incomplete', dump(row));
  assert.match(row.why, /fulfillArrayPlanted: got true, want false/, dump(row));
  assert.deepEqual(
    row.incomplete,
    named('guarded', ['fulfillObjectPlanted', 'fulfillObjectAnswered', 'fulfillObjectRefused']),
    dump(row)
  );
  assert.equal(summary.counts.guarded.fail, 1, dump(row));
}

function assertControl({ row, summary }) {
  assert.equal(shown(row), 'incomplete/incomplete/pass', dump(row));
  assert.equal(row.observations.control.ordinaryPlanted, 'incomplete', dump(row));
  assert.equal(row.observations.control.adobePlanted, true, dump(row));
  assert.deepEqual(
    row.incomplete,
    [
      ...named('control', ['ordinaryPlanted', 'ordinaryAnswered']),
      ...named('guarded', ['ordinaryPlanted', 'ordinaryAnswered']),
    ],
    dump(row)
  );
  assert.doesNotMatch(row.why, /got incomplete/, dump(row));
  assert.equal(summary.counts.control.fail, 0, dump(row));
  assert.equal(summary.pass, false, dump(row));
}

function assertGuarded({ row, summary }) {
  assert.equal(shown(row), 'pass/incomplete/pass', dump(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, 'incomplete', dump(row));
  assert.equal(row.observations.guarded.ordinaryPlanted, true, dump(row));
  assert.deepEqual(
    row.incomplete,
    named('guarded', ['fulfillArrayPlanted', 'fulfillArrayAnswered', 'fulfillArrayRefused']),
    dump(row)
  );
  assert.equal(summary.counts.guarded.fail, 0, dump(row));
  assert.equal(summary.pass, false, dump(row));
}

const leak = (runner) =>
  plant({
    paths: ['fulfillArray', 'fulfillObject', 'ordinary'],
    only: ['fulfillArray', 'ordinary'],
    guard: false,
    runner,
  });
const controlMiss = (runner) => plant({ paths: ['ordinary', 'adobe'], only: ['adobe'], runner });
const guardedMiss = (runner) =>
  plant({ paths: ['fulfillArray', 'ordinary'], only: ['ordinary'], runner });

test('a guarded leak with an unrelated incomplete observation and no reason stays fail', async () =>
  assertLeak(await leak()));

test('a control observation incomplete without a reason makes the row incomplete naming it', async () =>
  assertControl(await controlMiss()));

test('a guarded observation incomplete without a reason and nothing else wrong is incomplete, never pass', async () =>
  assertGuarded(await guardedMiss()));

const steps = {
  open: { method: 'Target.createTarget' },
  'Target.attachToTarget': { method: 'Target.attachToTarget' },
  ...Object.fromEntries(enables.map((method) => [method, { method }])),
  'missing page session': { error: 'Target.attachToTarget gave no sessionId' },
  transport: { error: `Fetch.enable: ${bounded('Fetch.enable')}` },
  context: { error: 'Target.getTargetInfo gave no browserContextId' },
};

function attachNote(row) {
  const prefix = 'control cookie-plant.attach: ';
  const found = (row.notes ?? []).filter((n) => n.startsWith(prefix));
  assert.equal(found.length, 1, dump(row));
  return JSON.parse(found[0].slice(prefix.length));
}

const blocked = {
  ordinary: ['ordinaryPlanted', 'ordinaryAnswered'],
  deletion: ['deletionAnswered', 'deletionRefused', 'deletionCleared'],
};

function assertMissed({ row, summary }, step, path = 'ordinary') {
  assert.equal(shown(row), 'incomplete/pass/pass', dump(row));
  for (const name of blocked[path])
    assert.equal(row.observations.control[name], 'incomplete', dump(row));
  const found = attachNote(row);
  assert.deepEqual(Object.keys(found), ['path', 'step', 'error'], dump(row));
  assert.equal(found.path, path, dump(row));
  assert.equal(found.step, step, dump(row));
  const { method, error } = steps[step];
  if (method) assert.ok(found.error.startsWith(bounded(method)), dump(row));
  else assert.ok(found.error.startsWith(error), dump(row));
  assert.ok(found.error.length <= cap, dump(row));
  assert.doesNotMatch(found.error, /:\/\/|secret-cookie-value/, dump(row));
  const reason = `fresh tab ${step}: ${found.error}`;
  assert.deepEqual(
    row.incomplete,
    blocked[path].map((name) => `control ${name}: ${reason}`),
    dump(row)
  );
  assert.doesNotMatch(row.why, /no reason recorded|got incomplete/, dump(row));
  assert.equal(summary.counts.control.fail, 0, dump(row));
}

const missed = (step, runner, path = 'ordinary') => plant({ paths: [path], step, runner });

for (const step of Object.keys(steps))
  test(`a control fresh tab that fails at ${step} is incomplete naming ordinaryPlanted and the step`, async () =>
    assertMissed(await missed(step), step));

test('a control deletion fresh tab that fails at Target.attachToTarget is incomplete naming deletionCleared', async () =>
  assertMissed(
    await missed('Target.attachToTarget', real, 'deletion'),
    'Target.attachToTarget',
    'deletion'
  ));

const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function swap(source, from, to) {
  assert.equal(source.split(from).length, 2, `mutation anchor not unique: ${from}`);
  return source.replace(from, () => to);
}

const linked = (source, here, local = []) =>
  source.replaceAll(
    /from '\.\/([^']+)'/g,
    (_, file) => `from '${local.includes(file) ? `./${file}` : new URL(file, here).href}'`
  );

async function mutant({ plant: plantSwap, runner: runnerSwap }) {
  const plantFile = new URL('../../cookie-plant.mjs', import.meta.url);
  const runnerFile = new URL('../../guard-runner.mjs', import.meta.url);
  const dir = await mkdtemp(join(tmpdir(), 'attach-missed-'));
  dirs.push(dir);
  let plantSource = await readFile(plantFile, 'utf8');
  if (plantSwap) plantSource = swap(plantSource, ...plantSwap);
  await writeFile(join(dir, 'cookie-plant.mjs'), linked(plantSource, plantFile));
  let runnerSource = await readFile(runnerFile, 'utf8');
  if (runnerSwap) runnerSource = swap(runnerSource, ...runnerSwap);
  await writeFile(
    join(dir, 'guard-runner.mjs'),
    linked(runnerSource, runnerFile, ['cookie-plant.mjs'])
  );
  return import(pathToFileURL(join(dir, 'guard-runner.mjs')).href);
}

const genericLine =
  'return want === undefined ? undefined : `${name}: incomplete, no reason recorded`;';
const settleLine =
  "if (legs[side].incomplete?.length && filled[side] === 'pass') row[side] = 'incomplete';";
const readLine = "        this.incomplete.push(reason);\n      return 'incomplete';";

test('mutant: without the generic reason the control test fails', async () => {
  const out = await controlMiss(await mutant({ runner: [genericLine, 'return undefined;'] }));
  assert.equal(out.row.control, 'fail', dump(out.row));
  assert.throws(() => assertControl(out), assert.AssertionError);
});

test('mutant: a guarded leak downgraded to incomplete fails the leak test', async () => {
  const runner = await mutant({
    runner: [settleLine, "if (legs[side].incomplete?.length) row[side] = 'incomplete';"],
  });
  const out = await leak(runner);
  assert.equal(out.row.guarded, 'incomplete', dump(out.row));
  assert.throws(() => assertLeak(out), assert.AssertionError);
});

test('mutant: an incomplete leg settled as pass fails the guarded test', async () => {
  const runner = await mutant({
    runner: [settleLine, settleLine.replace("= 'incomplete'", "= 'pass'")],
  });
  const out = await guardedMiss(runner);
  assert.equal(out.row.guarded, 'pass', dump(out.row));
  assert.throws(() => assertGuarded(out), assert.AssertionError);
});

test('mutant: an incomplete observation read as its expectation fails the control test', async () => {
  const runner = await mutant({
    runner: [readLine, readLine.replace("return 'incomplete';", "return want ?? 'incomplete';")],
  });
  const out = await controlMiss(runner);
  assert.equal(out.row.observations.control.ordinaryPlanted, true, dump(out.row));
  assert.throws(() => assertControl(out), assert.AssertionError);
});

const dropped = {
  open: "if (!page.ok) return missedTab(ctx, 'open', page.error);",
  'Target.attachToTarget': 'return missedTab(ctx, attached.step, attached.error);',
  'missing page session':
    "return missedTab(ctx, 'missing page session', 'Target.attachToTarget gave no sessionId');",
  transport: "return missedTab(ctx, 'transport', enabled.error ?? enabled.incomplete);",
  context: "return missedTab(ctx, 'context', 'Target.getTargetInfo gave no browserContextId');",
};

for (const [step, line] of Object.entries(dropped))
  test(`mutant: the ${step} path without its note fails its row test`, async () => {
    const to = line.replace(/return missedTab\(.*\);$/, 'return { ...EMPTY_ATTEMPT };');
    const out = await missed(step, await mutant({ plant: [line, to] }));
    assert.equal(out.row.control, 'incomplete', dump(out.row));
    assert.ok(out.row.incomplete.includes(`control ordinaryPlanted: ${generic}`), dump(out.row));
    assert.throws(() => assertMissed(out, step), assert.AssertionError);
  });

test('mutant: a deletion path without its incomplete cleared fails the deletion row test', async () => {
  const line = "    ...(name === 'deletion' ? { cleared: 'incomplete' } : {}),\n";
  const out = await missed(
    'Target.attachToTarget',
    await mutant({ plant: [line, ''] }),
    'deletion'
  );
  assert.equal(out.row.control, 'fail', dump(out.row));
  assert.equal(out.row.observations.control.deletionCleared, false, dump(out.row));
  assert.throws(
    () => assertMissed(out, 'Target.attachToTarget', 'deletion'),
    assert.AssertionError
  );
});
