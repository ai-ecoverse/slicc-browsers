import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const ids = ['C3.tab-attach.explicit', 'C3.tab-protected.explicit'];
const vectors = set.vectors.filter((vector) => ids.includes(vector.id));
const capabilities = {
  explicitAttach: true,
  browserSession: true,
  discovery: true,
  browserContexts: true,
};

async function chromeRun(mutant) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const targets = origins(fixture);
  const guard =
    mutant === undefined
      ? { client: browser.client, stop: async () => {} }
      : emulatedGuard(browser, {
          explicitAttach: mutant,
          protectedOrigins: catalog.protectedOrigins,
          extraOrigins: [targets.seven, targets.vault],
        });
  try {
    return await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets,
        capabilities,
        rowTimeoutMs: 120000,
      }
    );
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
}

const shown = (row) =>
  JSON.stringify({
    id: row.id,
    target: row.target,
    legs: [row.control, row.guarded, row.live],
    why: row.why,
    errors: row.errors,
    incomplete: row.incomplete,
    observations: row.observations,
    notes: row.notes,
  });

for (const [name, mutant] of Object.entries({ hiding: {}, redacting: { redact: true } }))
  test(`a ${name} explicit guard passes both explicit rows in Chrome`, {
    timeout: 600000,
  }, async () => {
    const execution = await chromeRun(mutant);
    assert.equal(execution.results.length, 3);
    for (const row of execution.results)
      assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], shown(row));
    assert.equal(execution.summary({ guard: name }).pass, true);
  });

test('without a guard the protected explicit row fails in Chrome and its control passes', {
  timeout: 600000,
}, async () => {
  const execution = await chromeRun();
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', shown(row));
    assert.equal(row.live, 'pass', shown(row));
    assert.equal(row.guarded, row.target === 'ordinary' ? 'pass' : 'fail', shown(row));
  }
});

test('an explicit guard that attaches to a protected target by its raw id fails in Chrome', {
  timeout: 600000,
}, async () => {
  const execution = await chromeRun({ allowAttach: true });
  for (const row of execution.results.filter((entry) => entry.target !== 'ordinary')) {
    assert.equal(row.control, 'pass', shown(row));
    assert.equal(row.guarded, 'fail', shown(row));
    assert.equal(row.observations.guarded.attachSession, true, shown(row));
  }
});
