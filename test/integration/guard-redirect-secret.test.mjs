import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { protectedOrigins } from '../../protected.mjs';
import { redactProtectedURLs } from '../../redirect-redaction.mjs';
import { containsSecret } from '../../redirect-secret.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const tls = {
  key: await readFile(new URL('./fixtures/tls-key.pem', import.meta.url)),
  cert: await readFile(new URL('./fixtures/tls-cert.pem', import.meta.url)),
};
const spki = createHash('sha256')
  .update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');

test('nested protected URL redaction retains embedded headers and removes query and fragment secrets', () => {
  const matcher = protectedOrigins(catalog.protectedOrigins);
  const url = 'https://seven.sliccy.ai/auth/callback?code=secret#access_token=secret';
  const value = {
    headers: { Location: url, Refresh: `0;url=${url}`, Link: `<${url}>; rel=preconnect` },
    headersText: `HTTP/1.1 302 Found\r\nLocation: ${url}\r\n`,
    params: [url, `exception at ${url}`],
  };
  const redacted = redactProtectedURLs(value, matcher);
  assert.equal(redacted.headers.Location, 'https://seven.sliccy.ai');
  assert.equal(redacted.headers.Refresh, '0;url=https://seven.sliccy.ai');
  assert.equal(redacted.headers.Link, '<https://seven.sliccy.ai>; rel=preconnect');
  assert.equal(containsSecret(redacted, 'secret'), false);
  for (const text of [
    'secret/+"token',
    encodeURIComponent('secret/+"token'),
    JSON.stringify('secret/+"token'),
    Buffer.from('prefix secret/+"token suffix').toString('base64'),
  ])
    assert.equal(containsSecret({ nested: [text] }, 'secret/+"token'), true, text);
  const ordinary = 'https://ordinary.example.test/doc?code=secret';
  assert.equal(redactProtectedURLs(ordinary, matcher), ordinary);
});

test('real Chrome redirect-secret catalog passes and plain or parsed-headers-only guards fail', {
  timeout: 900000,
}, async () => {
  const fixture = await fixtureServer({ tls });
  try {
    for (const mode of process.env.REDIRECT_MODE
      ? [process.env.REDIRECT_MODE]
      : ['catalog', 'plain', 'parsed-headers-only']) {
      const browser = await launch(fixture, { spki });
      const guard =
        mode === 'plain'
          ? null
          : emulatedGuard(browser, {
              protectedOrigins: catalog.protectedOrigins,
              redirectSecrets: true,
              parsedHeadersOnly: mode === 'parsed-headers-only',
              redirects: fixture.redirects,
            });
      try {
        const evidence = {};
        const execution = await run(
          {
            ...set,
            vectors: set.vectors.filter(
              (vector) =>
                vector.id.startsWith('C2.redirect') &&
                (!process.env.REDIRECT_ROW || vector.id === process.env.REDIRECT_ROW)
            ),
            variants: { prompt: 0 },
          },
          {
            client: guard?.client ?? browser.client,
            unguarded: browser.unguarded,
            fixture,
            targets: Object.fromEntries(
              Object.entries(origins(fixture)).map(([key, origin]) => [
                key,
                origin.replace(`:${fixture.port}`, ''),
              ])
            ),
            capabilities: { browserSession: true },
            rowTimeoutMs: 120000,
            debug: (entry) => {
              if (entry.calls?.redirect) evidence[entry.side] = entry.calls.redirect;
            },
          }
        );
        for (const row of execution.results) {
          console.log(JSON.stringify({ mode, row, evidence }));
          assert.equal(row.control, 'pass', JSON.stringify({ mode, row, evidence }));
          assert.equal(
            row.guarded,
            mode === 'catalog' ? 'pass' : 'fail',
            JSON.stringify({ mode, row, evidence })
          );
          assert.equal(row.live, 'pass', JSON.stringify({ mode, row, evidence }));
        }
      } finally {
        await guard?.stop();
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
});
