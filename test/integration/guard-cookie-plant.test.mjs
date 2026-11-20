import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fixtureServer } from '../../fixture-server.mjs';
import { rowBudgetMs, run } from '../../guard-runner.mjs';
import { cookiePlantFake } from './cookie-plant-fake.mjs';
import { emulatedGuard } from './guard-emulator.mjs';
import { drivable, capabilities as sweepCaps } from './guard-sweep.mjs';

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
      return await run(
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

test('C10.cookie-plant declares timeoutMs finite and at least the runner global', () => {
  const global = 180000;
  for (const vector of vectors) {
    assert.ok(Number.isFinite(vector.timeoutMs) && vector.timeoutMs > 0, vector.id);
    assert.ok(
      vector.timeoutMs >= global,
      `${vector.id} timeoutMs ${vector.timeoutMs} < global ${global}`
    );
    assert.equal(rowBudgetMs(vector, { rowTimeoutMs: global }), Math.max(vector.timeoutMs, global));
  }
});

test('vector timeoutMs below the global does not shrink the row budget', () => {
  assert.equal(rowBudgetMs({ timeoutMs: 1000 }, { rowTimeoutMs: 90000 }), 90000);
  assert.equal(rowBudgetMs({ timeoutMs: 19410 }, { rowTimeoutMs: 90000 }), 90000);
  assert.equal(rowBudgetMs({ timeoutMs: 360000 }, { rowTimeoutMs: 90000 }), 360000);
  assert.equal(rowBudgetMs({}, { rowTimeoutMs: 90000 }), 90000);
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

test('m10 Fetch.enable unanswered => incomplete', async () => {
  const out = await rows({
    hangFetchEnable: true,
    oneTarget: true,
    onlyPaths: ['fulfillArray'],
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
});

test('m11 Fetch.enable refused is refusal of the interception plant surface => pass', async () => {
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

test('m12 raw leg timeout => door absent; guard that plants fails', async () => {
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
