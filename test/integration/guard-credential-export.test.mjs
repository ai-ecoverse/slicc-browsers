import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { judge } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { credentialOrigins, protectedOrigins } from '../../protected.mjs';
import { credentialBrowser, credentialGuard } from './credential-export-fake.mjs';

const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const ids = set.vectors.filter((v) => v.id.startsWith('C7.')).map((v) => v.id);
const vectors = set.vectors.filter((v) => ids.includes(v.id));

test('C7 prefix enumerates the credential-export row', () => {
  assert.deepEqual(ids, ['C7.credential-export']);
  const vector = vectors[0];
  assert.equal(vector.targets[0], 'idp');
  assert.equal(vector.trigger[0].credentialExport, true);
  assert.ok(vector.notes.some((note) => /response bodies are not redacted/i.test(note)));
  assert.ok(vector.notes.some((note) => /Authorization headers/i.test(note)));
  assert.ok(vector.notes.some((note) => /auth\.services\.adobe\.com/i.test(note)));
  assert.ok(vector.notes.some((note) => /adobeid-na1\.services\.adobe\.com/i.test(note)));
  assert.ok(vector.notes.some((note) => /Domain=\.adobe\.com is not covered/i.test(note)));
  assert.ok(vector.notes.some((note) => /Domain=\.adobe\.com cookie stays exportable/i.test(note)));
  assert.ok(vector.notes.some((note) => /storageKey \^0 site part/i.test(note)));
  assert.equal(
    vector.observe.adobeComCookiesExportable.check.path,
    'result.adobeComCookiesExportable'
  );
  assert.equal(vector.expected.adobeComCookiesExportable, true);
  assert.equal(
    vector.observe.partitionedStorageKeyFiltered.check.path,
    'result.partitionedStorageKeyFiltered'
  );
  assert.equal(vector.expected.partitionedStorageKeyFiltered, true);
  assert.equal(
    vector.observe.adobeComStorageKeyExportable.check.path,
    'result.adobeComStorageKeyExportable'
  );
  assert.equal(vector.expected.adobeComStorageKeyExportable, true);
  assert.equal(vector.observe.getResponseBody, undefined);
  assert.equal(vector.expected.residualEvaluateCookie, undefined);
});

test('credentialOrigins matcher is exact-host and covers cookie domains / topLevelSite', () => {
  const m = credentialOrigins(catalog.credentialOrigins);
  assert.deepEqual(catalog.credentialOrigins.origins, [
    'https://ims-na1.adobelogin.com',
    'https://ims-na1-stg1.adobelogin.com',
  ]);
  assert.equal(m.url('https://ims-na1.adobelogin.com/ims/authorize/v2'), true);
  assert.equal(m.url('http://ims-na1.adobelogin.com:9/'), true);
  assert.equal(m.url('https://auth.services.adobe.com/'), false);
  assert.equal(m.url('https://adobeid-na1.services.adobe.com/'), false);
  assert.equal(m.url('https://x.ims-na1.adobelogin.com/'), false);
  assert.equal(m.cookieDomain('.adobelogin.com'), true);
  assert.equal(m.cookieDomain('ims-na1.adobelogin.com'), true);
  assert.equal(m.cookieDomain('x.ims-na1.adobelogin.com'), false);
  assert.equal(m.cookieDomain('.adobe.com'), false);
  assert.equal(m.cookieDomain('.services.adobe.com'), false);
  assert.equal(m.cookieDomain('auth.services.adobe.com'), false);
  assert.equal(m.topLevelSite('https://adobelogin.com'), true);
  assert.equal(m.topLevelSite('https://adobe.com'), false);
  assert.equal(m.storageKey('https://ims-na1.adobelogin.com'), true);
  assert.equal(m.storageKey('https://ims-na1.adobelogin.com^0https://adobelogin.com'), true);
  assert.equal(m.storageKey('https://ordinary.example.test/^0https://adobelogin.com'), true);
  assert.equal(m.storageKey('https://ordinary.example.test/^0https://adobe.com'), false);
  assert.equal(m.storageKey('https://x.ims-na1.adobelogin.com'), false);
  assert.equal(m.storageKey('https://x.ims-na1.adobelogin.com/^0https://adobelogin.com'), true);
  assert.equal(m.url('https://seven.sliccy.ai/'), false);
  assert.equal(m.url('https://ordinary.example.test/'), false);
  assert.equal(m.cookieDomain('ordinary.example.test'), false);
  const page = protectedOrigins(catalog.protectedOrigins);
  assert.equal(page.url('https://ims-na1.adobelogin.com/'), false);
  assert.equal(page.url('https://auth.services.adobe.com/'), false);
});
async function rows(mutants = {}) {
  const fixture = await fixtureServer();
  try {
    const origin = (host) => `http://${host}:${fixture.port}`;
    const browser = credentialBrowser();
    const { client, unguarded } = credentialGuard(browser, {
      credentialOrigins: catalog.credentialOrigins,
      mutants,
    });
    return await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client,
        unguarded,
        fixture,
        settleScale: 0.1,
        capabilities: { discovery: true },
        credentialOrigins: catalog.credentialOrigins,
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          idp: origin('ims-na1.adobelogin.com'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
          plain: origin('ordinary.example.test'),
        },
      }
    );
  } finally {
    await fixture.close();
  }
}

test('a credential-export guard passes control and guarded', async () => {
  const execution = await rows();
  assert.equal(execution.results.length, 1);
  const row = execution.results[0];
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.live, 'pass', JSON.stringify(row));
  assert.equal(execution.summary().pass, true);
});

test('without an unguarded observer the row skips', async () => {
  const fixture = await fixtureServer();
  try {
    const origin = (host) => `http://${host}:${fixture.port}`;
    const browser = credentialBrowser();
    const { client } = credentialGuard(browser, {
      credentialOrigins: catalog.credentialOrigins,
    });
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client,
        fixture,
        settleScale: 0.1,
        capabilities: { discovery: true },
        credentialOrigins: catalog.credentialOrigins,
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          idp: origin('ims-na1.adobelogin.com'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    assert.equal(execution.results[0].control, 'skip');
    assert.equal(execution.results[0].reason, 'not-supported:unguarded-observer');
  } finally {
    await fixture.close();
  }
});

const mutants = [
  ['leakCookies', { leakCookies: true }],
  ['allowSetCookie', { allowSetCookie: true }],
  ['allowDeleteCookie', { allowDeleteCookie: true }],
  ['leakDomStorage', { leakDomStorage: true }],
  ['leakIndexedDB', { leakIndexedDB: true }],
  ['leakCacheStorage', { leakCacheStorage: true }],
  ['leakHeaders', { leakHeaders: true }],
  ['blockOrdinaryCookies', { blockOrdinaryCookies: true }],
  ['refuseIdpAttach', { refuseIdpAttach: true }],
  ['disabled', { disabled: true }],
];

for (const [name, options] of mutants) {
  test(`mutant ${name} fails the credential-export row`, async () => {
    const execution = await rows(options);
    const row = execution.results[0];
    assert.equal(row.control === 'pass' || row.guarded === 'fail' || row.live !== 'pass', true);
    assert.equal(
      row.guarded === 'fail' ||
        row.control === 'fail' ||
        row.live === 'fail' ||
        row.live === 'incomplete',
      true,
      JSON.stringify(row)
    );
    assert.equal(execution.summary().pass, false);
  });
}

test('judge fails when credential cookies leak', () => {
  const vector = vectors[0];
  assert.equal(
    judge(vector, 'guarded', {
      live: true,
      getCookiesFiltered: false,
      getAllCookiesFiltered: true,
      storageGetCookiesFiltered: true,
      pageGetCookiesFiltered: true,
      setCookieRefused: true,
      setCookiesRefused: true,
      deleteCookiesRefused: true,
      pageDeleteCookieRefused: true,
      storageSetCookiesRefused: true,
      headersStripped: true,
      associatedCookiesStripped: true,
      domStorageRefused: true,
      indexedDBRefused: true,
      cacheStorageRefused: true,
      ordinaryCookiesExportable: true,
      adobeComCookiesExportable: true,
      partitionedStorageKeyFiltered: true,
      adobeComStorageKeyExportable: true,
      pageDrivable: true,
      evaluateOk: true,
      subHostNotCredential: true,
    }).pass,
    false
  );
});
