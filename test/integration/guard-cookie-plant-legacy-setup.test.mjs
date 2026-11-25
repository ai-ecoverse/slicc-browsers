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
const byId = (id) => set.vectors.find((v) => v.id === id);
const name = 'legacySetupRefused';
const legacySix = ['Headers', 'Raw'].flatMap((kind) =>
  ['Planted', 'Answered', 'Refused'].map((field) => `legacy${kind}${field}`)
);
const missing = "'Network.setRequestInterception' wasn't found";
const secret = 'secret-cookie-value';
const leaky = `slicc: refused: legacy interception for http://seven.sliccy.ai/data?n=x sid=${secret} ${'x'.repeat(400)}`;
const strict = [
  ['C10.cookie-plant', catalog.protectedOrigins.refusal],
  ['C10.cookie-plant.credential', catalog.credentialOrigins.refusal],
  ['C10.cookie-plant', 'slicc: refused: legacy interception is not allowed'],
];
const loose = [
  'legacy interception refused by policy',
  'refused: slicc: legacy interception',
  'Slicc: Refused: legacy interception',
];

function pruned(vector, paths, extra = {}) {
  const keys = new Set([
    name,
    ...paths.flatMap((p) => [`${p}Planted`, `${p}Answered`, `${p}Refused`, `${p}Cleared`]),
  ]);
  const keep = (expected) =>
    Object.fromEntries(Object.entries(expected ?? {}).filter(([key]) => keys.has(key)));
  return {
    ...vector,
    targets: [vector.targets[0]],
    expected: keep(vector.expected),
    control: { ...vector.control, expected: keep(vector.control.expected) },
    observe: Object.fromEntries(
      Object.entries(vector.observe)
        .filter(([key]) => keys.has(key))
        .map(([key, value]) => [key, key === name ? { ...value, ...extra } : value])
    ),
  };
}

function withoutLegacy(conn) {
  const send = conn.send;
  conn.send = async (method, params, sessionId) => {
    if (method === 'Network.setRequestInterception')
      throw Object.assign(new Error(missing), { cdp: { code: -32601, message: missing } });
    return send(method, params, sessionId);
  };
}

const refusing = (base, text) => ({
  ...base,
  get events() {
    return base.events;
  },
  send: async (method, params = {}, sessionId) => {
    if (method === 'Network.setRequestInterception' && (params.patterns ?? []).length)
      throw new Error(text);
    return base.send(method, params, sessionId);
  },
});

async function plant({
  id = 'C10.cookie-plant',
  paths = ['ordinary'],
  chrome = 'missing',
  refusal = null,
  guard = {},
  capabilities = {},
  observation = {},
  runner = real,
} = {}) {
  const fixture = await fixtureServer();
  try {
    const vector = byId(id);
    const browser = cookiePlantFake({
      protectedHosts: ['seven.sliccy.ai', 'vault.sliccy.ai', ...catalog.protectedOrigins.hosts],
      blockedMarkers: vector.blockedMarkers ?? [],
      onNavigate: (url) => fixture.record?.(url),
    });
    if (chrome === 'missing')
      for (const conn of [browser.client, browser.unguarded]) withoutLegacy(conn);
    const origin = (host) => `http://${host}:${fixture.port}`;
    const guarded = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      credentialOrigins: catalog.credentialOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      cookiePlant: true,
      ...guard,
    });
    const client = refusal ? refusing(guarded.client, refusal) : guarded.client;
    try {
      const out = await runner.run(
        { ...set, vectors: [pruned(vector, paths, observation)], variants: { prompt: 0 } },
        {
          client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: { requestInterception: true, fetchInterception: true, ...capabilities },
          targets: {
            ordinary: origin('ordinary.example.test'),
            seven: origin('seven.sliccy.ai'),
            vault: origin('vault.sliccy.ai'),
            idp: origin('ims-na1.adobelogin.com'),
            'idp-stg': origin('ims-na1-stg1.adobelogin.com'),
            client: origin('client.example.test'),
            log: origin('log.example.test'),
          },
          catalog,
          credentialOrigins: catalog.credentialOrigins,
          cookiePlantOnlyPaths: paths,
        }
      );
      assert.equal(out.results.length, 1);
      return { row: out.results[0], summary: out.summary() };
    } finally {
      await guarded.stop?.();
    }
  } finally {
    await fixture.close();
  }
}

const shown = (row) => [row.control, row.guarded, row.live].join('/');
const dump = (row) =>
  JSON.stringify({
    legs: shown(row),
    why: row.why,
    incomplete: row.incomplete,
    notSupported: row.notSupported,
    observations: row.observations,
    notes: row.notes,
  });

function probeNote(row, side = 'guarded') {
  const prefix = `${side} cookie-plant.legacyProbe: `;
  const found = (row.notes ?? []).filter((n) => n.startsWith(prefix));
  assert.ok(found.length > 0, dump(row));
  assert.deepEqual([...new Set(found)], [found[0]], dump(row));
  return JSON.parse(found[0].slice(prefix.length));
}

const notApplicable = (row) =>
  (row.notes ?? []).filter((n) => n.startsWith('guarded cookie-plant.legacySetupRefused: '));

function assertUnchanged({ row, summary }) {
  assert.equal(shown(row), 'pass/pass/pass', dump(row));
  assert.equal(row.observations.control[name], false, dump(row));
  assert.ok(!(row.incomplete ?? []).some((entry) => entry.includes(name)), dump(row));
  assert.deepEqual(summary.forged, [], dump(row));
}

function assertRefused(out, refusal) {
  assertUnchanged(out);
  const { row } = out;
  assert.equal(row.observations.guarded[name], true, dump(row));
  assert.ok(!(row.notSupported ?? []).includes(name), dump(row));
  for (const key of legacySix)
    assert.equal(row.observations.guarded[key] ?? 'not-supported', 'not-supported', dump(row));
  assert.deepEqual(probeNote(row), { ready: false, refused: true, refusal }, dump(row));
  assert.deepEqual(notApplicable(row), [], dump(row));
}

function assertAccepted(out) {
  assertUnchanged(out);
  assert.equal(out.row.observations.guarded[name], false, dump(out.row));
  assert.deepEqual(probeNote(out.row), { ready: true }, dump(out.row));
  assert.deepEqual(notApplicable(out.row), [], dump(out.row));
}

function assertNotApplicable(out) {
  assertUnchanged(out);
  const { row } = out;
  assert.equal(row.observations.guarded[name], 'not-supported', dump(row));
  assert.ok(row.notSupported.includes(name), dump(row));
  assert.deepEqual(
    probeNote(row),
    { ready: false, note: 'legacy unsupported in this Chrome' },
    dump(row)
  );
  assert.deepEqual(
    notApplicable(row),
    ['guarded cookie-plant.legacySetupRefused: "not applicable: no slicc refusal of the setup"'],
    dump(row)
  );
}

const legacyPaths = ['legacyHeaders', 'legacyRaw', 'ordinary'];
const refusedRun = (runner, refusal = catalog.protectedOrigins.refusal, id) =>
  plant({ id, refusal, runner, paths: legacyPaths });
const acceptedRun = (runner) =>
  plant({ chrome: 'accepts', capabilities: { legacyInterception: true }, runner });
const missingRun = (runner) => plant({ runner });
const looseRun = (runner, refusal = loose[0]) => plant({ refusal, runner });

test('legacySetupRefused is on both C10.cookie-plant vectors and is not capability-gated', () => {
  for (const id of ids) {
    const vector = byId(id);
    const observation = vector.observe[name];
    assert.deepEqual(
      observation.check,
      { result: 'probe', path: `result.${name}`, equals: true, observer: 'client' },
      id
    );
    assert.equal(observation.requires, undefined, id);
    assert.equal(observation.unless, undefined, id);
    assert.equal(observation.dependsOn, undefined, id);
    assert.equal(observation.optional, true, id);
    assert.equal(vector.expected[name], 'either', id);
    assert.equal(vector.control.expected[name], false, id);
    assert.ok(vector.designDependent.includes(name), id);
    for (const key of legacySix)
      assert.deepEqual(vector.observe[key].requires, ['legacyInterception']);
  }
});

for (const [id, refusal] of strict)
  test(`${id}: a strict refusal "${refusal}" is true on the guarded leg and false on the control`, async () =>
    assertRefused(await refusedRun(real, refusal, id), refusal));

test('a strict refusal note is bounded, without URLs or cookie values', async () => {
  const out = await refusedRun(real, leaky);
  const { refusal } = probeNote(out.row);
  assert.ok(refusal.startsWith('slicc: refused: legacy interception for <url> sid=<value> x'));
  assert.ok(refusal.length <= 200, refusal);
  assert.doesNotMatch(refusal, /:\/\/|secret-cookie-value/);
  assertRefused(out, refusal);
});

test('a strict refusal on a Chrome that still has the method is credited and the control stays false', async () =>
  assertRefused(
    await plant({
      chrome: 'accepts',
      refusal: catalog.protectedOrigins.refusal,
      paths: legacyPaths,
    }),
    catalog.protectedOrigins.refusal
  ));

test('an accepted legacy setup is false and the row is unchanged', async () =>
  assertAccepted(await acceptedRun()));

test('an accepted legacy setup without legacyInterception declared is false and not forged', async () => {
  const out = await plant({ chrome: 'accepts', paths: ['legacyRaw', 'ordinary'] });
  assertUnchanged(out);
  assert.equal(out.row.observations.guarded[name], false, dump(out.row));
  assert.equal(out.row.observations.guarded.legacyRawPlanted, 'not-supported', dump(out.row));
});

test('a missing method is not applicable: no credit, no incomplete, verdict unchanged', async () =>
  assertNotApplicable(await missingRun()));

test('the credential vector treats a missing method as not applicable', async () =>
  assertNotApplicable(await plant({ id: 'C10.cookie-plant.credential' })));

for (const refusal of loose)
  test(`a non-refusal error "${refusal}" is not applicable, not credited`, async () =>
    assertNotApplicable(await looseRun(real, refusal)));

test('a refusing guard that declares legacyInterception is still forged on the six legacy observations', async () => {
  const { row, summary } = await plant({
    refusal: catalog.protectedOrigins.refusal,
    paths: legacyPaths,
    capabilities: { legacyInterception: true },
  });
  assert.equal(shown(row), 'pass/pass/pass', dump(row));
  assert.equal(row.observations.guarded[name], true, dump(row));
  assert.equal(summary.forged.length, 1, dump(row));
  assert.match(
    summary.forged[0].why,
    /not-supported:legacyRawPlanted while the observation should run/
  );
  assert.doesNotMatch(summary.forged[0].why, new RegExp(name));
});

test('a guard that accepts the setup and lets a legacy path through still fails', async () => {
  const { row } = await plant({
    chrome: 'accepts',
    paths: ['legacyRaw'],
    capabilities: { legacyInterception: true },
    guard: { allowPlantPaths: ['legacyRaw'], admitProtectedNavigation: true },
  });
  assert.equal(row.guarded, 'fail', dump(row));
  assert.equal(row.observations.guarded.legacyRawPlanted, true, dump(row));
  assert.equal(row.observations.guarded[name], false, dump(row));
  assert.match(row.why, /legacyRawPlanted: got true, want false/, dump(row));
});

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
  const dir = await mkdtemp(join(tmpdir(), 'legacy-setup-'));
  dirs.push(dir);
  const plantSource = swap(await readFile(plantFile, 'utf8'), from, to);
  await writeFile(join(dir, 'cookie-plant.mjs'), linked(plantSource, plantFile));
  await writeFile(
    join(dir, 'guard-runner.mjs'),
    linked(await readFile(runnerFile, 'utf8'), runnerFile, ['cookie-plant.mjs'])
  );
  return import(pathToFileURL(join(dir, 'guard-runner.mjs')).href);
}

const setupLine = "legacySetup = legacy.ok ? 'accepted' : refused(legacy) ? 'refused' : null;";

test('mutant: a refusal text looser than the strict definition is credited', async () => {
  const runner = await mutant(
    setupLine,
    setupLine.replace(
      'refused(legacy)',
      '/refused/i.test(String(legacy.error?.message ?? legacy.error))'
    )
  );
  const out = await looseRun(runner);
  assert.equal(out.row.observations.guarded[name], true, dump(out.row));
  assert.throws(() => assertNotApplicable(out), assert.AssertionError);
});

test('mutant: a missing method is credited as a refusal', async () => {
  const runner = await mutant(setupLine, "legacySetup = legacy.ok ? 'accepted' : 'refused';");
  const out = await missingRun(runner);
  assert.equal(out.row.observations.guarded[name], true, dump(out.row));
  assert.throws(() => assertNotApplicable(out), assert.AssertionError);
});

test('mutant: an accepted setup is credited', async () => {
  const line = "if (setup === 'accepted') return false;";
  const out = await acceptedRun(await mutant(line, "if (setup === 'accepted') return true;"));
  assert.equal(out.row.observations.guarded[name], true, dump(out.row));
  assert.throws(() => assertAccepted(out), assert.AssertionError);
});

test('mutant: legacySetupRefused gated on legacyInterception again', async () => {
  const out = await plant({
    refusal: catalog.protectedOrigins.refusal,
    observation: { requires: ['legacyInterception'] },
  });
  assert.equal(out.row.observations.guarded[name], 'not-supported', dump(out.row));
  assert.throws(() => assertRefused(out, catalog.protectedOrigins.refusal), assert.AssertionError);
});

test('mutant: the control leg credited from the guarded client', async () => {
  const runner = await mutant(
    '? await readerLegacySetup(reader, probe.readerSession)',
    '? legacySetupValue(probe.enabled.legacySetup, notes)'
  );
  const out = await refusedRun(runner);
  assert.equal(out.row.observations.control[name], true, dump(out.row));
  assert.equal(out.row.control, 'fail', dump(out.row));
  assert.throws(() => assertRefused(out, catalog.protectedOrigins.refusal), assert.AssertionError);
});
