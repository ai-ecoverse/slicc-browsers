import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const c5Ids = ['C5.document', 'C5.fulfill'];
const c5Vectors = data.vectors
  .filter((v) => c5Ids.includes(v.id))
  .map((v) => ({ ...v, targets: ['seven'] }));
const protectedVectors = data.vectors
  .filter((v) => v.id === 'C10.cookie-plant')
  .map((v) => ({ ...v, targets: ['seven'] }));
const credentialVectors = data.vectors
  .filter((v) => v.id === 'C10.cookie-plant.credential')
  .map((v) => ({ ...v, targets: ['idp'] }));
const capabilities = {
  requestInterception: true,
  fetchInterception: true,
  browserContexts: true,
};
const chromePlantPaths = [
  'fulfillArray',
  'fulfillLower',
  'fulfillBinary',
  'redirect3xx',
  'ordinary',
  'adobe',
  'deletion',
];
const chromeCredentialPaths = ['hostOnly', 'domainCover', 'subHost', 'adobe'];

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

function dump(row) {
  return JSON.stringify({
    id: row.id,
    target: row.target,
    live: row.live,
    control: row.control,
    guarded: row.guarded,
    why: row.why,
    notes: row.notes,
  });
}

async function tlsFixture() {
  const tls = {
    key: await readFile(new URL('./fixtures/tls-key.pem', import.meta.url)),
    cert: await readFile(new URL('./fixtures/tls-cert.pem', import.meta.url)),
  };
  const spki = createHash('sha256')
    .update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  return { fixture: await fixtureServer({ tls }), spki };
}

test('C5-correct emulator without cookiePlant layer passes C5.document, C5.fulfill and C10.cookie-plant in real Chrome', {
  timeout: 180000,
}, async () => {
  const { fixture, spki } = await tlsFixture();
  const browser = await launch(fixture, { spki });
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
  });
  try {
    const c5 = await run(
      { ...data, vectors: c5Vectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        catalog,
        capabilities,
        settleScale: 0.25,
        rowTimeoutMs: 90000,
      }
    );
    for (const row of c5.results.filter((r) => r.target === 'seven')) {
      assert.equal(row.live, 'pass', dump(row));
      assert.equal(row.guarded, 'pass', dump(row));
    }
    const plant = await run(
      {
        ...data,
        vectors: protectedVectors.map((v) => prunePaths(v, chromePlantPaths)),
        variants: { prompt: 0 },
      },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        catalog,
        capabilities,
        settleScale: 0.25,
        rowTimeoutMs: 90000,
        cookiePlantOnlyPaths: chromePlantPaths,
      }
    );
    assert.equal(plant.results.length, 1);
    const row = plant.results[0];
    assert.equal(row.live, 'pass', dump(row));
    assert.equal(row.control, 'pass', dump(row));
    assert.equal(row.guarded, 'pass', dump(row));
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});

test('admitProtectedNavigation mutant that plants fails C10.cookie-plant in real Chrome', {
  timeout: 120000,
}, async () => {
  const { fixture, spki } = await tlsFixture();
  const browser = await launch(fixture, { spki });
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
    cookiePlant: true,
    admitProtectedNavigation: true,
    allowPlantPaths: [
      'fulfillArray',
      'fulfillLower',
      'fulfillBinary',
      'continueResponse',
      'redirect3xx',
      'legacyRaw',
    ],
  });
  try {
    const onlyPaths = ['fulfillArray'];
    const execution = await run(
      {
        ...data,
        vectors: protectedVectors.map((v) => prunePaths(v, onlyPaths)),
        variants: { prompt: 0 },
      },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        catalog,
        capabilities,
        settleScale: 0.25,
        rowTimeoutMs: 90000,
        cookiePlantOnlyPaths: onlyPaths,
      }
    );
    const row = execution.results.find((r) => r.target === 'seven');
    assert.ok(row, dump(row));
    assert.equal(row.guarded, 'fail', dump(row));
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});

test('C10.cookie-plant.credential reaches live:pass in real Chrome with the cookiePlant guard', {
  timeout: 120000,
}, async () => {
  const { fixture, spki } = await tlsFixture();
  const browser = await launch(fixture, { spki });
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    credentialOrigins: catalog.credentialOrigins,
    cookiePlant: true,
  });
  try {
    const execution = await run(
      {
        ...data,
        vectors: credentialVectors.map((v) => prunePaths(v, chromeCredentialPaths)),
        variants: { prompt: 0 },
      },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        catalog,
        credentialOrigins: catalog.credentialOrigins,
        capabilities,
        settleScale: 0.25,
        rowTimeoutMs: 90000,
        cookiePlantOnlyPaths: chromeCredentialPaths,
      }
    );
    assert.equal(execution.results.length, 1);
    const row = execution.results[0];
    assert.equal(row.live, 'pass', dump(row));
    assert.equal(row.control, 'pass', dump(row));
    assert.equal(row.guarded, 'pass', dump(row));
    assert.equal(row.observations.guarded.hostOnlyPlanted, false, dump(row));
    assert.equal(row.observations.guarded.domainCoverPlanted, false, dump(row));
    assert.equal(row.observations.guarded.subHostPlanted, true, dump(row));
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});
