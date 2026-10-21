import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
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
const parallel = 4;
const batch = set.vectors.filter(
  (vector) => vector.id.startsWith('C2.redirect') || vector.id.startsWith('C8.protected')
);
const transports = { seven: 'seven.sliccy.ai', 'six-bridge': 'www.sliccy.ai' };

for (const [transport, host] of Object.entries(transports))
  test(`the C2.redirect and C8.protected batch passes at parallel ${parallel} for a ${transport} client`, {
    timeout: 900000,
  }, async () => {
    const fixture = await fixtureServer({ tls });
    const browsers = [];
    const guards = [];
    try {
      for (let slot = 0; slot < parallel; slot++) {
        const browser = await launch(fixture, { spki });
        browsers.push(browser);
        guards.push(
          emulatedGuard(browser, {
            protectedOrigins: catalog.protectedOrigins,
            redirectSecrets: true,
            redirects: fixture.redirects,
          })
        );
      }
      const targets = Object.fromEntries(
        Object.entries(origins(fixture)).map(([key, origin]) => [
          key,
          origin.replace(`:${fixture.port}`, ''),
        ])
      );
      const execution = await run(
        { ...set, vectors: batch },
        {
          clientFactory: async ({ slot }) => ({
            client: guards[slot].client,
            unguarded: browsers[slot].unguarded,
          }),
          parallel,
          fixture,
          targets: { ...targets, own: `https://${host}`, client: `https://${host}` },
          capabilities: { browserSession: true, discovery: true },
          rowTimeoutMs: 180000,
        }
      );
      const rows = execution.results.map((row) => ({
        row: `${row.id} ${row.target} ${row.variant}`,
        verdict: `${row.control}/${row.guarded}/${row.live}`,
        why: row.why,
        errors: row.errors,
        incomplete: row.incomplete,
      }));
      process.stdout.write(`${transport}: ${JSON.stringify(rows)}\n`);
      assert.equal(execution.results.length, batch.length * Object.keys(set.variants).length);
      assert.deepEqual(
        rows.filter((entry) => entry.verdict !== 'pass/pass/pass'),
        []
      );
      assert.equal(execution.summary().incomplete, 0);
    } finally {
      await Promise.allSettled(guards.map((guard) => guard.stop()));
      await Promise.allSettled(browsers.map((browser) => browser.close()));
      await fixture.close();
    }
  });
