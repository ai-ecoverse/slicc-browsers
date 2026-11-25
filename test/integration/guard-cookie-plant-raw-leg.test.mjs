import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { cookiePlantFake } from './cookie-plant-fake.mjs';
import { emulatedGuard } from './guard-emulator.mjs';
import { verdictProblems } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const vector = set.vectors.find((v) => v.id === 'C10.cookie-plant');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pauseOf = (scale) => Math.min(Math.round(5000 * scale), 2000);
const pauseMs = pauseOf(0.1);
const caps = { requestInterception: true, fetchInterception: true, legacyInterception: true };
const guardedDoor = (url) => /[?&]n=door-guard-[^&]*-guarded-/.test(url);
const guardedPlant = (url) => /[?&]n=plant-guard-[^&]*-guarded-/.test(url);
const jarReads = ['Storage.getCookies', 'Network.getAllCookies', 'Network.getCookies'];

function pruned(paths) {
  const keys = new Set(paths.flatMap((p) => [`${p}Planted`, `${p}Answered`, `${p}Refused`]));
  const keep = (expected) =>
    Object.fromEntries(Object.entries(expected ?? {}).filter(([key]) => keys.has(key)));
  return {
    ...vector,
    targets: ['vault'],
    expected: keep(vector.expected),
    control: { ...vector.control, expected: keep(vector.control.expected) },
    observe: Object.fromEntries(Object.entries(vector.observe).filter(([key]) => keys.has(key))),
  };
}

function fakeReader(reader, intercept) {
  const pausedUrl = (requestId) =>
    reader.events.find(
      (event) => event.method === 'Fetch.requestPaused' && event.params?.requestId === requestId
    )?.params?.request?.url ?? '';
  return {
    ...reader,
    get events() {
      return reader.events;
    },
    send: (method, params = {}, sessionId) => {
      const assigned = /location\.assign\("([^"]+)"\)/.exec(params.expression ?? '')?.[1] ?? '';
      const call = {
        method,
        params,
        assigned: method === 'Runtime.evaluate' ? assigned : '',
        paused: params.requestId ? pausedUrl(params.requestId) : '',
        forward: (next = params) => reader.send(method, next, sessionId),
      };
      return intercept(call) ?? call.forward();
    },
  };
}

const onAssign =
  (match, answer) =>
  ({ assigned, forward }) =>
    assigned && match(assigned) ? answer(forward) : undefined;

const issuedNoPause = async () => ({ result: { type: 'undefined' } });
const neverIssued = () => new Promise(() => {});
const slowNoPause = (ms) => async () => {
  await sleep(ms);
  return { result: { type: 'undefined' } };
};
const slowThenLate = (bound) => async (forward) => {
  await sleep(Math.round(bound * 0.6));
  setTimeout(() => forward().catch(() => {}), Math.round(bound * 0.6));
  return { result: { type: 'undefined' } };
};

const doorUnstored = ({ method, params, paused, forward }) =>
  method === 'Fetch.fulfillRequest' && guardedDoor(paused)
    ? forward({
        ...params,
        responseHeaders: params.responseHeaders.filter((h) => !/^set-cookie$/i.test(h.name)),
      })
    : undefined;

const doorJarUnreadable = () => {
  let fulfilled = false;
  return ({ method, paused }) => {
    if (method === 'Fetch.fulfillRequest' && guardedDoor(paused)) fulfilled = true;
    return fulfilled && jarReads.includes(method)
      ? Promise.reject(new Error('jar read rejected'))
      : undefined;
  };
};

async function plant({ paths, intercept = null, guard = null, settleScale = 0.1 }) {
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
          ...guard,
        })
      : null;
    const selected = { ...set, vectors: [pruned(paths)], variants: { prompt: 0 } };
    try {
      const out = await run(selected, {
        client: guarded?.client ?? browser.client,
        unguarded: intercept ? fakeReader(browser.unguarded, intercept) : browser.unguarded,
        fixture,
        settleScale,
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
      return { row: out.results[0], summary: out.summary(), selected };
    } finally {
      await guarded?.stop?.();
    }
  } finally {
    await fixture.close();
  }
}

const shown = (row) => [row.control, row.guarded, row.live].join('/');
const doorNote = (row) =>
  JSON.parse(
    (row.notes ?? [])
      .find((n) => n.startsWith('guarded cookie-plant.raw.door: '))
      ?.slice('guarded cookie-plant.raw.door: '.length) ?? 'null'
  );

test('a raw-leg pause that never arrives leaves live incomplete naming the premise, not fail', async () => {
  const { row, summary, selected } = await plant({
    paths: ['fulfillArray', 'ordinary'],
    intercept: onAssign(guardedDoor, issuedNoPause),
  });
  assert.equal(shown(row), 'pass/incomplete/incomplete', JSON.stringify(row));
  assert.deepEqual(row.incomplete, ['guarded cookiePlant: raw leg: no pause'], JSON.stringify(row));
  assert.match(row.why, /incomplete: guarded cookiePlant: raw leg: no pause/);
  assert.doesNotMatch(row.why, /not live/);
  assert.deepEqual(
    ['control', 'guarded', 'live'].map((side) => summary.counts[side].fail),
    [0, 0, 0]
  );
  assert.ok(
    verdictProblems(selected, ['vault'], [row]).some((p) =>
      p.includes('but is pass/incomplete/incomplete')
    )
  );
});

for (const [name, intercept, premise] of [
  ['unstored door', () => doorUnstored, 'raw leg: Chrome did not store'],
  ['unreadable jar', doorJarUnreadable, 'cookie jar unreadable'],
]) {
  test(`a raw-leg ${name} leaves live incomplete naming the premise, not fail`, async () => {
    const { row } = await plant({ paths: ['fulfillArray', 'ordinary'], intercept: intercept() });
    assert.equal(shown(row), 'pass/incomplete/incomplete', JSON.stringify(row));
    assert.ok(
      row.incomplete.some((reason) => reason.startsWith(`guarded cookiePlant: ${premise}`)),
      JSON.stringify(row)
    );
  });
}

test('a raw-leg note records the wait, the bound and the issued trigger', async () => {
  const { row } = await plant({
    paths: ['fulfillArray'],
    intercept: onAssign(guardedDoor, issuedNoPause),
  });
  const door = doorNote(row);
  assert.equal(door?.incomplete, 'raw leg: no pause', JSON.stringify(row.notes));
  assert.equal(door.pauseMs, pauseMs, JSON.stringify(door));
  assert.equal(door.triggerIssued, true, JSON.stringify(door));
  assert.equal(door.triggerSettled, true, JSON.stringify(door));
  assert.equal(door.pauseSeen, false, JSON.stringify(door));
  assert.ok(door.waitMs >= pauseMs, JSON.stringify(door));
  assert.ok(door.triggerSettledMs < pauseMs, JSON.stringify(door));
});

test('a raw-leg trigger that is never issued says so in the notes', async () => {
  const { row } = await plant({
    paths: ['fulfillArray'],
    intercept: onAssign(guardedDoor, neverIssued),
  });
  assert.equal(shown(row), 'pass/incomplete/incomplete', JSON.stringify(row));
  const door = doorNote(row);
  assert.equal(door?.incomplete, 'raw leg: no pause', JSON.stringify(row.notes));
  assert.equal(door.triggerIssued, false, JSON.stringify(door));
  assert.equal(door.triggerSettled, false, JSON.stringify(door));
  assert.equal(door.triggerSettledMs, null, JSON.stringify(door));
  assert.equal(door.pauseMs, pauseMs, JSON.stringify(door));
  assert.ok(door.waitMs >= pauseMs, JSON.stringify(door));
});

test('a late pause after a slow trigger, inside the bound pushed back by the settle cap, passes', async () => {
  const { row } = await plant({
    paths: ['fulfillArray', 'ordinary'],
    intercept: onAssign(guardedDoor, slowThenLate(pauseOf(0.2))),
    settleScale: 0.2,
  });
  assert.equal(shown(row), 'pass/fail/pass', JSON.stringify(row));
  assert.equal(row.incomplete, undefined, JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
});

test('a slow trigger that never pauses waits at most pauseMs plus the settle cap', async () => {
  const bound = pauseOf(0.5);
  const settleMs = Math.min(Math.round(5000 * 0.5), 500);
  const { row } = await plant({
    paths: ['fulfillArray'],
    intercept: onAssign(guardedDoor, slowNoPause(Math.round(bound * 0.9))),
    settleScale: 0.5,
  });
  assert.equal(shown(row), 'pass/incomplete/incomplete', JSON.stringify(row));
  const door = doorNote(row);
  assert.equal(door?.incomplete, 'raw leg: no pause', JSON.stringify(row.notes));
  assert.equal(door.pauseMs, bound, JSON.stringify(door));
  assert.equal(door.settleMs, settleMs, JSON.stringify(door));
  assert.equal(door.triggerIssued, true, JSON.stringify(door));
  assert.ok(door.triggerSettledMs > settleMs, JSON.stringify(door));
  assert.ok(door.waitMs >= bound + settleMs, JSON.stringify(door));
  assert.ok(door.waitMs <= bound + settleMs + 150, JSON.stringify(door));
});

for (const [where, nth, missed] of [
  ['another path', 2, 'fulfillLower'],
  ['the leaking path', 1, 'fulfillArray'],
]) {
  test(`a leaking guard with positive evidence fails although ${where} missed its raw-leg pause`, async () => {
    let raws = 0;
    const { row } = await plant({
      paths: ['fulfillArray', 'fulfillLower'],
      intercept: onAssign((url) => guardedPlant(url) && ++raws === nth, issuedNoPause),
      guard: { allowPlantPaths: ['fulfillArray'], admitProtectedNavigation: true },
    });
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
    assert.ok(
      (row.notes ?? []).some(
        (n) => n.startsWith(`guarded cookie-plant.raw.${missed}: `) && /raw leg: no pause/.test(n)
      ),
      JSON.stringify(row.notes)
    );
  });
}
