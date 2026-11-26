import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { fixtureServer } from '../../fixture-server.mjs';
import * as real from '../../guard-runner.mjs';
import { cookiePlantFake } from './cookie-plant-fake.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const caps = { requestInterception: true, fetchInterception: true, legacyInterception: true };
const settle = 'slicc: refused: navigation not settled, retry';
const steps = ['Target.attachToTarget', 'Page.enable', 'Runtime.enable', 'Network.enable'];
const refuseMs = 20;
const gapMs = 400;
const attempts = 4;
const leak = { allowPlantPaths: ['fulfillArray'], admitProtectedNavigation: true };

function pruned(id, target, paths) {
  const vector = set.vectors.find((v) => v.id === id);
  const keys = new Set(
    paths.flatMap((p) => [`${p}Planted`, `${p}Answered`, `${p}Refused`, `${p}Cleared`])
  );
  const keep = (expected) =>
    Object.fromEntries(Object.entries(expected ?? {}).filter(([key]) => keys.has(key)));
  return {
    ...vector,
    targets: [target],
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

function flaky(client, reader, { side, step, errors, tab = 2 }) {
  const state = { tabs: new Set(), order: [], session: undefined, calls: 0, settled: false };
  const leg = (url) => new RegExp(`cookie-plant-guard-.*-${side}-`).test(String(url ?? ''));
  const flake = async () => {
    if (state.settled) return;
    state.calls += 1;
    const error = errors[state.calls - 1];
    if (error === undefined) {
      state.settled = true;
      return;
    }
    await delay(refuseMs);
    throw new Error(error);
  };
  const readerSend = async (method, params = {}, sessionId) => {
    const out = await reader.send(method, params, sessionId);
    if (method === 'Target.createTarget' && leg(params.url)) state.tabs.add(out.targetId);
    return out;
  };
  const clientSend = async (method, params = {}, sessionId) => {
    if (method === 'Target.attachToTarget' && state.tabs.has(params.targetId)) {
      if (!state.order.includes(params.targetId)) state.order.push(params.targetId);
      if (state.order.indexOf(params.targetId) === tab - 1) {
        if (method === step) await flake();
        const out = await client.send(method, params, sessionId);
        state.session = out?.sessionId;
        return out;
      }
    }
    if (method === step && sessionId && sessionId === state.session) await flake();
    return client.send(method, params, sessionId);
  };
  return { state, client: view(client, clientSend), reader: view(reader, readerSend) };
}

async function plant({
  id = 'C10.cookie-plant',
  target = 'seven',
  paths,
  flake,
  guard = {},
  runner = real,
}) {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake({
      protectedHosts: ['seven.sliccy.ai', 'vault.sliccy.ai', ...catalog.protectedOrigins.hosts],
      blockedMarkers: set.vectors.find((v) => v.id === id).blockedMarkers ?? [],
      onNavigate: (url) => fixture.record?.(url),
    });
    const origin = (host) => `http://${host}:${fixture.port}`;
    const guarded = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      credentialOrigins: catalog.credentialOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      cookiePlant: true,
      ...guard,
    });
    const wrapped = flake ? flaky(guarded.client, browser.unguarded, flake) : null;
    try {
      const out = await runner.run(
        { ...set, vectors: [pruned(id, target, paths)], variants: { prompt: 0 } },
        {
          client: wrapped?.client ?? guarded.client,
          unguarded: wrapped?.reader ?? browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: caps,
          targets: {
            ordinary: origin('ordinary.example.test'),
            seven: origin('seven.sliccy.ai'),
            vault: origin('vault.sliccy.ai'),
            idp: origin('ims-na1.adobelogin.com'),
            'idp-stg': origin('ims-na1-stg1.adobelogin.com'),
            own: origin('client.example.test'),
            client: origin('client.example.test'),
            log: origin('log.example.test'),
          },
          catalog,
          credentialOrigins: catalog.credentialOrigins,
          cookiePlantOnlyPaths: paths,
        }
      );
      assert.equal(out.results.length, 1);
      return { row: out.results[0], summary: out.summary(), calls: wrapped?.state.calls ?? 0 };
    } finally {
      await guarded.stop?.();
    }
  } finally {
    await fixture.close();
  }
}

const shown = (row) => [row.control, row.guarded, row.live].join('/');
const dump = (row) =>
  JSON.stringify({ legs: shown(row), why: row.why, incomplete: row.incomplete, notes: row.notes });

function notesOf(row, side, label) {
  const prefix = `${side} ${label}: `;
  return (row.notes ?? [])
    .filter((n) => n.startsWith(prefix))
    .map((n) => JSON.parse(n.slice(prefix.length)));
}

const retryNotes = (row, side) => notesOf(row, side, 'cookie-plant.attach.retry');
const attachNotes = (row, side) => notesOf(row, side, 'cookie-plant.attach');

const baselines = new Map();
function baseline(key, run) {
  if (!baselines.has(key)) baselines.set(key, run());
  return baselines.get(key);
}

const binaryLf = () => baseline('binaryLf', () => plant({ paths: ['binaryLf'] }));
const hostOnly = () =>
  baseline('hostOnly', () =>
    plant({ id: 'C10.cookie-plant.credential', target: 'idp', paths: ['hostOnly'] })
  );
const leaked = () => baseline('leak', () => plant({ paths: ['fulfillArray'], guard: leak }));

function assertSameVerdict(out, base) {
  assert.equal(shown(out.row), shown(base.row), dump(out.row));
  assert.deepEqual(out.row.observations, base.row.observations, dump(out.row));
  assert.deepEqual(out.row.incomplete, base.row.incomplete, dump(out.row));
  assert.equal(out.summary.pass, base.summary.pass, dump(out.row));
}

function assertRetriedOnce(out, base, { path, step, side = 'guarded' }) {
  assertSameVerdict(out, base);
  assert.equal(out.calls, 2, dump(out.row));
  const found = retryNotes(out.row, side);
  assert.equal(found.length, 1, dump(out.row));
  assert.deepEqual(
    Object.keys(found[0]),
    ['path', 'step', 'attempt', 'error', 'elapsedMs'],
    dump(out.row)
  );
  assert.equal(found[0].path, path, dump(out.row));
  assert.equal(found[0].step, step, dump(out.row));
  assert.equal(found[0].attempt, 1, dump(out.row));
  assert.equal(found[0].error, settle, dump(out.row));
  assert.ok(Number.isInteger(found[0].elapsedMs), dump(out.row));
  assert.ok(found[0].elapsedMs >= refuseMs / 2 && found[0].elapsedMs < 800, dump(out.row));
  assert.deepEqual(attachNotes(out.row, side), [], dump(out.row));
}

function assertExhausted(out, { path, step }) {
  const { row, summary } = out;
  assert.equal(shown(row), 'pass/incomplete/pass', dump(row));
  assert.equal(summary.counts.guarded.fail, 0, dump(row));
  assert.equal(summary.counts.guarded.skip, 0, dump(row));
  assert.equal(summary.counts.guarded.pass, 0, dump(row));
  assert.equal(summary.pass, false, dump(row));
  assert.equal(out.calls, attempts, dump(row));
  assert.equal(row.observations.guarded[`${path}Planted`], 'incomplete', dump(row));
  assert.equal(row.observations.guarded[`${path}Answered`], true, dump(row));
  assert.equal(row.observations.guarded[`${path}Refused`], true, dump(row));
  assert.deepEqual(
    row.incomplete.filter((entry) => entry.startsWith(`guarded ${path}`)),
    [`guarded ${path}Planted: fresh tab ${step} refused: ${settle} (after ${attempts} attempts)`],
    dump(row)
  );
  const retried = retryNotes(row, 'guarded');
  assert.deepEqual(
    retried.map(({ path: p, step: s, attempt, error }) => [p, s, attempt, error]),
    [1, 2, 3].map((attempt) => [path, step, attempt, settle]),
    dump(row)
  );
  for (const [index, entry] of retried.entries()) {
    assert.ok(Number.isInteger(entry.elapsedMs), dump(row));
    if (index) assert.ok(entry.elapsedMs - retried[index - 1].elapsedMs >= gapMs, dump(row));
  }
  const found = attachNotes(row, 'guarded');
  assert.equal(found.length, 1, dump(row));
  assert.deepEqual(
    Object.keys(found[0]),
    ['path', 'step', 'refused', 'error', 'elapsedMs', 'retries'],
    dump(row)
  );
  assert.deepEqual(
    [found[0].path, found[0].step, found[0].refused, found[0].error, found[0].retries],
    [path, step, true, settle, attempts - 1],
    dump(row)
  );
  assert.ok(found[0].elapsedMs >= (attempts - 1) * gapMs, dump(row));
  assert.ok(found[0].elapsedMs < 2000, dump(row));
}

const refusal = (text) => /^slicc: refused:/.test(text);

function assertNotRetried(out, { side, path, step, text }) {
  const { row, summary } = out;
  assert.equal(out.calls, 1, dump(row));
  assert.deepEqual(retryNotes(row, side), [], dump(row));
  assert.equal(row[side], 'incomplete', dump(row));
  assert.equal(summary.counts[side].fail, 0, dump(row));
  assert.equal(summary.pass, false, dump(row));
  const found = attachNotes(row, side);
  assert.equal(found.length, 1, dump(row));
  const keys = refusal(text)
    ? ['path', 'step', 'refused', 'error', 'elapsedMs']
    : ['path', 'step', 'error'];
  assert.deepEqual(Object.keys(found[0]), keys, dump(row));
  assert.equal(found[0].step, step, dump(row));
  const reasons = refusal(text)
    ? [`${side} ${path}Planted: fresh tab ${step} refused: ${text}`]
    : ['Planted', 'Answered', 'Refused'].map(
        (field) => `${side} ${path}${field}: fresh tab ${step}: ${text}`
      );
  assert.deepEqual(
    row.incomplete.filter((entry) => entry.startsWith(`${side} ${path}`)),
    reasons,
    dump(row)
  );
  assert.doesNotMatch(row.why, /after \d+ attempts/, dump(row));
}

const once = (step, side = 'guarded', tab = 2) => ({ side, step, errors: [settle], tab });
const always = (step) => ({ side: 'guarded', step, errors: Array(8).fill(settle) });

test('the rows without a refusal that the retry rows are compared with: binaryLf and hostOnly pass, the leak fails, no attach notes', async () => {
  const legs = [
    [await binaryLf(), 'pass/pass/pass'],
    [await hostOnly(), 'pass/pass/pass'],
    [await leaked(), 'pass/fail/pass'],
  ];
  for (const [base, want] of legs) {
    assert.equal(shown(base.row), want, dump(base.row));
    for (const side of ['control', 'guarded']) {
      assert.deepEqual(retryNotes(base.row, side), [], dump(base.row));
      assert.deepEqual(attachNotes(base.row, side), [], dump(base.row));
    }
  }
});

for (const step of steps)
  test(`a guarded binaryLf fresh tab refused once at ${step} with the settle refusal is retried and matches the row without it`, async () =>
    assertRetriedOnce(await plant({ paths: ['binaryLf'], flake: once(step) }), await binaryLf(), {
      path: 'binaryLf',
      step,
    }));

test('a guarded credential hostOnly fresh tab refused once at Page.enable is retried and matches the row without it', async () =>
  assertRetriedOnce(
    await plant({
      id: 'C10.cookie-plant.credential',
      target: 'idp',
      paths: ['hostOnly'],
      flake: once('Page.enable'),
    }),
    await hostOnly(),
    { path: 'hostOnly', step: 'Page.enable' }
  ));

test('a guarded probe tab refused once at Page.enable is retried and matches the row without it', async () =>
  assertRetriedOnce(
    await plant({ paths: ['binaryLf'], flake: once('Page.enable', 'guarded', 1) }),
    await binaryLf(),
    { path: 'probe', step: 'Page.enable' }
  ));

for (const step of ['Target.attachToTarget', 'Page.enable'])
  test(`a guarded fresh tab refused at ${step} on every attempt is incomplete after ${attempts} attempts naming the refusal, never skip, pass or fail`, async () =>
    assertExhausted(await plant({ paths: ['binaryLf'], flake: always(step) }), {
      path: 'binaryLf',
      step,
    }));

test('a guarded probe tab refused on every attempt is incomplete naming the refusal and the attempts', async () => {
  const out = await plant({ paths: ['binaryLf'], flake: { ...always('Page.enable'), tab: 1 } });
  assert.equal(out.calls, attempts, dump(out.row));
  assert.equal(out.row.guarded, 'incomplete', dump(out.row));
  assert.equal(out.summary.counts.guarded.fail, 0, dump(out.row));
  assert.equal(out.summary.pass, false, dump(out.row));
  assert.ok(
    out.row.incomplete.includes(`guarded cookiePlant: ${settle} (after ${attempts} attempts)`),
    dump(out.row)
  );
  assert.deepEqual(
    retryNotes(out.row, 'guarded').map(({ path, attempt }) => [path, attempt]),
    [
      ['probe', 1],
      ['probe', 2],
      ['probe', 3],
    ],
    dump(out.row)
  );
});

test('a guarded fresh tab retried once and then refused with another text stops retrying and names that refusal after 2 attempts', async () => {
  const text = 'slicc: refused: not allowed';
  const out = await plant({
    paths: ['binaryLf'],
    flake: { side: 'guarded', step: 'Page.enable', errors: [settle, text] },
  });
  assert.equal(out.calls, 2, dump(out.row));
  assert.equal(shown(out.row), 'pass/incomplete/pass', dump(out.row));
  assert.equal(out.summary.counts.guarded.fail, 0, dump(out.row));
  assert.deepEqual(
    retryNotes(out.row, 'guarded').map(({ step, attempt, error }) => [step, attempt, error]),
    [['Page.enable', 1, settle]],
    dump(out.row)
  );
  const found = attachNotes(out.row, 'guarded');
  assert.deepEqual(
    found.map(({ error, retries }) => [error, retries]),
    [[text, 1]],
    dump(out.row)
  );
  assert.deepEqual(
    out.row.incomplete.filter((entry) => entry.startsWith('guarded binaryLf')),
    [`guarded binaryLfPlanted: fresh tab Page.enable refused: ${text} (after 2 attempts)`],
    dump(out.row)
  );
});

const others = [
  'slicc: refused: navigation not settled, retry later',
  'slicc: refused: not allowed',
  'slicc: refused: Navigation not settled, retry',
  'slicc: refused: NAVIGATION NOT SETTLED, RETRY',
  'SLICC: REFUSED: NAVIGATION NOT SETTLED, RETRY',
  'slicc: refused: tab: navigation not settled, retry',
  'slicc: refused: navigation not settled, retry ',
  'navigation not settled, retry',
  'Page.enable failed in the fake',
];

const other = (text, runner) =>
  plant({
    paths: ['binaryLf'],
    flake: { side: 'guarded', step: 'Page.enable', errors: [text] },
    runner,
  });

for (const text of others)
  test(`a guarded fresh tab failing Page.enable with ${JSON.stringify(text)} is not retried: one call, today's reason`, async () =>
    assertNotRetried(await other(text), {
      side: 'guarded',
      path: 'binaryLf',
      step: 'Page.enable',
      text,
    }));

const controlRun = (runner) =>
  plant({ paths: ['ordinary'], flake: once('Page.enable', 'control'), runner });

test('a control fresh tab refused with the settle text is never retried: one call, control stays incomplete naming the refusal, the row never passes', async () => {
  const out = await controlRun();
  assertNotRetried(out, { side: 'control', path: 'ordinary', step: 'Page.enable', text: settle });
  assert.equal(out.row.observations.control.ordinaryPlanted, 'incomplete', dump(out.row));
  assert.notEqual(out.row.control, 'pass', dump(out.row));
});

test('a control probe tab refused with the settle text is never retried and the control leg stays incomplete', async () => {
  const out = await plant({ paths: ['ordinary'], flake: once('Page.enable', 'control', 1) });
  assert.equal(out.calls, 1, dump(out.row));
  assert.deepEqual(retryNotes(out.row, 'control'), [], dump(out.row));
  assert.equal(out.row.control, 'incomplete', dump(out.row));
  assert.ok(out.row.incomplete.includes(`control cookiePlant: ${settle}`), dump(out.row));
  assert.equal(out.summary.pass, false, dump(out.row));
});

function assertLeak(out, base) {
  assertSameVerdict(out, base);
  assert.equal(out.row.guarded, 'fail', dump(out.row));
  assert.equal(out.row.observations.guarded.fulfillArrayPlanted, true, dump(out.row));
  assert.match(out.row.why, /fulfillArrayPlanted: got true, want false/, dump(out.row));
  assert.equal(out.summary.counts.guarded.fail, 1, dump(out.row));
  assert.equal(out.calls, 2, dump(out.row));
  assert.equal(retryNotes(out.row, 'guarded').length, 1, dump(out.row));
}

const leakRun = (runner) =>
  plant({ paths: ['fulfillArray'], guard: leak, flake: once('Page.enable'), runner });

test('a leaking guard still fails when the settle retry succeeds', async () =>
  assertLeak(await leakRun(), await leaked()));

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

async function mutant(from, to) {
  const plantFile = new URL('../../cookie-plant.mjs', import.meta.url);
  const runnerFile = new URL('../../guard-runner.mjs', import.meta.url);
  const dir = await mkdtemp(join(tmpdir(), 'attach-retry-'));
  dirs.push(dir);
  const plantSource = swap(await readFile(plantFile, 'utf8'), from, to);
  await writeFile(join(dir, 'cookie-plant.mjs'), linked(plantSource, plantFile));
  const runnerSource = await readFile(runnerFile, 'utf8');
  await writeFile(
    join(dir, 'guard-runner.mjs'),
    linked(runnerSource, runnerFile, ['cookie-plant.mjs'])
  );
  return import(pathToFileURL(join(dir, 'guard-runner.mjs')).href);
}

const exact = "String(out?.error?.message ?? out?.error ?? '') === settleRefusal;";
const notRetriedRun = (text) => (runner) => other(text, runner);
const notRetried = (text) => (out) =>
  assertNotRetried(out, { side: 'guarded', path: 'binaryLf', step: 'Page.enable', text });

const mutants = {
  'a runner that retries on any refusal text': {
    swap: [`!out?.ok && ${exact}`, 'refused(out);'],
    run: notRetriedRun('slicc: refused: not allowed'),
    shows: (out) => out.calls === 2,
    check: notRetried('slicc: refused: not allowed'),
  },
  'a runner that retries on the substring retry': {
    swap: [exact, "String(out?.error?.message ?? out?.error ?? '').includes('retry');"],
    run: notRetriedRun('slicc: refused: navigation not settled, retry later'),
    shows: (out) => out.calls === 2,
    check: notRetried('slicc: refused: navigation not settled, retry later'),
  },
  'a runner that retries on the settle text anywhere in a refusal': {
    swap: [exact, "String(out?.error?.message ?? out?.error ?? '').endsWith('settled, retry');"],
    run: notRetriedRun('slicc: refused: tab: navigation not settled, retry'),
    shows: (out) => out.calls === 2,
    check: notRetried('slicc: refused: tab: navigation not settled, retry'),
  },
  'a runner that matches the settle text case-insensitively': {
    swap: [
      exact,
      "String(out?.error?.message ?? out?.error ?? '').toLowerCase() === settleRefusal;",
    ],
    run: notRetriedRun('SLICC: REFUSED: NAVIGATION NOT SETTLED, RETRY'),
    shows: (out) => out.calls === 2,
    check: notRetried('SLICC: REFUSED: NAVIGATION NOT SETTLED, RETRY'),
  },
  'a runner that retries any failure': {
    swap: [`!out?.ok && ${exact}`, '!out?.ok;'],
    run: notRetriedRun('Page.enable failed in the fake'),
    shows: (out) => out.calls === 2,
    check: notRetried('Page.enable failed in the fake'),
  },
  'a runner that retries the control leg': {
    swap: ['return control ? null : { left: settleRetries', 'return { left: settleRetries'],
    run: controlRun,
    shows: (out) => out.row.control === 'pass' && out.calls === 2,
    check: (out) =>
      assertNotRetried(out, {
        side: 'control',
        path: 'ordinary',
        step: 'Page.enable',
        text: settle,
      }),
  },
  'a runner without retries': {
    swap: ['const settleRetries = 3;', 'const settleRetries = 0;'],
    run: (runner) => plant({ paths: ['binaryLf'], flake: once('Page.enable'), runner }),
    shows: (out) => out.row.guarded === 'incomplete' && out.calls === 1,
    check: async (out) =>
      assertRetriedOnce(out, await binaryLf(), { path: 'binaryLf', step: 'Page.enable' }),
  },
  'a runner with a lower retry bound': {
    swap: ['const settleRetries = 3;', 'const settleRetries = 2;'],
    run: (runner) => plant({ paths: ['binaryLf'], flake: always('Page.enable'), runner }),
    shows: (out) => out.calls === 3,
    check: (out) => assertExhausted(out, { path: 'binaryLf', step: 'Page.enable' }),
  },
  'a runner without the retry gap': {
    swap: ['await pause(settleGapMs);', ''],
    run: (runner) => plant({ paths: ['binaryLf'], flake: always('Page.enable'), runner }),
    shows: (out) => attachNotes(out.row, 'guarded')[0]?.elapsedMs < gapMs,
    check: (out) => assertExhausted(out, { path: 'binaryLf', step: 'Page.enable' }),
  },
  'a runner without the attempt count in the reason': {
    swap: ["return tries ? ` (after ${tries + 1} attempts)` : '';", "return '';"],
    run: (runner) => plant({ paths: ['binaryLf'], flake: always('Page.enable'), runner }),
    shows: (out) =>
      out.row.incomplete.includes(
        `guarded binaryLfPlanted: fresh tab Page.enable refused: ${settle}`
      ),
    check: (out) => assertExhausted(out, { path: 'binaryLf', step: 'Page.enable' }),
  },
  'a runner without the retry notes': {
    swap: ['  noteRetried(name, retried, notes);\n', ''],
    run: (runner) => plant({ paths: ['binaryLf'], flake: once('Page.enable'), runner }),
    shows: (out) => out.calls === 2 && retryNotes(out.row, 'guarded').length === 0,
    check: async (out) =>
      assertRetriedOnce(out, await binaryLf(), { path: 'binaryLf', step: 'Page.enable' }),
  },
  'a runner that records a retried tab as incomplete': {
    swap: [
      'return retried.length ? { ...out, retried } : out;',
      'return retried.length ? { ...EMPTY_ATTEMPT, retried } : out;',
    ],
    run: leakRun,
    shows: (out) => out.row.guarded === 'incomplete',
    check: async (out) => assertLeak(out, await leaked()),
  },
};

for (const [name, { swap: change, run, shows, check }] of Object.entries(mutants))
  test(`mutant: ${name} fails its row test`, async () => {
    const out = await run(await mutant(...change));
    assert.ok(shows(out), dump(out.row));
    await assert.rejects(async () => check(out), assert.AssertionError);
  });
