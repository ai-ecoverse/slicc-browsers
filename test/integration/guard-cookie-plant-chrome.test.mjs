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
const c5Vectors = data.vectors.filter((v) => c5Ids.includes(v.id));
const protectedVectors = data.vectors.filter((v) => v.id === 'C10.cookie-plant');
const credentialVectors = data.vectors.filter((v) => v.id === 'C10.cookie-plant.credential');
const capabilities = {
  requestInterception: true,
  fetchInterception: true,
};

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

test('C5-correct emulator passes C5.document, C5.fulfill and C10.cookie-plant in real Chrome', {
  timeout: 300000,
}, async () => {
  const { fixture, spki } = await tlsFixture();
  const browser = await launch(fixture, { spki });
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
    cookiePlant: true,
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
        rowTimeoutMs: 180000,
      }
    );
    for (const row of c5.results.filter((r) => ['seven', 'vault'].includes(r.target))) {
      assert.equal(row.live, 'pass', dump(row));
      assert.equal(row.guarded, 'pass', dump(row));
    }
    const plant = await run(
      { ...data, vectors: protectedVectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        catalog,
        capabilities,
        rowTimeoutMs: 180000,
      }
    );
    assert.equal(plant.results.length, 2);
    for (const row of plant.results) {
      assert.equal(row.live, 'pass', dump(row));
      assert.equal(row.control, 'pass', dump(row));
      assert.equal(row.guarded, 'pass', dump(row));
    }
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});

test('admitProtectedNavigation mutant that plants fails C10.cookie-plant in real Chrome', {
  timeout: 300000,
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
    const execution = await run(
      { ...data, vectors: protectedVectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        catalog,
        capabilities,
        rowTimeoutMs: 180000,
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
  timeout: 300000,
}, async () => {
  const { fixture, spki } = await tlsFixture();
  const browser = await launch(fixture, { spki });
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    credentialOrigins: catalog.credentialOrigins,
    extraOrigins: [targets.idp, targets['idp-stg']],
    cookiePlant: true,
  });
  try {
    const execution = await run(
      { ...data, vectors: credentialVectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        catalog,
        credentialOrigins: catalog.credentialOrigins,
        capabilities,
        rowTimeoutMs: 180000,
      }
    );
    assert.equal(execution.results.length, 2);
    for (const row of execution.results) {
      assert.equal(row.live, 'pass', dump(row));
      assert.equal(row.control, 'pass', dump(row));
      assert.equal(row.guarded, 'pass', dump(row));
      assert.equal(row.observations.guarded.hostOnlyPlanted, false, dump(row));
      assert.equal(row.observations.guarded.domainCoverPlanted, false, dump(row));
      assert.equal(row.observations.guarded.subHostPlanted, true, dump(row));
    }
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});
