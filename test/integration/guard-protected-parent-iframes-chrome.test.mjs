import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const ids = ['C3.protected-parent-iframes', 'C3.protected-parent-srcdoc'];
const vectors = set.vectors.filter((v) => ids.includes(v.id));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('protected-parent iframe rows hide ordinary OOPIFs under a protected parent in real Chrome', {
  timeout: 180000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const targets = origins(fixture);
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
  });
  const rows = [];
  try {
    for (const vector of vectors) {
      const liveNotes = [];
      const opts = {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        capabilities: {
          discovery: true,
          browserSession: true,
          browserContexts: true,
        },
        targets,
        notes: liveNotes,
        rowTimeoutMs: 60000,
      };
      const running = run({ ...set, vectors: [vector], variants: { prompt: 0 } }, opts).then(
        (execution) => execution.results
      );
      const timed = await Promise.race([
        running,
        pause(50000).then(() => [
          {
            id: vector.id,
            control: 'fail',
            guarded: 'fail',
            live: 'fail',
            why: 'per-vector budget 50s',
            notes: [...liveNotes],
            errors: ['protected-parent probe timed out'],
            observations: {},
          },
        ]),
      ]);
      rows.push(...timed);
    }
    const report = rows.map((row) => ({
      id: row.id,
      target: row.target,
      control: row.control,
      guarded: row.guarded,
      live: row.live,
      why: row.why,
      incomplete: row.incomplete,
      errors: row.errors,
      notes: row.notes,
      observations: row.observations,
    }));
    for (const row of rows) {
      if (row.id === 'C3.protected-parent-srcdoc' && row.incomplete?.length) {
        assert.match(
          row.incomplete.join(';'),
          /sandboxed srcdoc frame has no own target in this Chrome/,
          JSON.stringify(report, null, 2)
        );
        assert.ok(
          (row.notes ?? []).some((note) =>
            /raw-iframes-missing|srcdoc-no-oopif|srcdoc-tree/.test(note)
          ),
          JSON.stringify(report, null, 2)
        );
        continue;
      }
      assert.equal(
        row.control,
        'pass',
        `${row.id} why=${row.why} notes=${JSON.stringify(row.notes)}`
      );
      assert.equal(
        row.guarded,
        'pass',
        `${row.id} why=${row.why} notes=${JSON.stringify(row.notes)}`
      );
      assert.equal(row.live, 'pass', `${row.id} why=${row.why}`);
      assert.ok(
        (row.notes ?? []).some((note) => note.includes('protected-parent.raw-iframes')),
        `${row.id} missing raw iframe evidence: ${JSON.stringify(row.notes)}`
      );
      assert.equal(row.observations.guarded.iframeListed, false, row.id);
      assert.equal(row.observations.guarded.attachSession, false, row.id);
      assert.equal(row.observations.guarded.attachRefused, true, row.id);
    }
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});
