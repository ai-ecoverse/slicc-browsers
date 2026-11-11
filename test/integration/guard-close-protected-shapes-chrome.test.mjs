import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const ids = [
  'C8.close-protected.view-source',
  'C8.close-protected.blob',
  'C8.close-protected.userinfo',
  'C8.close-protected.navigating',
  'C8.close-protected.blank-inherited',
];
const vectors = set.vectors.filter((v) => ids.includes(v.id));

test('a correct closeProtected guard refuses the five disguise shapes in real Chrome', {
  timeout: 180000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
    closeProtected: true,
  });
  try {
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        capabilities: {
          discovery: true,
          closeProtected: true,
          browserSession: true,
          browserContexts: true,
        },
        targets,
      }
    );
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', `${row.id} control ${JSON.stringify(row)}`);
      assert.equal(row.guarded, 'pass', `${row.id} guarded ${JSON.stringify(row)}`);
      assert.equal(row.live, 'pass', `${row.id} live ${JSON.stringify(row)}`);
      assert.equal(row.observations.guarded.closed, false, row.id);
      assert.equal(row.observations.guarded.closeRefused, true, row.id);
    }
    assert.equal(execution.summary().pass, true);
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});
