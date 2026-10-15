import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';

const tls = {
  key: await readFile(new URL('./fixtures/tls-key.pem', import.meta.url)),
  cert: await readFile(new URL('./fixtures/tls-cert.pem', import.meta.url)),
};
const spki = createHash('sha256')
  .update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
const vector = () => ({
  id: 'C1.https',
  kind: 'cdp',
  scope: 'any',
  targets: ['own'],
  setup: [{ page: 'tab', url: '{client}/doc?n={tag}' }],
  trigger: [
    { page: 'href', url: '{target}/doc?n={tag}', hops: [{ origin: '{ordinary}', code: 302 }] },
    { settle: { ms: 200 } },
  ],
  observe: {
    served: { check: { served: '{target}/doc?n={tag}', observer: 'fixture' } },
    hops: {
      check: {
        hops: [{ origin: '{ordinary}', code: 302 }],
        to: '{target}/doc?n={tag}',
        observer: 'fixture',
      },
    },
  },
  liveCheck: { loaded: '{target}/doc?n={tag}', observer: 'fixture' },
  control: { origin: 'ordinary', via: 'unguarded', expected: { served: true, hops: true } },
  expected: { served: true, hops: true },
});
const set = (vectors) => ({
  schemaVersion: 1,
  setVersion: '1.0.0',
  variants: { prompt: 0 },
  vectors,
});

test('HTTPS fixture URLs certify served, redirect hops and guarded liveness', async () => {
  const fixture = await fixtureServer({ tls });
  try {
    const browser = await launch(fixture, { spki });
    try {
      const targets = origins(fixture);
      targets.own = targets.client = `https://client.sliccy.ai:${fixture.port}`;
      const execution = await run(set([vector()]), {
        client: browser.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
      });
      const row = execution.results[0];
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert(fixture.origin.startsWith('https://'));
      assert(fixture.log().every((entry) => entry.url.startsWith('https://')));
      assert(fixture.log().some((entry) => new URL(entry.url).origin === targets.own));
      assert(
        fixture.log().some((entry) => {
          const url = new URL(entry.url);
          return url.pathname === '/live' && url.searchParams.get('to')?.startsWith(targets.own);
        })
      );
    } finally {
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
});

test('unavailable origins skip row targets and dependent rows without browser effects', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    try {
      const before = await browser.client.send('Target.getTargets');
      const direct = { ...vector(), id: 'C1.unavailable', targets: ['ordinary-same-site'] };
      const dependent = vector();
      dependent.setup = [{ page: 'tab', url: '{ordinary-same-site}/doc?n={tag}' }];
      const execution = await run(set([direct, dependent]), {
        client: browser.client,
        unguarded: browser.unguarded,
        targets: { ...origins(fixture), 'ordinary-same-site': null },
        fixture,
      });
      assert.equal(execution.results.length, 2);
      for (const row of execution.results) {
        assert.equal(row.control, 'skip');
        assert.equal(row.guarded, 'skip');
        assert.equal(row.live, 'skip');
        assert.equal(row.reason, 'not-applicable:no-ordinary-same-site-origin');
      }
      assert.deepEqual(fixture.log(), []);
      const after = await browser.client.send('Target.getTargets');
      const urls = ({ targetInfos }) => targetInfos.map(({ url }) => url).sort();
      assert.deepEqual(urls(after), urls(before));
    } finally {
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
});
