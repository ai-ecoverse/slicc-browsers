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
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a correct closeProtected guard refuses the five disguise shapes in real Chrome', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
    closeProtected: true,
  });
  const rows = [];
  try {
    for (const vector of vectors) {
      const timed = await Promise.race([
        run(
          { ...set, vectors: [vector], variants: { prompt: 0 } },
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
        ).then((execution) => execution.results),
        pause(25000).then(() => [
          {
            id: vector.id,
            control: 'fail',
            guarded: 'fail',
            live: 'fail',
            why: 'per-vector budget 25s',
            notes: [],
            errors: ['shape setup timed out'],
            observations: {},
          },
        ]),
      ]);
      rows.push(...timed);
    }
    const report = rows.map((row) => ({
      id: row.id,
      control: row.control,
      guarded: row.guarded,
      live: row.live,
      why: row.why,
      incomplete: row.incomplete,
      errors: row.errors,
      notes: row.notes,
      observations: row.observations,
    }));
    const failed = report.filter(
      (row) => row.control !== 'pass' || row.guarded !== 'pass' || row.live !== 'pass'
    );
    assert.equal(failed.length, 0, JSON.stringify(report, null, 2));
    for (const row of rows) {
      assert.equal(row.observations.guarded.closed, false, row.id);
      assert.equal(row.observations.guarded.closeRefused, true, row.id);
    }
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});
