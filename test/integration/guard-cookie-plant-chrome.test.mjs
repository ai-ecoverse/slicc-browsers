import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const vectors = data.vectors.filter((v) => v.id === 'C10.cookie-plant');
const capabilities = {
  requestInterception: true,
  fetchInterception: true,
};

test('C10.cookie-plant reaches live:pass in real Chrome with the cookiePlant guard', {
  timeout: 180000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
    cookiePlant: true,
  });
  try {
    const execution = await run(
      { ...data, vectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        capabilities,
        rowTimeoutMs: 180000,
      }
    );
    assert.equal(execution.results.length, 2);
    for (const row of execution.results) {
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
    }
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});
