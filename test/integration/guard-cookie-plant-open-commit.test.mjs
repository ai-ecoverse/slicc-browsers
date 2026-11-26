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
const ids = ['C10.cookie-plant', 'C10.cookie-plant.credential'];
const caps = { requestInterception: true, fetchInterception: true, legacyInterception: true };
const premise = 'opener page did not commit the requested url';
const notReady = 'opener page did not become ready';
const commitMs = 150;
const sweepMs = 50;
const waitMs = 4000;
const skewMs = 10;
const cap = 200;
const attemptTab = 4;
const both = ['control', 'guarded'];
const mixed = ['binaryLf', 'ordinary'];
const leak = { allowPlantPaths: ['fulfillArray'], admitProtectedNavigation: true };
const openKeys = ['targetId', 'url', 'ready'];
const heldKeys = [...openKeys, 'href', 'requested'];

function pruned(vector, paths) {
  if (!paths) return vector;
  const keys = new Set(
    paths.flatMap((p) => [`${p}Planted`, `${p}Answered`, `${p}Refused`, `${p}Cleared`])
  );
  const keep = (expected) =>
    Object.fromEntries(Object.entries(expected ?? {}).filter(([key]) => keys.has(key)));
  return {
    ...vector,
    expected: keep(vector.expected),
    control: { ...vector.control, expected: keep(vector.control.expected) },
    observe: Object.fromEntries(Object.entries(vector.observe).filter(([key]) => keys.has(key))),
  };
}

const vectorOf = (id, target) => {
  const vector = set.vectors.find((v) => v.id === id);
  return target ? { ...vector, targets: [target] } : vector;
};

function commits({ sides = both, tabs = null, afterMs = commitMs, href = (url) => url } = {}) {
  return () => {
    const counts = {};
    return (url) => {
      const side = sides.find((s) => new RegExp(`cookie-plant-guard-.*-${s}-`).test(url));
      if (!side) return null;
      counts[side] = (counts[side] ?? 0) + 1;
      if (tabs && !tabs.includes(counts[side])) return null;
      return { afterMs, href: href(url) };
    };
  };
}

async function plant({
  vectors = [vectorOf('C10.cookie-plant', 'seven')],
  paths = null,
  commit = null,
  guard = {},
  runner = real,
  settleScale = 0.1,
}) {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake({
      protectedHosts: ['seven.sliccy.ai', 'vault.sliccy.ai', ...catalog.protectedOrigins.hosts],
      blockedMarkers: vectorOf('C10.cookie-plant').blockedMarkers ?? [],
      onNavigate: (url) => fixture.record?.(url),
      ...(commit ? { commit: commit() } : {}),
    });
    const origin = (host) => `http://${host}:${fixture.port}`;
    const guarded = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      credentialOrigins: catalog.credentialOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      cookiePlant: true,
      ...guard,
    });
    try {
      const startedAt = Date.now();
      const out = await runner.run(
        { ...set, vectors: vectors.map((v) => pruned(v, paths)), variants: { prompt: 0 } },
        {
          client: guarded.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale,
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
      return {
        ms: Date.now() - startedAt,
        results: out.results,
        row: out.results[0],
        summary: out.summary(),
        stats: browser.commitStats(),
      };
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

const opens = (row, side) => notesOf(row, side, 'cookie-plant.open');
const attachNotes = (row, side) => notesOf(row, side, 'cookie-plant.attach');
const keyOf = (row) => `${row.id}/${row.target}`;

const baselines = new Map();
function baseline(key, run) {
  if (!baselines.has(key)) baselines.set(key, run());
  return baselines.get(key);
}

const mixedRow = () => baseline('mixed', () => plant({ paths: mixed }));
const hostOnly = () =>
  baseline('hostOnly', () =>
    plant({ vectors: [vectorOf('C10.cookie-plant.credential', 'idp')], paths: ['hostOnly'] })
  );
const leaked = () => baseline('leak', () => plant({ paths: ['fulfillArray'], guard: leak }));
const everyRow = () => baseline('every', () => plant({ vectors: ids.map((id) => vectorOf(id)) }));

function assertPrompt(row, sides = both) {
  for (const side of sides) {
    const found = opens(row, side);
    assert.ok(found.length > 0, dump(row));
    for (const entry of found) {
      assert.deepEqual(Object.keys(entry), openKeys, dump(row));
      assert.equal(entry.ready, true, dump(row));
    }
  }
}

function assertSameRow(row, base) {
  assert.equal(shown(row), shown(base), dump(row));
  assert.deepEqual(row.observations, base.observations, dump(row));
  assert.deepEqual(row.incomplete, base.incomplete, dump(row));
}

function assertSameVerdict(out, base) {
  assertSameRow(out.row, base.row);
  assert.equal(out.summary.pass, base.summary.pass, dump(out.row));
}

function assertHeld(row, sides, { href = (entry) => entry.url, requested = true } = {}) {
  for (const side of both) {
    const found = opens(row, side);
    const held = found.filter((entry) => Object.hasOwn(entry, 'href'));
    if (!sides.includes(side)) {
      assertPrompt(row, [side]);
      continue;
    }
    assert.ok(held.length > 0, dump(row));
    for (const entry of found) {
      assert.equal(entry.ready, true, dump(row));
      if (!Object.hasOwn(entry, 'href')) {
        assert.deepEqual(Object.keys(entry), openKeys, dump(row));
        continue;
      }
      assert.deepEqual(Object.keys(entry), heldKeys, dump(row));
      assert.equal(entry.href, href(entry), dump(row));
      assert.equal(entry.requested, requested, dump(row));
    }
  }
}

function assertCommitted(out, base, sides, held = {}) {
  assertSameVerdict(out, base);
  assert.equal(out.stats.earlyAttaches, 0, dump(out.row));
  assert.ok(out.stats.blankReads > 0, dump(out.row));
  assertHeld(out.row, sides, held);
}

function assertUncommitted(out, side, reasons) {
  const { row, summary } = out;
  assert.equal(row[side], 'incomplete', dump(row));
  for (const verdict of ['fail', 'skip', 'pass'])
    assert.equal(summary.counts[side][verdict], 0, dump(row));
  assert.equal(summary.pass, false, dump(row));
  for (const reason of reasons) assert.ok(row.incomplete.includes(reason), dump(row));
  assert.doesNotMatch(row.why, /no reason recorded/, dump(row));
  const stuck = opens(row, side).filter((entry) => entry.ready !== true);
  assert.equal(stuck.length, 1, dump(row));
  assert.deepEqual(Object.keys(stuck[0]), heldKeys, dump(row));
  assert.deepEqual(
    [stuck[0].ready, stuck[0].href, stuck[0].requested],
    [false, 'about:blank', false],
    dump(row)
  );
  assert.equal(out.stats.earlyAttaches, 0, dump(row));
  assert.ok(out.ms >= waitMs - skewMs && out.ms < waitMs * 2, `${out.ms} ${dump(row)}`);
}

function assertDoorUncommitted(out, side) {
  assertUncommitted(out, side, [`${side} cookiePlant: ${premise}`]);
  assert.deepEqual(out.row.incomplete, [`${side} cookiePlant: ${premise}`], dump(out.row));
}

function assertAttemptUncommitted(out, side) {
  const { row } = out;
  const reason = `fresh tab open: ${premise}`;
  assertUncommitted(out, side, [`${side} ordinaryPlanted: ${reason}`]);
  const ordinary = row.incomplete.filter((entry) => entry.startsWith(`${side} ordinary`));
  assert.ok(ordinary.length >= 2, dump(row));
  for (const entry of ordinary) assert.ok(entry.endsWith(`: ${reason}`), dump(row));
  assert.equal(row.observations[side].ordinaryPlanted, 'incomplete', dump(row));
  assert.deepEqual(
    attachNotes(row, side),
    [{ path: 'ordinary', step: 'open', error: premise }],
    dump(row)
  );
}

const stuck = (side, tabs, runner) =>
  plant({
    paths: ['ordinary'],
    commit: commits({ sides: [side], tabs, afterMs: Infinity }),
    settleScale: tabs[0] === attemptTab ? 0.5 : 0.1,
    runner,
  });
const late = (sides, runner, options = {}) =>
  plant({ paths: mixed, commit: commits({ sides, ...options }), runner });
const longHref = (url) => `${url}&r=${'x'.repeat(300)}`;
const redirected = (url) => `${url}&r=1`;
const upperHost = (url) => url.replace('ordinary.example.test', 'ORDINARY.example.test');
const errorPage = () => 'chrome-error://chromewebdata/';

test('the rows the open-commit rows are compared with: binaryLf, ordinary and hostOnly pass, the leak fails, every open note is { targetId, url, ready: true }', async () => {
  const legs = [
    [await mixedRow(), 'pass/pass/pass'],
    [await hostOnly(), 'pass/pass/pass'],
    [await leaked(), 'pass/fail/pass'],
  ];
  for (const [base, want] of legs) {
    assert.equal(shown(base.row), want, dump(base.row));
    assertPrompt(base.row);
    assert.deepEqual(base.stats, { blankReads: 0, earlyAttaches: 0 }, dump(base.row));
    for (const side of both) assert.deepEqual(attachNotes(base.row, side), [], dump(base.row));
  }
});

test('every existing C10.cookie-plant row keeps its verdict and its open notes when every fresh tab commits promptly', async () => {
  const out = await everyRow();
  assert.deepEqual(
    out.results.map(keyOf),
    ids.flatMap((id) => vectorOf(id).targets.map((target) => `${id}/${target}`))
  );
  for (const row of out.results) {
    assert.equal(shown(row), 'pass/pass/pass', dump(row));
    assert.deepEqual(row.incomplete ?? [], [], dump(row));
    assertPrompt(row);
  }
  assert.equal(out.summary.pass, true);
});

test('every existing C10.cookie-plant row keeps its verdict when every fresh tab of both legs reports about:blank before it commits', async () => {
  const base = await everyRow();
  const out = await plant({
    vectors: ids.map((id) => vectorOf(id)),
    commit: commits({ afterMs: sweepMs }),
  });
  assert.deepEqual(out.results.map(keyOf), base.results.map(keyOf));
  for (const [index, row] of out.results.entries()) {
    assertSameRow(row, base.results[index]);
    for (const side of both)
      for (const entry of opens(row, side)) {
        assert.equal(entry.ready, true, dump(row));
        if (Object.hasOwn(entry, 'href'))
          assert.deepEqual([entry.href, entry.requested], [entry.url, true], dump(row));
      }
  }
  assert.equal(out.summary.pass, base.summary.pass);
  assert.equal(out.stats.earlyAttaches, 0);
  assert.ok(out.stats.blankReads > 0);
});

for (const sides of [['guarded'], ['control'], both])
  test(`${sides.join(' and ')} fresh tabs that report readyState complete on about:blank and commit the requested url after ${commitMs} ms proceed and match the row without the delay`, async () =>
    assertCommitted(await late(sides), await mixedRow(), sides));

test('a guarded credential hostOnly fresh tab that commits late matches the row without the delay', async () =>
  assertCommitted(
    await plant({
      vectors: [vectorOf('C10.cookie-plant.credential', 'idp')],
      paths: ['hostOnly'],
      commit: commits({ sides: ['guarded'] }),
    }),
    await hostOnly(),
    ['guarded']
  ));

function assertLeak(out, base) {
  assertCommitted(out, base, both);
  assert.equal(out.row.guarded, 'fail', dump(out.row));
  assert.equal(out.row.observations.guarded.fulfillArrayPlanted, true, dump(out.row));
  assert.match(out.row.why, /fulfillArrayPlanted: got true, want false/, dump(out.row));
  assert.equal(out.summary.counts.guarded.fail, 1, dump(out.row));
}

const leakRun = (runner) =>
  plant({ paths: ['fulfillArray'], guard: leak, commit: commits(), runner });

test('a leaking guard still fails when every fresh tab commits the requested url late', async () =>
  assertLeak(await leakRun(), await leaked()));

for (const side of both) {
  test(`a ${side} door tab that stays on about:blank with readyState complete for the whole wait is incomplete naming the premise, never skip, pass or fail`, async () =>
    assertDoorUncommitted(await stuck(side, [1]), side));

  test(`a ${side} attempt tab that stays on about:blank with readyState complete for the whole wait is incomplete naming the premise on its observations`, async () =>
    assertAttemptUncommitted(await stuck(side, [attemptTab]), side));
}

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

async function copy(swaps, extra = '') {
  const plantFile = new URL('../../cookie-plant.mjs', import.meta.url);
  const runnerFile = new URL('../../guard-runner.mjs', import.meta.url);
  const dir = await mkdtemp(join(tmpdir(), 'open-commit-'));
  dirs.push(dir);
  let plantSource = await readFile(plantFile, 'utf8');
  for (const [from, to] of swaps) plantSource = swap(plantSource, from, to);
  await writeFile(join(dir, 'cookie-plant.mjs'), `${linked(plantSource, plantFile)}${extra}`);
  const runnerSource = await readFile(runnerFile, 'utf8');
  await writeFile(
    join(dir, 'guard-runner.mjs'),
    linked(runnerSource, runnerFile, ['cookie-plant.mjs'])
  );
  return dir;
}

const mutant = async (...swaps) =>
  import(pathToFileURL(join(await copy(swaps), 'guard-runner.mjs')).href);
const opener = async (...swaps) =>
  (
    await import(
      pathToFileURL(join(await copy(swaps, '\nexport { openPage };\n'), 'cookie-plant.mjs')).href
    )
  ).openPage;

const heldLine = 'return initialEntry(href) && !sameUrl(href, url);';
const sameLine = 'return new URL(a).href === new URL(b).href;';
const readyOnly = [heldLine, 'return false;'];
const reference = () => baseline('reference', () => mutant(readyOnly));

for (const [name, href] of [
  ['another url on the same document path', redirected],
  ['an error page', errorPage],
])
  test(`a fresh tab that has committed ${name} is ready as before: the same row and open notes as a runner that checks readyState only`, async () => {
    const commit = commits({ afterMs: 0, href });
    const out = await plant({ paths: mixed, commit });
    const before = await plant({ paths: mixed, commit, runner: await reference() });
    assertSameVerdict(out, before);
    assertPrompt(out.row);
    assertPrompt(before.row);
    assert.equal(out.stats.blankReads, 0, dump(out.row));
    if (href === redirected) assertSameVerdict(out, await mixedRow());
  });

function assertRedirect(out, base) {
  assertSameVerdict(out, base);
  assertPrompt(out.row);
}

const redirectRun = (runner) =>
  plant({
    paths: mixed,
    commit: commits({ sides: ['guarded'], afterMs: 0, href: redirected }),
    runner,
  });

test('a guarded fresh tab that has committed a redirect at once is ready as before and matches the row without it', async () =>
  assertRedirect(await redirectRun(), await mixedRow()));

const longRun = (runner) => late(both, runner, { href: longHref });
const assertLong = async (out) =>
  assertCommitted(out, await mixedRow(), both, {
    href: (entry) => longHref(entry.url).slice(0, cap),
    requested: false,
  });

test(`fresh tabs that report about:blank and then commit another url wait only for that commit, are ready as before and note the committed href bounded to ${cap} characters`, async () =>
  assertLong(await longRun()));

const upperRun = (runner) => late(both, runner, { href: upperHost });
const assertUpper = async (out) =>
  assertCommitted(out, await mixedRow(), both, { href: (entry) => upperHost(entry.url) });

test('a committed href that differs from the requested url only in the case of its host counts as the requested url', async () =>
  assertUpper(await upperRun()));

const slashRun = async (openPage) => {
  const requested = 'http://Ordinary.Example.Test';
  const committed = 'http://ordinary.example.test/';
  const browser = cookiePlantFake({ commit: () => ({ afterMs: commitMs, href: committed }) });
  const notes = [];
  const startedAt = Date.now();
  const page = await openPage(browser.unguarded, requested, notes, new Set());
  const prefix = 'cookie-plant.open: ';
  return {
    page,
    ms: Date.now() - startedAt,
    requested,
    committed,
    stats: browser.commitStats(),
    opened: notes
      .filter((n) => n.startsWith(prefix))
      .map((n) => JSON.parse(n.slice(prefix.length))),
  };
};

function assertSlash(out) {
  assert.equal(out.page.ok, true, JSON.stringify(out));
  assert.equal(out.page.result.incomplete, undefined, JSON.stringify(out));
  assert.equal(out.opened.length, 1, JSON.stringify(out));
  assert.deepEqual(
    out.opened[0],
    {
      targetId: out.page.result.targetId,
      url: out.requested,
      ready: true,
      href: out.committed,
      requested: true,
    },
    JSON.stringify(out)
  );
  assert.ok(out.stats.blankReads > 0, JSON.stringify(out));
  assert.ok(out.ms >= commitMs - skewMs && out.ms < waitMs, JSON.stringify(out));
}

test('a requested url without its trailing slash and with an upper-case host counts as committed when the tab reports its normalized form', async () =>
  assertSlash(await slashRun(await opener())));

const mixedRun = (runner) => plant({ paths: mixed, runner });

const mutants = {
  'a runner that checks readyState only fails the about:blank row': {
    swap: [readyOnly],
    run: (runner) => stuck('guarded', [attemptTab], runner),
    shows: (out) =>
      !out.row.incomplete?.includes(`guarded ordinaryPlanted: fresh tab open: ${premise}`),
    check: (out) => assertAttemptUncommitted(out, 'guarded'),
  },
  'a runner that checks readyState only fails the late-commit row': {
    swap: [readyOnly],
    run: (runner) => late(['guarded'], runner),
    shows: (out) => out.stats.earlyAttaches > 0,
    check: async (out) => assertCommitted(out, await mixedRow(), ['guarded']),
  },
  'a runner that accepts about:blank as the requested url fails the about:blank row': {
    swap: [[sameLine, `return a === 'about:blank' || ${sameLine.slice('return '.length)}`]],
    run: (runner) => stuck('guarded', [1], runner),
    shows: (out) => !out.row.incomplete?.includes(`guarded cookiePlant: ${premise}`),
    check: (out) => assertDoorUncommitted(out, 'guarded'),
  },
  'a runner that treats about:blank as a committed url fails the control about:blank row': {
    swap: [
      [
        "const initialEntry = (href) => !href || href === 'about:blank';",
        'const initialEntry = (href) => !href;',
      ],
    ],
    run: (runner) => stuck('control', [1], runner),
    shows: (out) => !out.row.incomplete?.includes(`control cookiePlant: ${premise}`),
    check: (out) => assertDoorUncommitted(out, 'control'),
  },
  'a runner that keeps the old reason for a tab that never commits fails the about:blank row': {
    swap: [[`? '${premise}'`, `? '${notReady}'`]],
    run: (runner) => stuck('guarded', [1], runner),
    shows: (out) => out.row.incomplete?.includes(`guarded cookiePlant: ${notReady}`),
    check: (out) => assertDoorUncommitted(out, 'guarded'),
  },
  'a runner without the last href in the open note fails the about:blank row': {
    swap: [['{ href: seen.href.slice(0, 200), requested', '{ requested']],
    run: (runner) => stuck('control', [1], runner),
    shows: (out) => opens(out.row, 'control').every((entry) => !Object.hasOwn(entry, 'href')),
    check: (out) => assertDoorUncommitted(out, 'control'),
  },
  'a runner that waits for the requested url on any other url fails the redirect row': {
    swap: [[heldLine, 'return !sameUrl(href, url);']],
    run: redirectRun,
    shows: (out) => out.row.guarded === 'incomplete',
    check: async (out) => assertRedirect(out, await mixedRow()),
  },
  'a runner that compares urls without normalizing them fails the host-case row': {
    swap: [[sameLine, 'return a === b;']],
    run: upperRun,
    shows: (out) => opens(out.row, 'guarded').some((entry) => entry.requested === false),
    check: assertUpper,
  },
  'a runner with an unbounded href fails the long redirect row': {
    swap: [['href: seen.href.slice(0, 200)', 'href: seen.href']],
    run: longRun,
    shows: (out) => opens(out.row, 'guarded').some((entry) => entry.href?.length > cap),
    check: assertLong,
  },
  'a runner that writes the href on every open fails the prompt row': {
    swap: [['...(seen.held ? {', '...(true ? {']],
    run: mixedRun,
    shows: (out) => opens(out.row, 'guarded').some((entry) => Object.hasOwn(entry, 'href')),
    check: (out) => assertPrompt(out.row),
  },
};

for (const [name, { swap: swaps, run, shows, check }] of Object.entries(mutants))
  test(`mutant: ${name}`, async () => {
    const out = await run(await mutant(...swaps));
    assert.ok(shows(out), dump(out.row));
    await assert.rejects(async () => check(out), assert.AssertionError);
  });

test('mutant: an opener that compares urls without normalizing them fails the trailing-slash row', async () => {
  const out = await slashRun(await opener([sameLine, 'return a === b;']));
  assert.equal(out.opened[0]?.requested, false, JSON.stringify(out));
  assert.throws(() => assertSlash(out), assert.AssertionError);
});
