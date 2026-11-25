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
import { verdictProblems } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const vector = set.vectors.find((v) => v.id === 'C10.cookie-plant');
const caps = { requestInterception: true, fetchInterception: true, legacyInterception: true };
const scale = 0.1;
const bound = Math.round(2000 * scale);
const step = Math.round(250 * scale);
const jarReads = ['Storage.getCookies', 'Network.getAllCookies', 'Network.getCookies'];
const missed = 'the deleted cookie was still in the jar when the re-read bound ran out';
const controls = ['ordinary', 'adobe', 'deletion'];
const withPlant = ['fulfillArray', ...controls];
const sideOf = (text) => (/-guarded-/.test(text) ? 'guarded' : 'control');

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

function laggingReader(reader, lag, fade = false) {
  const seeds = new Map();
  const reads = { control: 0, guarded: 0, leak: 0 };
  const leak = (cookie) =>
    String(cookie.value).startsWith('p-') && sideOf(String(cookie.value)) === 'guarded';
  const send = async (method, params = {}, sessionId) => {
    const out = await reader.send(method, params, sessionId);
    if (!jarReads.includes(method) || !Array.isArray(out?.cookies)) return out;
    for (const cookie of out.cookies)
      if (String(cookie.value).startsWith('seed-')) seeds.set(cookie.name, { cookie, stale: 0 });
    reads.leak = out.cookies.some(leak) ? reads.leak + 1 : 0;
    const cookies = out.cookies.filter((cookie) => !(fade && leak(cookie) && reads.leak > 1));
    for (const [name, seed] of seeds) {
      if (out.cookies.some((cookie) => cookie.name === name)) continue;
      const side = sideOf(seed.cookie.value);
      reads[side] += 1;
      seed.stale += 1;
      if (seed.stale <= lag[side]) cookies.push(seed.cookie);
    }
    return { ...out, cookies };
  };
  return {
    reads,
    reader: {
      ...reader,
      get events() {
        return reader.events;
      },
      send,
    },
  };
}

function swallowingGuardedDeletion(client) {
  const pausedUrl = (requestId) =>
    client.events.find(
      (event) => event.method === 'Fetch.requestPaused' && event.params?.requestId === requestId
    )?.params?.request?.url ?? '';
  const deletion = (params) =>
    Array.isArray(params?.responseHeaders) &&
    params.responseHeaders.some((h) => /Max-Age=0/i.test(String(h.value)));
  return {
    ...client,
    get events() {
      return client.events;
    },
    send: (method, params = {}, sessionId) =>
      method === 'Fetch.fulfillRequest' &&
      deletion(params) &&
      sideOf(pausedUrl(params.requestId)) === 'guarded'
        ? client.send(
            method,
            {
              ...params,
              responseHeaders: params.responseHeaders.filter((h) => !/^set-cookie$/i.test(h.name)),
            },
            sessionId
          )
        : client.send(method, params, sessionId),
  };
}

async function plant({
  paths,
  lag = { control: 0, guarded: 0 },
  guard = false,
  swallow = false,
  fade = false,
  runner = real,
}) {
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
    const client = guarded?.client ?? browser.client;
    const { reader, reads } = laggingReader(browser.unguarded, lag, fade);
    const selected = { ...set, vectors: [pruned(paths)], variants: { prompt: 0 } };
    try {
      const out = await runner.run(selected, {
        client: swallow ? swallowingGuardedDeletion(client) : client,
        unguarded: reader,
        fixture,
        settleScale: scale,
        capabilities: caps,
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          idp: origin('ims-na1.adobelogin.com'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
        cookiePlantOnlyPaths: paths,
      });
      assert.equal(out.results.length, 1);
      return { row: out.results[0], summary: out.summary(), selected, reads };
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

function clearedNote(row, side) {
  const prefix = `${side} cookie-plant.deletion.cleared: `;
  const found = (row.notes ?? []).filter((n) => n.startsWith(prefix));
  assert.equal(found.length, 1, dump(row));
  return JSON.parse(found[0].slice(prefix.length));
}

function settled(row, side, cleared, tries) {
  const found = clearedNote(row, side);
  assert.equal(found.cleared, cleared, dump(row));
  assert.equal(found.settleBoundMs, bound, dump(row));
  assert.equal(found.settleStepMs, step, dump(row));
  assert.equal(typeof found.settleElapsedMs, 'number', dump(row));
  if (tries === 'bound') {
    assert.ok(found.tries > 2, dump(row));
    assert.ok(found.settleElapsedMs >= bound, dump(row));
  } else {
    assert.equal(found.tries, tries, dump(row));
    assert.ok(found.settleElapsedMs < bound, dump(row));
  }
  return found;
}

function assertLate({ row, summary, selected }, guarded) {
  assert.equal(shown(row), `pass/${guarded}/pass`, dump(row));
  assert.equal(row.observations.control.deletionCleared, true, dump(row));
  assert.equal(row.incomplete, undefined, dump(row));
  assert.equal(summary.incomplete, 0, dump(row));
  settled(row, 'control', true, 3);
  settled(row, 'guarded', true, 1);
  if (guarded === 'fail') assert.deepEqual(verdictProblems(selected, ['seven'], [row]), []);
}

function assertNever({ row, summary }, guarded) {
  assert.equal(shown(row), `incomplete/${guarded}/pass`, dump(row));
  assert.equal(row.observations.control.deletionCleared, 'incomplete', dump(row));
  assert.deepEqual(row.incomplete, [`control deletionCleared: ${missed}`], dump(row));
  assert.equal(summary.counts.control.fail, 0, dump(row));
  assert.equal(summary.incomplete, 1, dump(row));
  assert.equal(summary.pass, false, dump(row));
  const cleared = settled(row, 'control', 'incomplete', 'bound');
  assert.equal(cleared.incomplete, missed, dump(row));
  assert.equal(cleared.jarRead, true, dump(row));
  assert.equal(cleared.canaryVisible, true, dump(row));
  settled(row, 'guarded', true, 1);
}

function assertGuardedLate({ row, summary, reads }) {
  assert.equal(shown(row), 'pass/pass/pass', dump(row));
  assert.equal(row.observations.guarded.deletionCleared, true, dump(row));
  assert.equal(row.incomplete, undefined, dump(row));
  assert.equal(summary.incomplete, 0, dump(row));
  assert.equal(reads.guarded, 4, JSON.stringify(reads));
  settled(row, 'guarded', true, 3);
  settled(row, 'control', true, 1);
}

function assertOverBlock({ row, summary }) {
  assert.equal(shown(row), 'pass/fail/pass', dump(row));
  assert.equal(row.observations.guarded.deletionCleared, false, dump(row));
  assert.match(row.why, /deletionCleared: got false, want true/, dump(row));
  assert.equal(row.incomplete, undefined, dump(row));
  assert.equal(summary.incomplete, 0, dump(row));
  assert.equal(summary.counts.guarded.fail, 1, dump(row));
  const cleared = settled(row, 'guarded', false, 'bound');
  assert.equal(cleared.jarRead, true, dump(row));
  assert.equal(Object.hasOwn(cleared, 'incomplete'), false, dump(row));
  settled(row, 'control', true, 1);
}

function assertLeak({ row, summary, selected }) {
  assert.equal(shown(row), 'pass/fail/pass', dump(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, dump(row));
  assert.match(row.why, /fulfillArrayPlanted: got true, want false/, dump(row));
  assert.equal(row.observations.guarded.deletionCleared, true, dump(row));
  assert.equal(row.incomplete, undefined, dump(row));
  assert.equal(summary.incomplete, 0, dump(row));
  assert.deepEqual(verdictProblems(selected, ['seven'], [row]), []);
  settled(row, 'guarded', true, 3);
  settled(row, 'control', true, 1);
  const prefix = 'guarded cookie-plant.fulfillArray: ';
  const found = (row.notes ?? []).filter((n) => n.startsWith(prefix));
  assert.equal(found.length, 1, dump(row));
  const planted = JSON.parse(found[0].slice(prefix.length));
  assert.equal(planted.planted, true, dump(row));
  assert.equal(Object.hasOwn(planted, 'tries'), false, dump(row));
}

const late = { control: 3, guarded: 0 };
const never = { control: Number.POSITIVE_INFINITY, guarded: 0 };
const guardedLate = { control: 0, guarded: 3 };

test('no guard: a control jar that clears on the third read holds deletionCleared and the row is pass/fail/pass', async () =>
  assertLate(await plant({ paths: withPlant, lag: late }), 'fail'));

test('a correct guard: a control jar that clears on the third read passes the row', async () =>
  assertLate(await plant({ paths: controls, lag: late, guard: true }), 'pass'));

test('a correct guard: a control jar that never clears leaves the row incomplete naming control deletionCleared', async () =>
  assertNever(await plant({ paths: controls, lag: never, guard: true }), 'pass'));

test('no guard: a control jar that never clears is incomplete and the leaking guarded leg still fails', async () => {
  const out = await plant({ paths: withPlant, lag: never });
  assertNever(out, 'fail');
  assert.equal(out.row.observations.guarded.fulfillArrayPlanted, true, dump(out.row));
  assert.ok(
    verdictProblems(out.selected, ['seven'], [out.row]).some(
      (p) => p.includes('but is incomplete/fail/pass') && p.includes('control deletionCleared')
    ),
    dump(out.row)
  );
});

test('a correct guard whose guarded jar clears on the third read passes the row', async () =>
  assertGuardedLate(await plant({ paths: controls, lag: guardedLate, guard: true })));

test('a guard that swallows the guarded deletion fails the guarded leg after the re-read bound', async () =>
  assertOverBlock(await plant({ paths: controls, guard: true, swallow: true })));

test('no guard: a plant seen once then gone still fails the guarded leg while its deletion settles', async () =>
  assertLeak(await plant({ paths: withPlant, lag: guardedLate, fade: true })));

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
  const dir = await mkdtemp(join(tmpdir(), 'deletion-settle-'));
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

const reread = '  if (plantedOf(first) === true) await waitFor(reread, boundMs, stepMs, true);\n';
const bothLegs =
  'const { jar: after, settle } = await settleCleared(handle, deleted, first, ctx.budget);';
const controlOnly =
  'const { jar: after, settle } = ctx.control ? await settleCleared(handle, deleted, first, ctx.budget) : { jar: first, settle: {} };';
const premiseOnControl = 'if (afterPlanted === true && ctx.control) {';
const plantRead =
  "  const jar = await capped(readJarWithCanary(handle, cookie), 1500, 'readJar');\n  const planted = plantedOf(\n    jar?.error?.message?.includes('timeout') ? { incomplete: 'cookie jar unreadable' } : jar\n  );\n  if (planted === true) {";
const plantSettled = plantRead.replace(
  "const jar = await capped(readJarWithCanary(handle, cookie), 1500, 'readJar');",
  "const { jar } = await settleCleared(handle, cookie, await capped(readJarWithCanary(handle, cookie), 1500, 'readJar'));"
);

test('mutant: a control without the re-read fails the late-clearing test', async () => {
  const runner = await mutant(reread, '');
  const out = await plant({ paths: controls, lag: late, guard: true, runner });
  assert.equal(out.row.control, 'incomplete', dump(out.row));
  assert.throws(() => assertLate(out, 'pass'), assert.AssertionError);
});

test('mutant: a guarded leg without the re-read fails the guarded late-clearing test', async () => {
  const runner = await mutant(bothLegs, controlOnly);
  const out = await plant({ paths: controls, lag: guardedLate, guard: true, runner });
  assert.equal(out.row.guarded, 'fail', dump(out.row));
  assert.equal(out.row.observations.guarded.deletionCleared, false, dump(out.row));
  assert.throws(() => assertGuardedLate(out), assert.AssertionError);
});

test('mutant: a guarded miss downgraded to incomplete fails the over-block test', async () => {
  const runner = await mutant(premiseOnControl, 'if (afterPlanted === true) {');
  const out = await plant({ paths: controls, guard: true, swallow: true, runner });
  assert.equal(out.row.guarded, 'incomplete', dump(out.row));
  assert.equal(out.row.observations.guarded.deletionCleared, 'incomplete', dump(out.row));
  assert.throws(() => assertOverBlock(out), assert.AssertionError);
});

test('mutant: the re-read on a guarded planted check fails the leak test', async () => {
  const runner = await mutant(plantRead, plantSettled);
  const out = await plant({ paths: withPlant, lag: guardedLate, fade: true, runner });
  assert.equal(out.row.guarded, 'incomplete', dump(out.row));
  assert.notEqual(out.row.observations.guarded.fulfillArrayPlanted, true, dump(out.row));
  assert.throws(() => assertLeak(out), assert.AssertionError);
});
