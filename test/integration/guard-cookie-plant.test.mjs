import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { cookiePlantHandleApi } from '../../cookie-plant.mjs';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { cookiePlantFake } from './cookie-plant-fake.mjs';
import { emulatedGuard } from './guard-emulator.mjs';
import { drivable, capabilities as sweepCaps } from './guard-sweep.mjs';

const { evidenceFormOf, finishPlant } = cookiePlantHandleApi;

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const ids = ['C10.cookie-plant', 'C10.cookie-plant.credential'];
const vectors = set.vectors.filter((v) => ids.includes(v.id));
const protectedVectors = set.vectors.filter((v) => v.id === 'C10.cookie-plant');
const credentialVectors = set.vectors.filter((v) => v.id === 'C10.cookie-plant.credential');

const caps = {
  requestInterception: true,
  fetchInterception: true,
  legacyInterception: true,
};

function targetsOf(fixture, origin) {
  return {
    ordinary: origin('ordinary.example.test'),
    seven: origin('seven.sliccy.ai'),
    vault: origin('vault.sliccy.ai'),
    idp: origin('ims-na1.adobelogin.com'),
    'idp-stg': origin('ims-na1-stg1.adobelogin.com'),
    own: origin('client.example.test'),
    client: origin('client.example.test'),
    log: origin('log.example.test'),
  };
}

const plantHosts = [
  'seven.sliccy.ai',
  'vault.sliccy.ai',
  ...(catalog.protectedOrigins?.hosts ?? []),
];

function observationKeys(path) {
  const keys = [`${path}Planted`, `${path}Answered`, `${path}Refused`];
  if (path === 'deletion') keys.push('deletionCleared');
  return keys;
}

function prunePaths(vector, onlyPaths) {
  if (!Array.isArray(onlyPaths) || !onlyPaths.length) return vector;
  const keep = new Set(onlyPaths.flatMap(observationKeys));
  const filter = (expected) =>
    Object.fromEntries(Object.entries(expected ?? {}).filter(([key]) => keep.has(key)));
  return {
    ...vector,
    expected: filter(vector.expected),
    control: { ...vector.control, expected: filter(vector.control?.expected) },
    observe: Object.fromEntries(
      Object.entries(vector.observe ?? {}).filter(([key]) => keep.has(key))
    ),
  };
}

async function rows(options = {}, subset = protectedVectors) {
  const fixture = await fixtureServer();
  try {
    const {
      capabilities: extraCaps,
      fake: fakeOptions,
      oneTarget = false,
      onlyPaths = null,
      forcedRaw = null,
      withBrowser = false,
      ...guardOptions
    } = options;
    const browser = cookiePlantFake({
      protectedHosts: plantHosts,
      blockedMarkers: protectedVectors[0]?.blockedMarkers ?? [],
      onNavigate: (url) => fixture.record?.(url),
      ...(fakeOptions ?? {}),
    });
    const origin = (host) => `http://${host}:${fixture.port}`;
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      credentialOrigins: catalog.credentialOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      cookiePlant: true,
      ...guardOptions,
    });
    const vectors = subset.map((vector) => {
      const narrowed = oneTarget ? { ...vector, targets: [vector.targets[0]] } : vector;
      return prunePaths(narrowed, onlyPaths);
    });
    try {
      const out = await run(
        { ...set, vectors, variants: { prompt: 0 } },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: {
            ...caps,
            ...extraCaps,
          },
          targets: targetsOf(fixture, origin),
          catalog,
          credentialOrigins: catalog.credentialOrigins,
          cookiePlantOnlyPaths: onlyPaths,
          cookiePlantForcedRaw: forcedRaw,
        }
      );
      return withBrowser ? { out, browser } : out;
    } finally {
      await guard.stop?.();
    }
  } finally {
    await fixture.close();
  }
}

test('requestInterception capability is declared and the row requires it', () => {
  assert.match(set.capabilities.requestInterception, /Fetch\.enable|setRequestInterception/);
  assert.match(set.capabilities.fetchInterception, /Fetch/);
  assert.match(set.capabilities.legacyInterception, /setRequestInterception/);
  assert.equal(vectors.length, 2);
  const vector = protectedVectors[0];
  assert.equal(drivable.has(vector.id), false, vector.id);
  assert.deepEqual(vector.requires, ['requestInterception']);
  assert.equal(vector.control.via, 'guard');
  assert.equal(vector.expected.fulfillArrayPlanted, false);
  assert.deepEqual(Object.keys(vector.control.expected).sort(), [
    'adobeAnswered',
    'adobePlanted',
    'adobeRefused',
    'deletionAnswered',
    'deletionCleared',
    'deletionRefused',
    'ordinaryAnswered',
    'ordinaryPlanted',
  ]);
  assert.equal(vector.control.expected.ordinaryPlanted, true);
  assert.equal(vector.control.expected.adobePlanted, true);
  assert.equal(vector.control.expected.deletionCleared, true);
  assert.equal(vector.expected.binaryLfPlanted, false);
  assert.equal(vector.expected.domainTrailDotPlanted, false);
  assert.equal(vector.expected.ordinaryPlanted, true);
  assert.equal(vector.expected.deletionRefused, false);
  assert.equal(vector.expected.deletionCleared, true);
  assert.equal(vector.expected.adobeRefused, false);
  assert.equal(credentialVectors[0].targets.join(','), 'idp,idp-stg');
  assert.equal(sweepCaps.requestInterception, true);
  assert.equal(sweepCaps.fetchInterception, true);
  assert.equal(sweepCaps.legacyInterception, undefined);
});

test('cookie-plant.mjs ships in the npm package and the packed runner imports', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('cookie-plant.mjs'));
  const directory = await mkdtemp(join(tmpdir(), 'cookie-plant-pack-'));
  try {
    const { stdout } = await execFileAsync('npm', ['pack', '--pack-destination', directory], {
      cwd: root,
      maxBuffer: 10e6,
    });
    const tarball = join(directory, stdout.trim().split('\n').at(-1));
    const { stdout: listing } = await execFileAsync('tar', ['-tzf', tarball]);
    assert.match(listing, /(^|\/)cookie-plant\.mjs$/m);
    assert.match(listing, /(^|\/)guard-runner\.mjs$/m);
    await execFileAsync('tar', ['-xzf', tarball, '-C', directory]);
    const packed = join(directory, 'package');
    const loaded = await import(pathToFileURL(join(packed, 'guard-runner.mjs')).href);
    assert.equal(typeof loaded.run, 'function');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rows use the C10.cookie-plant prefix, not C8. or C6.', () => {
  for (const vector of vectors) {
    assert.ok(vector.id.startsWith('C10.cookie-plant'), vector.id);
    assert.equal(vector.id.startsWith('C8.'), false, vector.id);
    assert.equal(vector.id.startsWith('C6.'), false, vector.id);
  }
  const chromeLike = set.vectors.filter(
    (v) =>
      v.id.startsWith('C8.') &&
      !v.id.startsWith('C8.protected-') &&
      !v.id.startsWith('C8.close-protected.')
  );
  assert.ok(chromeLike.every((v) => !v.id.includes('cookie-plant')));
});

test('without requestInterception the row skips as not-supported', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const out = await run(
      { ...set, vectors: protectedVectors, variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        settleScale: 0.1,
        capabilities: { fetchInterception: true, legacyInterception: true },
        targets: targetsOf(fixture, origin),
      }
    );
    const row = out.results.find((r) => r.id === 'C10.cookie-plant');
    assert.equal(row.guarded, 'skip');
    assert.ok(String(row.reason ?? '').includes('requestInterception'));
  } finally {
    await fixture.close();
  }
});

test('a correct cookiePlant guard passes the row', async () => {
  const out = await rows();
  for (const target of ['seven', 'vault']) {
    const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === target);
    assert.ok(row, target);
    assert.equal(row.control, 'pass', `${target} control ${JSON.stringify(row)}`);
    assert.equal(row.guarded, 'pass', `${target} guarded ${JSON.stringify(row)}`);
    assert.equal(row.live, 'pass', `${target} live ${JSON.stringify(row)}`);
  }
});

test('m1 guarded trigger never fires (dead session) => incomplete, not pass', async () => {
  const out = await rows({
    fake: { deadPageSession: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
});

test('m2 guard blocks and the page ends on data:,blocked (bios shape) => pass', async () => {
  const out = await rows({
    fake: { blockedMarker: 'data:,blocked' },
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some((n) => /"pageHref":"data:,blocked"/.test(n)),
    JSON.stringify(row.notes)
  );
});

test('m3 guard blocks and the page ends on chrome-error (slicc shape) => pass', async () => {
  const out = await rows({
    fake: { blockedMarker: 'chrome-error://chromewebdata/' },
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some((n) => /"pageHref":"chrome-error:\/\/chromewebdata\/"/.test(n)),
    JSON.stringify(row.notes)
  );
});

test('m4 trigger refused by reply but the page left on the home URL => pass', async () => {
  const out = await rows({
    fake: { blockWithoutMarker: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"triggerRefused":true/.test(n) &&
        /"onMarker":false/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('m5 unknown href and no refusal => incomplete', async () => {
  const out = await rows({
    fake: {
      blockWithoutMarker: true,
      settleAssignOk: true,
      finalHref: 'https://unknown.example.test/done',
    },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
});

test('trigger aborted by a superseding navigation, page on a non-marker URL => incomplete', async () => {
  const out = await rows({
    fake: {
      supersedeAbort: true,
      finalHref: 'https://ordinary.example.test/doc?n=home',
    },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"triggerRefused":false/.test(n) &&
        /"onMarker":false/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('empty fixture log without control proof => incomplete', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake({
      protectedHosts: plantHosts,
      blockedMarkers: protectedVectors[0]?.blockedMarkers ?? [],
      blockedMarker: 'data:,blocked',
    });
    const origin = (host) => `http://${host}:${fixture.port}`;
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      cookiePlant: true,
    });
    try {
      const out = await run(
        {
          ...set,
          vectors: protectedVectors.map((v) =>
            prunePaths({ ...v, targets: ['seven'] }, ['fulfillArray'])
          ),
          variants: { prompt: 0 },
        },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture: { ...fixture, log: () => [] },
          settleScale: 0.1,
          capabilities: caps,
          targets: targetsOf(fixture, origin),
          catalog,
          cookiePlantOnlyPaths: ['fulfillArray'],
        }
      );
      const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
      assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
    } finally {
      await guard.stop?.();
    }
  } finally {
    await fixture.close();
  }
});

test('unguarded client fails the guarded expectations', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const out = await run(
      {
        ...set,
        vectors: protectedVectors.map((v) =>
          prunePaths({ ...v, targets: ['seven'] }, ['fulfillArray'])
        ),
        variants: { prompt: 0 },
      },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        settleScale: 0.1,
        capabilities: caps,
        targets: targetsOf(fixture, origin),
        cookiePlantOnlyPaths: ['fulfillArray'],
      }
    );
    const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
  } finally {
    await fixture.close();
  }
});

for (const path of [
  'fulfillLower',
  'fulfillBinary',
  'legacyRaw',
  'redirect3xx',
  'domainUpper',
  'domainRepeated',
  'domainWs',
  'setCookieSecond',
]) {
  test(`mutant allowPlantPaths=${path} fails`, async () => {
    const out = await rows({
      allowPlantPaths: [path],
      admitProtectedNavigation: true,
      oneTarget: true,
      onlyPaths: [path],
    });
    const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
    assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  });
}

test('mutant that admits the protected pause and plants fails', async () => {
  const out = await rows({
    admitProtectedNavigation: true,
    allowPlantPaths: [
      'fulfillArray',
      'fulfillLower',
      'fulfillBinary',
      'continueResponse',
      'redirect3xx',
      'legacyRaw',
    ],
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
});

test('mutant that blocks navigation but poisons the jar fails', async () => {
  const out = await rows({
    poisonProtectedJar: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('mutant that hangs on protected navigation is incomplete', async () => {
  const out = await rows({
    hangOnProtected: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
});

test('blocking guard with replyDelay still passes', async () => {
  const out = await rows({
    replyDelayMs: 200,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.live, 'pass', JSON.stringify(row));
});

test('late block after the old short window still passes (event-driven wait)', async () => {
  const out = await rows({
    replyDelayMs: 600,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"pageHref":"[^"]+"/.test(n) &&
        /"elapsedMs":[6-9][0-9]{2,}/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('cookie-plant closes every probe target after the row', async () => {
  const { out, browser } = await rows({
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    withBrowser: true,
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(browser.pageTargetCount(), 0, JSON.stringify(browser.openPageTargets()));
});

test('leaking a tab on session-cut fails the isolation check', async () => {
  const { out, browser } = await rows({
    sessionCutOnFetchEnable: true,
    fake: { leakCloseCount: 1 },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
    withBrowser: true,
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    browser.pageTargetCount() > 0,
    `expected a leaked tab, got ${JSON.stringify(browser.openPageTargets())}`
  );
});

test('deletionCleared with browserContexts seeds and clears in the tab context (regression)', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    oneTarget: true,
    onlyPaths: ['ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.control.deletionCleared, true, JSON.stringify(row));
  assert.equal(row.observations.guarded.deletionCleared, true, JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.deletion\.cleared:/.test(n) &&
        /"cleared":true/.test(n) &&
        /"browserContextId":"C/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('storage jar that ignores browserContextId fails deletionCleared under a correct guard (pre-fix repro)', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: { storageJarIgnoresBrowserContext: true },
    oneTarget: true,
    onlyPaths: ['ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.notEqual(row.control, 'pass', JSON.stringify(row));
  assert.ok(
    row.observations.control.deletionCleared === false ||
      row.live === 'fail' ||
      row.control === 'incomplete',
    JSON.stringify(row)
  );
});

test('deletionCleared is incomplete when the after jar is unreadable', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: { rejectJarAfterDoorProof: true },
    oneTarget: true,
    onlyPaths: ['deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.observations.guarded.deletionCleared, 'incomplete', JSON.stringify(row));
});

test('default jar legitimate only when browserContexts is not declared: tab and read agree', async () => {
  const out = await rows({
    oneTarget: true,
    onlyPaths: ['ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.observations.control.deletionCleared, true, JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) => /cookie-plant\.deletion\.cleared:/.test(n) && /"cleared":true/.test(n)
    ),
    JSON.stringify(row.notes)
  );
  assert.ok(
    !(row.notes ?? []).some((n) => /"browserContextId":"C/.test(n)),
    `contexts-off must use default jar, got ${JSON.stringify(row.notes)}`
  );
});

test('a) jar read that ignores browserContextId cannot pass planted:false (canary)', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: { storageGetIgnoresBrowserContext: true, continueItself: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    row.guarded === 'incomplete' ||
      row.live === 'fail' ||
      (row.notes ?? []).some((n) => /jar view canary absent/.test(n)),
    JSON.stringify(row)
  );
});

test('b) canary absent => incomplete', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: { dropCanary: true, continueItself: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  const plantedNotes = parsePlantedNotes(row.notes);
  assert.ok(plantedNotes.length, JSON.stringify(row.notes));
  assert.ok(
    plantedNotes.some((n) => n.canaryVisible === false && n.canaryName),
    JSON.stringify(plantedNotes)
  );
});

function parsePlantedNotes(notes) {
  return (notes ?? [])
    .map((line) => {
      const m = /^(?:(guarded|control) )?(cookie-plant\.[^:]+):\s*(\{.*\})\s*$/.exec(line);
      if (!m) return null;
      let evidence;
      try {
        evidence = JSON.parse(m[3]);
      } catch {
        return null;
      }
      if (!Object.hasOwn(evidence, 'planted')) return null;
      return { leg: m[1] ?? null, label: m[2], ...evidence };
    })
    .filter(Boolean);
}

test('planted:false guarded path notes carry canaryVisible true with audit fields', async () => {
  const out = await rows({
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  const plantedFalse = parsePlantedNotes(row.notes).filter((n) => n.planted === false);
  assert.ok(plantedFalse.length >= 1, JSON.stringify(row.notes));
  for (const n of plantedFalse) {
    assert.equal(n.canaryVisible, true, JSON.stringify(n));
    assert.match(String(n.canaryName ?? ''), /^cplantcanary/, JSON.stringify(n));
    assert.ok(
      n.via === 'Storage.getCookies' ||
        n.via === 'Network.getAllCookies' ||
        n.via === 'Network.getCookies',
      JSON.stringify(n)
    );
    assert.ok(Object.hasOwn(n, 'browserContextId'), JSON.stringify(n));
  }
});

test('Network cookie call with a foreign session fails in the fake', async () => {
  const browser = cookiePlantFake({ protectedHosts: plantHosts });
  await browser.client.send('Target.setDiscoverTargets', { discover: true });
  const created = await browser.unguarded.send('Target.createTarget', {
    url: 'http://ordinary.example.test/',
  });
  const attached = await browser.unguarded.send('Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  });
  const guardSide = await browser.client.send('Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  });
  const url = 'http://ordinary.example.test/';
  const calls = [
    ['Network.setCookie', { name: 'cplantx', value: 'v', url }],
    ['Network.getCookies', { urls: [url] }],
    ['Network.getAllCookies', {}],
    ['Network.deleteCookies', { name: 'cplantx', url }],
  ];
  const wrong = [undefined, 'not-an-attempt-session', guardSide.sessionId];
  for (const [method, params] of calls) {
    for (const sessionId of wrong)
      await assert.rejects(
        () => browser.unguarded.send(method, params, sessionId),
        /attempt tab session/,
        `${method} on ${sessionId}`
      );
    await browser.unguarded.send(method, params, attached.sessionId);
  }
  assert.equal(browser.networkCookieRejects().length, calls.length * wrong.length);
  await browser.unguarded.send('Target.closeTarget', { targetId: created.targetId });
  await assert.rejects(
    () => browser.unguarded.send('Network.getAllCookies', {}, attached.sessionId),
    /attempt tab session/
  );
});

const EVIDENCE_FORMS = {
  commandRefused: { answered: true, refused: true, planted: false },
  answeredNotPlanted: { answered: true, refused: false, planted: false },
  allowedPlant: { answered: true, refused: false, planted: true },
};

function expectedEvidenceForm({ answered, refused, planted }) {
  const hit = Object.entries(EVIDENCE_FORMS).find(
    ([, shape]) =>
      shape.answered === answered && shape.refused === refused && shape.planted === planted
  );
  return hit ? hit[0] : null;
}

test('evidenceFormOf classifier matrix: only the three answered shapes classify', () => {
  const values = [true, false, 'incomplete', 'not-supported', null, undefined];
  const classified = [];
  for (const answered of values)
    for (const refused of values)
      for (const planted of values) {
        const cell = { answered, refused, planted };
        const form = evidenceFormOf(cell);
        assert.equal(form, expectedEvidenceForm(cell), JSON.stringify(cell));
        if (form) classified.push(form);
      }
  assert.deepEqual(classified.sort(), Object.keys(EVIDENCE_FORMS).sort());
  for (const rejected of [
    { answered: false, refused: false, planted: false },
    { answered: false, refused: true, planted: false },
    { answered: false, refused: false, planted: true },
    { answered: true, refused: true, planted: true },
    { answered: true, refused: false, planted: 'incomplete' },
    { answered: true, refused: true, planted: 'incomplete' },
    { answered: 'incomplete', refused: 'incomplete', planted: 'incomplete' },
  ])
    assert.equal(evidenceFormOf(rejected), null, JSON.stringify(rejected));
});

const STUB_CANARY = {
  name: 'cplantcanarystub',
  value: 'canary-stub',
  domain: 'ims-na1.adobelogin.com',
  path: '/',
  url: 'https://ims-na1.adobelogin.com/',
};
const STUB_PLANT = {
  name: 'cplantstub',
  value: 'ho-stub',
  domain: 'ims-na1.adobelogin.com',
  url: 'https://ims-na1.adobelogin.com/',
};
const STUB_OUTS = {
  answered: { out: { ok: true, result: {} }, answered: true, refused: false },
  refused: {
    out: { ok: false, error: { message: 'slicc: refused: credential origin' } },
    answered: true,
    refused: true,
  },
  unanswered: {
    out: { ok: false, error: { message: 'Fetch.fulfillRequest timeout' } },
    answered: false,
    refused: false,
  },
};
const jarEntry = ({ name, value, domain }) => ({ name, value, domain, path: '/' });
const STUB_JARS = {
  planted: { planted: true, cookies: () => [jarEntry(STUB_CANARY), jarEntry(STUB_PLANT)] },
  notPlanted: { planted: false, cookies: () => [jarEntry(STUB_CANARY)] },
  unreadable: {
    planted: 'incomplete',
    cookies: () => {
      throw new Error('jar read rejected');
    },
  },
  canaryAbsent: { planted: 'incomplete', cookies: () => [jarEntry(STUB_PLANT)] },
  timeout: { planted: 'incomplete', cookies: () => new Promise(() => {}) },
};

function stubJarHandle(jar, credential) {
  const reader = {
    events: [],
    send: async (method) => {
      if (
        method === 'Storage.getCookies' ||
        method === 'Network.getAllCookies' ||
        method === 'Network.getCookies'
      )
        return { cookies: await jar.cookies() };
      return {};
    },
  };
  return {
    reader,
    readerSession: 'S-stub',
    browserContextId: null,
    browserContexts: false,
    canary: STUB_CANARY,
    credential,
    timing: {},
  };
}

for (const [outKind, outCase] of Object.entries(STUB_OUTS)) {
  for (const [jarKind, jar] of Object.entries(STUB_JARS)) {
    const want = expectedEvidenceForm({
      answered: outCase.answered,
      refused: outCase.refused,
      planted: jar.planted,
    });
    test(`finishPlant evidenceForm matrix ${outKind} x ${jarKind} => ${want ?? 'no form'}`, async () => {
      const runs = await Promise.all(
        [true, false].map(async (credential) => {
          const notes = [];
          await finishPlant({
            out: outCase.out,
            cookie: STUB_PLANT,
            notes,
            label: 'hostOnly',
            handle: stubJarHandle(jar, credential),
          });
          return { credential, notes };
        })
      );
      for (const { credential, notes } of runs) {
        const [n] = parsePlantedNotes(notes);
        assert.ok(n, JSON.stringify(notes));
        assert.equal(n.answered, outCase.answered, JSON.stringify(n));
        assert.equal(n.refused, outCase.refused, JSON.stringify(n));
        assert.equal(n.planted, jar.planted, JSON.stringify(n));
        if (credential && want) assert.equal(n.evidenceForm, want, JSON.stringify(n));
        else assert.equal(Object.hasOwn(n, 'evidenceForm'), false, JSON.stringify(n));
      }
    });
  }
}

const PROTECTED_ROW_HAS_NO_FORM =
  'evidenceForm is a C10.cookie-plant.credential field: finishPlant classifies only on credential attempt tabs, and the protected row scores its plant paths by the blocked plant shape';

const EVIDENCE_FORM_PATH_SETS = [
  {
    id: 'credential IMS-host plants, allowed sub-host and controls',
    vectors: credentialVectors,
    target: 'idp',
    paths: ['hostOnly', 'domainCover', 'responsePhrase', 'subHost', 'adobe', 'deletion'],
    forms: {
      'guarded hostOnly': 'commandRefused',
      'guarded domainCover': 'commandRefused',
      'guarded responsePhrase': 'answeredNotPlanted',
      'guarded subHost': 'allowedPlant',
      'guarded adobe': 'allowedPlant',
      'guarded deletion': 'answeredNotPlanted',
      'control adobe': 'allowedPlant',
      'control deletion': 'answeredNotPlanted',
    },
    cannotHit: {},
  },
  {
    id: 'credential IMS-host plants only',
    vectors: credentialVectors,
    target: 'idp',
    paths: ['hostOnly', 'domainCover'],
    forms: {
      'guarded hostOnly': 'commandRefused',
      'guarded domainCover': 'commandRefused',
    },
    cannotHit: {
      answeredNotPlanted:
        'the emulated guard refuses both IMS-host Set-Cookie answers with a slicc refusal, and no path in the set is answered unrefused without planting (responsePhrase and deletion are not in the set)',
      allowedPlant:
        'both paths set a cookie the IMS host receives (host-only on it, Domain covering it), where planted true is a leak; the set has no allowed path (subHost, adobe, ordinary)',
    },
  },
  {
    id: 'credential allowed sub-host only',
    vectors: credentialVectors,
    target: 'idp',
    paths: ['subHost'],
    forms: { 'guarded subHost': 'allowedPlant' },
    cannotHit: {
      commandRefused:
        'subHost is the allowed sub-host plant (subHostRefused false) and the set has no IMS-host plant for the guard to refuse',
      answeredNotPlanted:
        'subHostPlanted is true under a correct guard, and the set has no path that is answered without planting (responsePhrase, deletion)',
    },
  },
  {
    id: 'protected row',
    vectors: protectedVectors,
    target: 'seven',
    paths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    forms: {
      'guarded fulfillArray': null,
      'guarded ordinary': null,
      'guarded adobe': null,
      'guarded deletion': null,
      'control ordinary': null,
      'control adobe': null,
      'control deletion': null,
    },
    cannotHit: {
      commandRefused: PROTECTED_ROW_HAS_NO_FORM,
      answeredNotPlanted: PROTECTED_ROW_HAS_NO_FORM,
      allowedPlant: PROTECTED_ROW_HAS_NO_FORM,
    },
  },
];

for (const pathSet of EVIDENCE_FORM_PATH_SETS) {
  test(`path notes prove evidenceForm coverage: ${pathSet.id}`, async () => {
    const reachable = [...new Set(Object.values(pathSet.forms).filter(Boolean))].sort();
    const unreachable = Object.keys(pathSet.cannotHit).sort();
    assert.deepEqual(
      [...reachable, ...unreachable].sort(),
      Object.keys(EVIDENCE_FORMS).sort(),
      'every form is either hit or named with a reason'
    );
    for (const reason of Object.values(pathSet.cannotHit)) assert.ok(reason.length > 20, reason);
    const out = await rows({ oneTarget: true, onlyPaths: pathSet.paths }, pathSet.vectors);
    const row = out.results.find(
      (r) => r.id === pathSet.vectors[0].id && r.target === pathSet.target
    );
    assert.ok(row, JSON.stringify(out.results));
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    const labels = new Set(pathSet.paths.map((path) => `cookie-plant.${path}`));
    const pathNotes = parsePlantedNotes(row.notes).filter((n) => labels.has(n.label));
    const seen = new Set();
    const keys = [];
    for (const n of pathNotes) {
      const key = `${n.leg} ${n.label.slice('cookie-plant.'.length)}`;
      keys.push(key);
      assert.ok(
        Object.hasOwn(pathSet.forms, key),
        `unexpected path note ${key}: ${JSON.stringify(n)}`
      );
      const want = pathSet.forms[key];
      assert.match(String(n.canaryName ?? ''), /^cplantcanary/, JSON.stringify(n));
      assert.equal(n.canaryVisible, true, JSON.stringify(n));
      assert.ok(Object.hasOwn(n, 'via'), JSON.stringify(n));
      assert.ok(Object.hasOwn(n, 'browserContextId'), JSON.stringify(n));
      if (!want) {
        assert.equal(
          Object.hasOwn(n, 'evidenceForm'),
          false,
          `${key} must carry no evidenceForm: ${JSON.stringify(n)}`
        );
        continue;
      }
      assert.equal(n.evidenceForm, want, JSON.stringify(n));
      assert.equal(n.evidenceForm, evidenceFormOf(n), JSON.stringify(n));
      const shape = EVIDENCE_FORMS[want];
      assert.equal(n.answered, shape.answered, JSON.stringify(n));
      assert.equal(n.refused, shape.refused, JSON.stringify(n));
      assert.equal(n.planted, shape.planted, JSON.stringify(n));
      seen.add(n.evidenceForm);
    }
    assert.deepEqual(keys.sort(), Object.keys(pathSet.forms).sort(), JSON.stringify(row.notes));
    assert.deepEqual([...seen].sort(), reachable);
    for (const form of unreachable) assert.equal(seen.has(form), false, form);
  });
}

test('c) right context with plant landed => fail', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: { continueItselfPlant: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
});

test('d) raw leg in a different browserContext than guarded => incomplete', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: { staggerContexts: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some((n) => /raw\/guarded browserContext mismatch/.test(n)),
    JSON.stringify(row.notes)
  );
});

test('e) Storage.getCookies fails and Network fallback lacks canary => incomplete', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: {
      storageGetCookiesFails: true,
      networkOmitsCanary: true,
      continueItself: true,
    },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some((n) => /jar view canary absent/.test(n)) ||
      /canary/.test(String(row.why ?? '')),
    JSON.stringify(row)
  );
});

test('f) Network.getAllCookies fallback (session-context, not URL-scoped) has canary and no plant => unplanted pass-capable', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: { storageGetCookiesFails: true, continueItself: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, false, JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) => /fulfillArray:/.test(n) && /"via":"Network\.getAllCookies"/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('g) Network fallback has canary and the planted cookie => planted true', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: { storageGetCookiesFails: true, continueItselfPlant: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
});

test('h) getCookies fallback URL scope excludes canary home host => incomplete', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: {
      storageGetCookiesFails: true,
      networkGetAllCookiesFails: true,
      getCookiesPlantDomainOnly: true,
      continueItself: true,
    },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some((n) => /jar view canary absent/.test(n)) ||
      /canary/.test(String(row.why ?? '')),
    JSON.stringify(row)
  );
});

test('i) getCookies fallback URL scope includes canary origin => unplanted pass-capable', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: {
      storageGetCookiesFails: true,
      networkGetAllCookiesFails: true,
      continueItself: true,
    },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, false, JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some((n) => /fulfillArray:/.test(n) && /"via":"Network\.getCookies"/.test(n)),
    JSON.stringify(row.notes)
  );
});

test('j) canary only in a foreign browserContext does not satisfy the tab-context canary check', async () => {
  const out = await rows({
    capabilities: { browserContexts: true },
    fake: { canarySetIgnoresBrowserContext: true, continueItself: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some((n) => /jar view canary absent/.test(n)) ||
      /canary/.test(String(row.why ?? '')),
    JSON.stringify(row)
  );
});

test('a correct cookiePlant guard passes the credential row', async () => {
  const out = await rows({}, credentialVectors);
  for (const target of ['idp', 'idp-stg']) {
    const row = out.results.find(
      (r) => r.id === 'C10.cookie-plant.credential' && r.target === target
    );
    assert.ok(row, target);
    assert.equal(row.control, 'pass', `${target} control ${JSON.stringify(row)}`);
    assert.equal(row.guarded, 'pass', `${target} guarded ${JSON.stringify(row)}`);
    assert.equal(row.live, 'pass', `${target} live ${JSON.stringify(row)}`);
  }
});

test('mutant allowPlantPaths=hostOnly fails the credential row', async () => {
  const out = await rows(
    { allowPlantPaths: ['hostOnly'], oneTarget: true, onlyPaths: ['hostOnly'] },
    credentialVectors
  );
  const row = out.results.find((r) => r.id === 'C10.cookie-plant.credential' && r.target === 'idp');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('binaryLf not stored is recorded as not-a-plant-path, not required', async () => {
  const out = await rows({
    oneTarget: true,
    onlyPaths: ['binaryLf', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.binaryLfPlanted, false, JSON.stringify(row));
});

test('binaryLf stored by the transport is a plant path; a leak fails', async () => {
  const ok = await rows({
    fake: { storeBinaryLf: true },
    oneTarget: true,
    onlyPaths: ['binaryLf', 'ordinary', 'adobe', 'deletion'],
  });
  const pass = ok.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(pass.control, 'pass', JSON.stringify(pass));
  assert.equal(pass.guarded, 'pass', JSON.stringify(pass));
  assert.equal(pass.observations.guarded.binaryLfPlanted, false, JSON.stringify(pass));
  const leak = await rows({
    fake: { storeBinaryLf: true },
    allowPlantPaths: ['binaryLf'],
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['binaryLf'],
  });
  const row = leak.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.binaryLfPlanted, true, JSON.stringify(row));
});

test('m6 session-level refusal on attach after trigger => pass', async () => {
  const out = await rows({
    refuseAttachAfterTrigger: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) => /cookie-plant\.fulfillArray:/.test(n) && /"postTriggerRefusal":true/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('m7 same refusal before trigger never issued => incomplete', async () => {
  const out = await rows({
    refuseAttachBeforeTrigger: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
});

test('m8 post-trigger refusal with planted jar => fail', async () => {
  const out = await rows({
    refuseAttachAfterTrigger: true,
    poisonProtectedJar: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('m9 refuse-after-first-touch does not change later path verdicts', async () => {
  const out = await rows({
    refuseAfterProtectedTouch: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'fulfillLower', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, false, JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillLowerPlanted, false, JSON.stringify(row));
});

test('fetch+request without legacyInterception skips legacy on both legs', async () => {
  const out = await rows({
    capabilities: {
      requestInterception: true,
      fetchInterception: true,
      legacyInterception: false,
    },
    oneTarget: true,
    onlyPaths: ['legacyHeaders', 'legacyRaw', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.legacyRawPlanted, 'not-supported');
  assert.equal(row.observations.guarded.legacyHeadersPlanted, 'not-supported');
  assert.equal(row.observations.control.legacyRawPlanted, 'not-supported');
});

test('m10 guard continues itself, zero pauses, unplanted => pass', async () => {
  const out = await rows({
    fake: { continueItself: true },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, false, JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"fixtureHits":[1-9]/.test(n) &&
        /"pauseCount":0/.test(n) &&
        /continue-itself/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('m11 continue-itself but trigger never issued (fixtureHits 0, no refusal, no marker) => incomplete', async () => {
  const out = await rows({
    fake: { continueItselfNoHit: true },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
});

test('earlier path fixture hit does not count when this path trigger never issued => incomplete', async () => {
  const out = await rows({
    fake: { continueItself: true, continueItselfNoHitAfter: 1 },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'fulfillLower'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillLowerPlanted, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"fixtureHits":[1-9]/.test(n) &&
        /continue-itself/.test(n)
    ),
    JSON.stringify(row.notes)
  );
  assert.ok(
    (row.notes ?? []).some(
      (n) => /cookie-plant\.fulfillLower:/.test(n) && /"fixtureHits":0/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('fixture hit after path entry but before triggerSentAt does not count => incomplete', async () => {
  const out = await rows({
    fake: { continueItselfNoHit: true, preTriggerPlantHit: true },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) => /cookie-plant\.fulfillArray:/.test(n) && /"fixtureHits":0/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('continue-itself early-exits evidence wait under 1.5s (event-driven)', async () => {
  const out = await rows({
    fake: { continueItself: true },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  const note = (row.notes ?? []).find(
    (n) => /cookie-plant\.fulfillArray:/.test(n) && /continue-itself/.test(n)
  );
  assert.ok(note, JSON.stringify(row.notes));
  const elapsed = Number(/"pathElapsedMs":(\d+)/.exec(note)?.[1]);
  assert.ok(Number.isFinite(elapsed) && elapsed < 1500, note);
});

test('m12 guard continues itself but the client Set-Cookie is applied (planted) => fail', async () => {
  const out = await rows({
    fake: { continueItselfPlant: true },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
});

test('m13 guard fails the request, reader sees chrome-error => pass', async () => {
  const out = await rows({
    fake: { blockedMarker: 'chrome-error://chromewebdata/' },
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"pageHref":"chrome-error:\/\/chromewebdata\/"/.test(n) &&
        /"fixtureHits":0/.test(n) &&
        (/guard blocks the request itself/.test(n) || /"onMarker":true/.test(n))
    ),
    JSON.stringify(row.notes)
  );
});

test('m14 guard fails silently but reader still sees the home URL => incomplete', async () => {
  const out = await rows({
    fake: { failSilentKeepHome: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"fixtureHits":0/.test(n) &&
        /"onMarker":false/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('m15 reader sees a blocked marker but fixtureHits >= 1 => fail', async () => {
  const out = await rows({
    fake: {
      continueItselfPlant: true,
      blockedMarker: 'chrome-error://chromewebdata/',
    },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"fixtureHits":[1-9]/.test(n) &&
        /"onMarker":true/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('m16 guarded client href is null while the reader sees the marker => pass', async () => {
  const out = await rows({
    fake: {
      blockedMarker: 'chrome-error://chromewebdata/',
      nullGuardHref: true,
    },
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"pageHref":"chrome-error:\/\/chromewebdata\/"/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('loadingFailed without requestId or unknown id does not count as readerBlocked => incomplete', async () => {
  const out = await rows({
    fake: { failSilentKeepHome: true, injectOrphanLoadingFailed: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"readerBlocked":false/.test(n) &&
        /"fixtureHits":0/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('neighbouring path blocked request on same base different tag does not count => incomplete', async () => {
  const out = await rows({
    fake: { failSilentKeepHome: true, injectNeighbourBlocked: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"readerBlocked":false/.test(n) &&
        /"onMarker":false/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('earlier tab on chrome-error while this fresh tab stays home => incomplete', async () => {
  const out = await rows({
    fake: {
      blockedMarker: 'chrome-error://chromewebdata/',
      keepHomeAfterFirstBlock: true,
    },
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'fulfillLower'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillLowerPlanted, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        /"pageHref":"chrome-error:\/\/chromewebdata\/"/.test(n)
    ),
    JSON.stringify(row.notes)
  );
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillLower:/.test(n) &&
        /"onMarker":false/.test(n) &&
        /"fixtureHits":0/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('Fetch.enable unanswered => incomplete', async () => {
  const out = await rows({
    hangFetchEnable: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
});

test('Fetch.enable unanswered + fixtureHits>=1 => incomplete', async () => {
  const out = await rows({
    hangFetchEnable: true,
    fake: { continueItself: true },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillArray:/.test(n) &&
        (/Fetch\.enable unanswered for continue-itself/.test(n) || /"fixtureHits":[1-9]/.test(n))
    ),
    JSON.stringify(row.notes)
  );
});

test('earlier tab Fetch.enable ok, this tab unanswered => incomplete', async () => {
  const out = await rows({
    hangFetchEnableAfterOkSessions: 2,
    fake: { continueItself: true },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'fulfillLower'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillLowerPlanted, 'incomplete', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.fulfillLower:/.test(n) &&
        (/Fetch\.enable unanswered for continue-itself/.test(n) || /"fetchEnableOk":false/.test(n))
    ),
    JSON.stringify(row.notes)
  );
});

test('Fetch.enable refused is refusal of the interception plant surface => pass', async () => {
  const out = await rows({
    refuseFetchEnable: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, false, JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) => /cookie-plant\.fulfillArray:/.test(n) && /interception plant surface refused/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('raw leg timeout => door absent; guard that plants fails (owner-accepted residual)', async () => {
  const out = await rows({
    forcedRaw: { fulfillArray: 'timeout' },
    allowPlantPaths: ['fulfillArray'],
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) => /cookie-plant\.raw\.fulfillArray:/.test(n) && /door not present/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('probe session-cut on Fetch.enable cannot become guarded=pass', async () => {
  const out = await rows({
    sessionCutOnFetchEnable: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
});

for (const [forced, needle] of [
  ['missing', /raw leg missing|raw leg incomplete/],
  ['unreadable', /cookie jar unreadable|raw leg incomplete/],
  ['open-fail', /raw open failed|raw leg incomplete/],
  ['enable-fail', /Fetch\.enable failed|raw leg incomplete/],
  ['no-pause', /no pause|raw leg incomplete/],
]) {
  test(`raw leg ${forced} is incomplete, not door-absent`, async () => {
    const out = await rows({
      forcedRaw: { fulfillArray: forced },
      oneTarget: true,
      onlyPaths: ['fulfillArray'],
    });
    const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
    assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
    assert.ok(
      (row.notes ?? []).some(
        (n) => /cookie-plant\.(raw\.)?fulfillArray:/.test(n) && needle.test(n)
      ),
      JSON.stringify(row.notes)
    );
  });
}

test('door-absent path still fails when the guarded jar is planted', async () => {
  const out = await rows({
    forcedRaw: { fulfillArray: 'timeout' },
    allowPlantPaths: ['fulfillArray'],
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayAnswered, true, JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayRefused, false, JSON.stringify(row));
});

test('doorAbsent + unreadable jar stays incomplete, not unplanted pass', async () => {
  const out = await rows({
    forcedRaw: { fulfillArray: 'timeout' },
    fake: { rejectJarAfterDoorProof: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, 'incomplete', JSON.stringify(row));
});

test('plantSurfaceRefused + unreadable jar stays incomplete, not unplanted pass', async () => {
  const out = await rows({
    refuseFetchEnable: true,
    forcedRaw: { fulfillArray: 'plant' },
    fake: { rejectJarAfterDoorProof: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, 'incomplete', JSON.stringify(row));
});

test('refusal-reply shape + unreadable jar stays incomplete, not unplanted pass', async () => {
  const out = await rows({
    refuseAttachAfterTrigger: true,
    forcedRaw: { fulfillArray: 'plant' },
    fake: { rejectJarAfterDoorProof: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, 'incomplete', JSON.stringify(row));
});

test('continue-itself shape + unreadable jar stays incomplete, not unplanted pass', async () => {
  const out = await rows({
    fake: { continueItself: true, rejectJarAfterDoorProof: true },
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, 'incomplete', JSON.stringify(row));
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
});

test('raw leg plants => guarded must refuse; allow-through fails', async () => {
  const out = await rows({
    forcedRaw: { fulfillArray: 'plant' },
    allowPlantPaths: ['fulfillArray'],
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
});

test('history-lock after protected nav does not change fresh-tab guarded verdicts', async () => {
  const out = await rows({
    historyLockAfterProtected: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, false, JSON.stringify(row));
});

test('refuse-all interception fails the controls', async () => {
  const out = await rows({
    refuseAllInterception: true,
    oneTarget: true,
    onlyPaths: ['ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('mutant that silently drops allowed Set-Cookie fails the controls', async () => {
  const out = await rows({
    silentDropAllowed: true,
    oneTarget: true,
    onlyPaths: ['ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.ordinaryPlanted, false, JSON.stringify(row));
  assert.equal(row.observations.guarded.adobePlanted, false, JSON.stringify(row));
  assert.equal(row.observations.guarded.deletionCleared, false, JSON.stringify(row));
});

test('refuseWithoutFail still finishes and protects', async () => {
  const out = await rows({
    refuseWithoutFail: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.live, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.control, 'pass', JSON.stringify(row));
});

test('mutant missObsFoldDomain that admits pauses leaves protected evidence incomplete', async () => {
  const out = await rows({
    missObsFoldDomain: true,
    admitProtectedNavigation: true,
    forcedRaw: { binaryObsFold: 'plant', domainQuoted: 'plant' },
    fake: { deadFetchAfter: 'bof-', deadFetchOnNth: 2 },
    oneTarget: true,
    onlyPaths: ['binaryObsFold', 'domainQuoted', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some((n) =>
      /cookie-plant\.(firstIncomplete|binaryObsFold|domainQuoted):/.test(n)
    ),
    JSON.stringify(row.notes)
  );
});

test('mutant that cuts the session after admitting pauses does not pass', async () => {
  const out = await rows({
    allowPlantPaths: ['fulfillArray'],
    admitProtectedNavigation: true,
    forcedRaw: { fulfillArray: 'plant' },
    fake: { cutSessionAfter: 'p-', cutSessionOnNth: 2, cutBlocksReattach: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(
    (row.notes ?? []).some(
      (n) =>
        /cookie-plant\.firstIncomplete:/.test(n) ||
        (/cookie-plant\.fulfillArray:/.test(n) &&
          (/"planted":true/.test(n) ||
            /session cut|reattach failed|protected plant evidence incomplete/.test(n)))
    ),
    JSON.stringify(row.notes)
  );
});

test('mutant that forwards fulfillArray then cuts still fails planted', async () => {
  const out = await rows({
    allowPlantPaths: ['fulfillArray'],
    forwardThenCut: ['fulfillArray'],
    admitProtectedNavigation: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayRefused, true, JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, true, JSON.stringify(row));
});

test('mutant that never answers client attach is incomplete', async () => {
  const out = await rows({
    hangClientAttach: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.match(
    [...(row.incomplete ?? []), row.why ?? ''].join('\n'),
    /attachToTarget timeout|client attach failed/
  );
});

test('unreadable jar after a plant is incomplete, not a false pass', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake({
      rejectCplantJarAfterFirst: true,
      protectedHosts: plantHosts,
    });
    const origin = (host) => `http://${host}:${fixture.port}`;
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      credentialOrigins: catalog.credentialOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      cookiePlant: true,
      allowPlantPaths: ['fulfillArray'],
      admitProtectedNavigation: true,
    });
    try {
      const out = await run(
        {
          ...set,
          vectors: protectedVectors.map((v) =>
            prunePaths({ ...v, targets: ['seven'] }, ['fulfillArray'])
          ),
          variants: { prompt: 0 },
        },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: caps,
          targets: targetsOf(fixture, origin),
          catalog,
          credentialOrigins: catalog.credentialOrigins,
          cookiePlantOnlyPaths: ['fulfillArray'],
        }
      );
      const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
      assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
    } finally {
      await guard.stop?.();
    }
  } finally {
    await fixture.close();
  }
});

test('requestInterception alone still judges fetch attack observations', async () => {
  const out = await rows({
    capabilities: { requestInterception: true },
    oneTarget: true,
    onlyPaths: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, false, JSON.stringify(row));
  assert.notEqual(row.observations.guarded.fulfillArrayPlanted, 'not-supported');
});

test('fetch-only transport skips legacy observations', async () => {
  const out = await rows({
    capabilities: { ...caps, legacyInterception: false },
    oneTarget: true,
    onlyPaths: ['legacyRaw', 'fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.legacyRawPlanted, 'not-supported');
});

test('sweep caps omit legacyInterception so Chrome-unavailable legacy is not forged', async () => {
  const out = await rows({
    capabilities: {
      requestInterception: true,
      fetchInterception: true,
    },
    oneTarget: true,
    onlyPaths: ['legacyRaw', 'fulfillArray', 'ordinary', 'adobe', 'deletion'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.deepEqual(out.summary({ guard: 'cookie-plant', sha: 'test' }).forged, []);
});

test('jar/score helpers throw when attempt handle is missing', async () => {
  const {
    requireAttemptHandle,
    jarContextIncomplete,
    clearCookie,
    plantCanary,
    readJar,
    readJarView,
    readJarWithCanary,
    seedCookie,
    finishPlant,
    recordSessionCut,
    continueItselfEvidence,
    evidenceAfterTrigger,
  } = cookiePlantHandleApi;
  assert.throws(() => requireAttemptHandle(null, 't'), /attempt handle required/);
  assert.throws(() => requireAttemptHandle({}, 't'), /browserContextId required/);
  assert.throws(() => requireAttemptHandle({ browserContextId: null }, 't'), /reader required/);
  requireAttemptHandle({ reader: {}, browserContextId: null }, 't');
  assert.deepEqual(
    jarContextIncomplete({ reader: {}, browserContextId: null, browserContexts: true }),
    { incomplete: 'unknown context' }
  );
  assert.equal(jarContextIncomplete({ reader: {}, browserContextId: null }), null);
  assert.equal(
    jarContextIncomplete({ reader: {}, browserContextId: 'C1', browserContexts: true }),
    null
  );
  assert.deepEqual(
    await readJarView({ reader: {}, browserContextId: null, browserContexts: true }),
    { incomplete: 'unknown context' }
  );
  await assert.rejects(() => clearCookie(null, { name: 'x' }), /attempt handle required/);
  await assert.rejects(
    () => clearCookie({ reader: {} }, { name: 'x' }),
    /browserContextId required/
  );
  await assert.rejects(
    () => plantCanary({ reader: {}, browserContextId: null }),
    /canary required/
  );
  assert.deepEqual(
    await plantCanary({
      reader: {},
      browserContextId: null,
      browserContexts: true,
      canary: { name: 'c', value: 'v', domain: 'a.test' },
    }),
    { incomplete: 'unknown context' }
  );
  await assert.rejects(
    () => readJar(null, { name: 'x', domain: 'a.test' }),
    /attempt handle required/
  );
  await assert.rejects(
    () =>
      readJarWithCanary({ reader: {}, browserContextId: null }, { name: 'x', domain: 'a.test' }),
    /canary required/
  );
  await assert.rejects(
    () => seedCookie(null, { name: 'x', domain: 'a.test', value: '1' }),
    /attempt handle required/
  );
  await assert.rejects(
    () => finishPlant({ out: { ok: true }, cookie: { name: 'x' }, notes: [], label: 't' }),
    /attempt handle required/
  );
  await assert.rejects(
    () => recordSessionCut({ cookie: { name: 'x' }, notes: [], label: 't' }),
    /attempt handle required/
  );
  await assert.rejects(
    () =>
      continueItselfEvidence({
        fixtureLog: async () => [],
        url: 'http://a.test/',
        since: 0,
        cookie: { name: 'x' },
      }),
    /attempt handle required/
  );
  await assert.rejects(
    () =>
      evidenceAfterTrigger({
        cookie: { name: 'x' },
        fixtureLog: async () => [],
        url: 'http://a.test/',
        startedAt: Date.now(),
      }),
    /attempt handle required/
  );
});

test('jar/score call sites always pass attempt handle (static)', async () => {
  const source = await readFile(join(root, 'cookie-plant.mjs'), 'utf8');
  assert.match(source, /function requireAttemptHandle\(/);
  assert.match(source, /function jarContextIncomplete\(/);
  for (const name of [
    'clearCookie',
    'seedCookie',
    'readJar',
    'readJarView',
    'readJarWithCanary',
    'plantCanary',
    'finishPlant',
    'recordSessionCut',
    'continueItselfEvidence',
    'evidenceAfterTrigger',
  ]) {
    assert.match(
      source,
      new RegExp(
        `(?:async )?function ${name}\\([\\s\\S]*?requireAttemptHandle\\(handle, '${name}'\\)`
      ),
      name
    );
  }
  assert.doesNotMatch(
    source,
    /async function (?:clearCookie|seedCookie|readJar|readJarView|readJarWithCanary)\([^)]*=\s*null/
  );
  const calls = [
    ...source.matchAll(/\brecordSessionCut\(\{([\s\S]*?)\}\)/g),
    ...source.matchAll(/\bfinishPlant\(\{([\s\S]*?)\}\)/g),
  ];
  assert.ok(calls.length >= 6, `expected finish/cut calls, got ${calls.length}`);
  for (const m of calls) {
    if (/^[\s]*out,/.test(m[1]) || /\bhandle\b/.test(m[1])) {
      assert.match(m[1], /\bhandle\b/, m[0].slice(0, 120));
      continue;
    }
    assert.fail(`call missing handle: ${m[0].slice(0, 160)}`);
  }
  for (const m of source.matchAll(
    /\b(?:clearCookie|plantCanary|readJarWithCanary|seedCookie)\(([^)]*)\)/g
  )) {
    const args = m[1];
    if (
      /^(?:handle|jarHandle)\b/.test(args.trim()) ||
      args.includes('handle,') ||
      args.trim() === 'handle' ||
      args.trim() === 'jarHandle'
    )
      continue;
    if (/function |=>/.test(m[0])) continue;
    assert.fail(`call must pass handle first: ${m[0].slice(0, 120)}`);
  }
});

test('no default-handle wrapper invents a null/B1 context (static)', async () => {
  const source = await readFile(join(root, 'cookie-plant.mjs'), 'utf8');
  assert.doesNotMatch(source, /function makeDefaultHandle\b/);
  assert.doesNotMatch(source, /browserContextId\s*:\s*['"]B1['"]/);
  assert.doesNotMatch(
    source,
    /browserContextId\s*:\s*(?:browserContextId|\w+)\s*\|\|\s*['"]B1['"]/
  );
  assert.doesNotMatch(
    source,
    /browserContextId\s*:\s*(?:browserContextId|\w+)\s*\?\?\s*['"]B1['"]/
  );
  assert.match(source, /jarContextIncomplete\(/);
  assert.match(source, /unknown context/);
});

const FOREIGN_CONTEXT_RESIDUAL =
  'foreign-context residual: a client-issued cookie write into the default jar is not a C10 path (C10 scores plants through client-answered interception in the issuing tab context); covered by C6.write-cookies / C6.setCookie (protected targets seven, vault, vault-x, apex) and C7.credential-export (credential targets idp, idp-stg)';
const CONTINUE_ITSELF_PROTECTED_ONLY = 'continue-itself applies only to protected hosts';
const POISON_VALUE_SCORING_INERT =
  'poison-jar plants p-; credential hostOnly scores ho- (scoring-inert)';

const MUTANT_MATRIX = [
  {
    id: 'correct',
    options: {},
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'm1',
    options: { fake: { deadPageSession: true } },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'pass', on: 'pass' },
    },
  },
  {
    id: 'm2',
    options: { fake: { blockedMarker: 'data:,blocked' } },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'm3',
    options: { fake: { blockedMarker: 'chrome-error://chromewebdata/' } },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'm4',
    options: { fake: { blockWithoutMarker: true } },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'm5',
    options: {
      fake: {
        blockWithoutMarker: true,
        settleAssignOk: true,
        finalHref: 'https://unknown.example.test/done',
      },
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'pass', on: 'pass' },
    },
  },
  {
    id: 'm6',
    options: { refuseAttachAfterTrigger: true },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'm7',
    options: { refuseAttachBeforeTrigger: true },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'incomplete', on: 'incomplete' },
    },
  },
  {
    id: 'm8',
    options: { refuseAttachAfterTrigger: true, poisonProtectedJar: true },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'fail', on: { na: FOREIGN_CONTEXT_RESIDUAL } },
      credential: {
        off: { na: POISON_VALUE_SCORING_INERT },
        on: { na: FOREIGN_CONTEXT_RESIDUAL },
      },
    },
  },
  {
    id: 'm9',
    options: { refuseAfterProtectedTouch: true },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'm10',
    options: { fake: { continueItself: true }, admitProtectedNavigation: true },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'm11',
    options: { fake: { continueItselfNoHit: true }, admitProtectedNavigation: true },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'pass', on: 'pass' },
    },
  },
  {
    id: 'm12',
    options: { fake: { continueItselfPlant: true }, admitProtectedNavigation: true },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'fail', on: 'fail' },
      credential: {
        off: { na: CONTINUE_ITSELF_PROTECTED_ONLY },
        on: { na: CONTINUE_ITSELF_PROTECTED_ONLY },
      },
    },
  },
  {
    id: 'm13',
    options: { fake: { blockedMarker: 'chrome-error://chromewebdata/' } },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'm14',
    options: { fake: { failSilentKeepHome: true } },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'pass', on: 'pass' },
    },
  },
  {
    id: 'm15',
    options: {
      fake: { continueItselfPlant: true, blockedMarker: 'chrome-error://chromewebdata/' },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'fail', on: 'fail' },
      credential: {
        off: { na: CONTINUE_ITSELF_PROTECTED_ONLY },
        on: { na: CONTINUE_ITSELF_PROTECTED_ONLY },
      },
    },
  },
  {
    id: 'm16',
    options: {
      fake: { blockedMarker: 'chrome-error://chromewebdata/', nullGuardHref: true },
    },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'a',
    options: {
      fake: { storageGetIgnoresBrowserContext: true, continueItself: true },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'pass', on: 'not-pass' },
      credential: { off: 'pass', on: 'not-pass' },
    },
  },
  {
    id: 'b',
    options: { fake: { dropCanary: true, continueItself: true }, admitProtectedNavigation: true },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'not-pass', on: 'not-pass' },
      credential: { off: 'not-pass', on: 'not-pass' },
    },
  },
  {
    id: 'c',
    options: { fake: { continueItselfPlant: true }, admitProtectedNavigation: true },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'fail', on: 'fail' },
      credential: {
        off: { na: CONTINUE_ITSELF_PROTECTED_ONLY },
        on: { na: CONTINUE_ITSELF_PROTECTED_ONLY },
      },
    },
  },
  {
    id: 'd',
    options: { fake: { staggerContexts: true } },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'pass', on: 'incomplete' },
      credential: { off: 'pass', on: 'pass' },
    },
  },
  {
    id: 'e',
    options: {
      fake: { storageGetCookiesFails: true, networkOmitsCanary: true, continueItself: true },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'not-pass', on: 'not-pass' },
      credential: { off: 'not-pass', on: 'not-pass' },
    },
  },
  {
    id: 'f',
    options: {
      fake: { storageGetCookiesFails: true, continueItself: true },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'g',
    options: {
      fake: { storageGetCookiesFails: true, continueItselfPlant: true },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'fail', on: 'fail' },
      credential: {
        off: { na: CONTINUE_ITSELF_PROTECTED_ONLY },
        on: { na: CONTINUE_ITSELF_PROTECTED_ONLY },
      },
    },
  },
  {
    id: 'h',
    options: {
      fake: {
        storageGetCookiesFails: true,
        networkGetAllCookiesFails: true,
        getCookiesPlantDomainOnly: true,
        continueItself: true,
      },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'not-pass', on: 'not-pass' },
      credential: { off: 'not-pass', on: 'not-pass' },
    },
  },
  {
    id: 'i',
    options: {
      fake: {
        storageGetCookiesFails: true,
        networkGetAllCookiesFails: true,
        continueItself: true,
      },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
  {
    id: 'j',
    options: {
      fake: { canarySetIgnoresBrowserContext: true, continueItself: true },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'pass', on: 'not-pass' },
      credential: { off: 'pass', on: 'not-pass' },
    },
  },
  {
    id: 'network-session-right-plant',
    options: {
      allowPlantPaths: ['fulfillArray'],
      admitProtectedNavigation: true,
      fake: { storageGetCookiesFails: true },
    },
    plant: ['fulfillArray'],
    expected: { protected: { off: 'fail', on: 'fail' }, credential: { off: 'fail', on: 'fail' } },
    allowMap: { fulfillArray: 'hostOnly' },
  },
  {
    id: 'network-session-guard',
    options: {
      fake: {
        storageGetCookiesFails: true,
        continueItself: true,
        networkCookieWrongSession: 'guard',
      },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'incomplete', on: 'incomplete' },
    },
    networkSession: 'guard',
  },
  {
    id: 'network-session-guard-plant',
    options: {
      allowPlantPaths: ['fulfillArray'],
      admitProtectedNavigation: true,
      fake: { storageGetCookiesFails: true, networkCookieWrongSession: 'guard' },
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'incomplete', on: 'incomplete' },
    },
    allowMap: { fulfillArray: 'hostOnly' },
    networkSession: 'guard',
  },
  {
    id: 'network-session-foreign',
    options: {
      fake: {
        storageGetCookiesFails: true,
        continueItself: true,
        networkCookieWrongSession: 'foreign',
      },
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'incomplete', on: 'incomplete' },
    },
    networkSession: 'foreign',
  },
  {
    id: 'network-session-foreign-plant',
    options: {
      allowPlantPaths: ['fulfillArray'],
      admitProtectedNavigation: true,
      fake: { storageGetCookiesFails: true, networkCookieWrongSession: 'foreign' },
    },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'incomplete', on: 'incomplete' },
    },
    allowMap: { fulfillArray: 'hostOnly' },
    networkSession: 'foreign',
  },
  {
    id: 'admit-plant',
    options: {
      allowPlantPaths: ['fulfillArray'],
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray'],
    expected: { protected: { off: 'fail', on: 'fail' }, credential: { off: 'fail', on: 'fail' } },
    allowMap: { fulfillArray: 'hostOnly' },
  },
  {
    id: 'poison-jar',
    options: { poisonProtectedJar: true },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'fail', on: { na: FOREIGN_CONTEXT_RESIDUAL } },
      credential: {
        off: { na: POISON_VALUE_SCORING_INERT },
        on: { na: FOREIGN_CONTEXT_RESIDUAL },
      },
    },
  },
  {
    id: 'session-cut-admit',
    options: {
      allowPlantPaths: ['fulfillArray'],
      admitProtectedNavigation: true,
      forcedRaw: { fulfillArray: 'plant' },
      fake: { cutSessionAfter: 'p-', cutSessionOnNth: 2, cutBlocksReattach: true },
    },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: {
      protected: { off: 'not-pass', on: 'not-pass' },
      credential: { off: 'not-pass', on: 'not-pass' },
    },
    allowMap: { fulfillArray: 'hostOnly' },
    forcedMap: { fulfillArray: 'hostOnly' },
  },
  {
    id: 'forward-then-cut',
    options: {
      allowPlantPaths: ['fulfillArray'],
      forwardThenCut: ['fulfillArray'],
      admitProtectedNavigation: true,
    },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'fail', on: 'fail' }, credential: { off: 'fail', on: 'fail' } },
    allowMap: { fulfillArray: 'hostOnly' },
    forwardMap: { fulfillArray: 'hostOnly' },
  },
  {
    id: 'hang-attach',
    options: { hangClientAttach: true },
    plant: ['fulfillArray'],
    expected: {
      protected: { off: 'incomplete', on: 'incomplete' },
      credential: { off: 'incomplete', on: 'incomplete' },
    },
  },
  {
    id: 'refuseWithoutFail',
    options: { refuseWithoutFail: true },
    plant: ['fulfillArray', 'ordinary', 'adobe', 'deletion'],
    expected: { protected: { off: 'pass', on: 'pass' }, credential: { off: 'pass', on: 'pass' } },
  },
];

function mapPlantPaths(paths, rowKind) {
  if (rowKind === 'protected') return paths;
  return paths
    .map((p) => {
      if (p === 'fulfillArray') return 'hostOnly';
      if (p === 'fulfillLower') return 'domainCover';
      if (p === 'binaryLf' || p === 'legacyHeaders' || p === 'legacyRaw') return null;
      return p;
    })
    .filter(Boolean);
}

function mapAllowPaths(paths, rowKind, allowMap) {
  if (rowKind === 'protected') return paths;
  return (paths ?? []).map((p) => allowMap?.[p] ?? (p === 'fulfillArray' ? 'hostOnly' : p));
}

function isPlantingMutant(mutant) {
  return Boolean(
    mutant.options?.poisonProtectedJar ||
      mutant.options?.fake?.continueItselfPlant ||
      Array.isArray(mutant.options?.allowPlantPaths) ||
      Array.isArray(mutant.options?.forwardThenCut)
  );
}

function cellLabel(expected) {
  if (expected && typeof expected === 'object' && expected.na) return `n/a: ${expected.na}`;
  return String(expected);
}

function assertNetworkCookieSessions(browser, mutant, label) {
  const misroutes = browser.networkCookieMisroutes();
  const rejects = browser.networkCookieRejects();
  if (!mutant.networkSession) {
    assert.deepEqual(misroutes, [], label);
    assert.deepEqual(
      rejects,
      [],
      `every Network cookie call used the attempt tab session: ${label}`
    );
    return;
  }
  const methods = new Set(misroutes.map((m) => m.method));
  assert.ok(methods.has('Network.getAllCookies'), `jar read misrouted: ${label}`);
  assert.ok(methods.has('Network.deleteCookies'), `jar clear misrouted: ${label}`);
  for (const m of misroutes) {
    const route = `${label}: ${JSON.stringify(m)}`;
    assert.equal(m.mode, mutant.networkSession, route);
    assert.ok(m.from && m.to && m.from !== m.to, route);
    if (mutant.networkSession === 'guard') {
      assert.equal(m.toTarget, m.fromTarget, `guard session on the attempt tab: ${route}`);
      assert.equal(m.toContext, m.fromContext, route);
    } else {
      assert.notEqual(m.toTarget, m.fromTarget, `session on another target: ${route}`);
      assert.equal(m.toContext, 'X0', route);
      assert.notEqual(m.fromContext, 'X0', route);
    }
  }
  if (mutant.networkSession === 'guard') {
    assert.deepEqual(
      rejects.map((r) => `${r.method} ${r.sessionId}`).sort(),
      misroutes.map((m) => `${m.method} ${m.to}`).sort(),
      `the attempt tab session assert rejects exactly the misrouted calls: ${label}`
    );
    return;
  }
  assert.deepEqual(rejects, [], `a live foreign-target session passes the assert: ${label}`);
}

function assertGuardedVerdict(row, expected, label) {
  if (expected === 'not-pass') {
    assert.notEqual(row.guarded, 'pass', label);
    return;
  }
  assert.equal(row.guarded, expected, label);
}

test('planting mutants never expect pass', () => {
  for (const mutant of MUTANT_MATRIX) {
    if (!isPlantingMutant(mutant)) continue;
    for (const rowKind of ['protected', 'credential']) {
      for (const mode of ['off', 'on']) {
        const expected = mutant.expected[rowKind][mode];
        assert.notEqual(
          expected,
          'pass',
          `planting mutant ${mutant.id} ${rowKind} ${mode} must not expect pass`
        );
        if (expected && typeof expected === 'object')
          assert.ok(
            expected.na,
            `planting mutant ${mutant.id} ${rowKind} ${mode} n/a needs reason`
          );
      }
    }
  }
});

for (const mutant of MUTANT_MATRIX) {
  for (const browserContexts of [false, true]) {
    for (const rowKind of ['protected', 'credential']) {
      const mode = browserContexts ? 'on' : 'off';
      const expected = mutant.expected[rowKind][mode];
      const title = `matrix ${mutant.id} browserContexts=${mode} ${rowKind} => ${cellLabel(expected)}`;
      test(title, async () => {
        if (expected && typeof expected === 'object' && expected.na) {
          assert.ok(expected.na.length > 0, title);
          return;
        }
        const onlyPaths = mapPlantPaths(mutant.plant, rowKind);
        const options = {
          ...mutant.options,
          oneTarget: true,
          onlyPaths,
          capabilities: {
            ...(mutant.options.capabilities ?? {}),
            ...(browserContexts ? { browserContexts: true } : {}),
          },
        };
        if (Array.isArray(options.allowPlantPaths)) {
          options.allowPlantPaths = mapAllowPaths(
            options.allowPlantPaths,
            rowKind,
            mutant.allowMap
          );
        }
        if (Array.isArray(options.forwardThenCut)) {
          options.forwardThenCut = mapAllowPaths(
            options.forwardThenCut,
            rowKind,
            mutant.forwardMap
          );
        }
        if (options.forcedRaw && rowKind === 'credential' && mutant.forcedMap) {
          options.forcedRaw = Object.fromEntries(
            Object.entries(options.forcedRaw).map(([k, v]) => [mutant.forcedMap[k] ?? k, v])
          );
        }
        const subset = rowKind === 'protected' ? protectedVectors : credentialVectors;
        const { out, browser } = await rows({ ...options, withBrowser: true }, subset);
        const rowId = rowKind === 'protected' ? 'C10.cookie-plant' : 'C10.cookie-plant.credential';
        const row = out.results.find((r) => r.id === rowId);
        assert.ok(row, `${rowId} missing ${JSON.stringify(out.results)}`);
        assertGuardedVerdict(
          row,
          expected,
          `matrix ${mutant.id} ${mode} ${rowKind}: ${JSON.stringify(row)}`
        );
        assertNetworkCookieSessions(browser, mutant, `matrix ${mutant.id} ${mode} ${rowKind}`);
      });
    }
  }
}
