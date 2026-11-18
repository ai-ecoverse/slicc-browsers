import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { cookiePlantFake } from './cookie-plant-fake.mjs';
import { emulatedGuard } from './guard-emulator.mjs';
import { drivable, capabilities as sweepCaps } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const ids = ['C10.cookie-plant'];
const vectors = set.vectors.filter((v) => ids.includes(v.id));

const caps = {
  requestInterception: true,
  fetchInterception: true,
  legacyInterception: true,
};

async function rows(options = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const { capabilities: extraCaps, ...guardOptions } = options;
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      cookiePlant: true,
      ...guardOptions,
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
          targets: {
            ordinary: origin('ordinary.example.test'),
            seven: origin('seven.sliccy.ai'),
            vault: origin('vault.sliccy.ai'),
            own: origin('client.example.test'),
            client: origin('client.example.test'),
            log: origin('log.example.test'),
          },
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
  assert.equal(vectors.length, 1);
  const vector = vectors[0];
  assert.equal(drivable.has(vector.id), false, vector.id);
  assert.deepEqual(vector.requires, ['requestInterception']);
  assert.equal(vector.control.via, 'guard');
  assert.equal(vector.expected.fulfillArrayPlanted, false);
  assert.equal(vector.control.expected.fulfillArrayPlanted, true);
  assert.equal(vector.expected.ordinaryPlanted, true);
  assert.equal(vector.expected.deletionRefused, false);
  assert.equal(vector.expected.deletionCleared, true);
  assert.equal(vector.expected.adobeRefused, false);
  assert.ok(sweepCaps.requestInterception === true || sweepCaps.requestInterception === undefined);
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
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        settleScale: 0.1,
        capabilities: { fetchInterception: true, legacyInterception: true },
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
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

test('unguarded client fails the guarded expectations', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const out = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        settleScale: 0.1,
        capabilities: caps,
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
  } finally {
    await fixture.close();
  }
});

for (const path of ['fulfillObject', 'fulfillLower', 'fulfillBinary', 'legacyRaw', 'redirect3xx']) {
  test(`mutant allowPlantPaths=${path} fails`, async () => {
    const out = await rows({ allowPlantPaths: [path] });
    const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
  });
}

test('refuse-all interception fails the controls', async () => {
  const out = await rows({ refuseAllInterception: true });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('refuseWithoutFail still finishes and protects', async () => {
  const out = await rows({ refuseWithoutFail: true });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.live, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.control, 'pass', JSON.stringify(row));
});

test('unreadable jar after a plant is incomplete, not a false pass', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = cookiePlantFake({ rejectCplantJarAfterFirst: true });
    const origin = (host) => `http://${host}:${fixture.port}`;
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      cookiePlant: true,
      allowPlantPaths: ['fulfillArray'],
    });
    try {
      const out = await run(
        { ...set, vectors, variants: { prompt: 0 } },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: caps,
          targets: {
            ordinary: origin('ordinary.example.test'),
            seven: origin('seven.sliccy.ai'),
            vault: origin('vault.sliccy.ai'),
            own: origin('client.example.test'),
            client: origin('client.example.test'),
            log: origin('log.example.test'),
          },
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
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.fulfillArrayPlanted, false, JSON.stringify(row));
  assert.notEqual(row.observations.guarded.fulfillArrayPlanted, 'not-supported');
});

test('fetch-only transport skips legacy observations', async () => {
  const out = await rows({
    capabilities: { ...caps, legacyInterception: false },
  });
  const row = out.results.find((r) => r.id === 'C10.cookie-plant' && r.target === 'seven');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.legacyRawPlanted, 'not-supported');
});
