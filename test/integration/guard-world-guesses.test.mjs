import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const { protectedOrigins } = JSON.parse(
  await readFile(new URL('../../catalog.json', import.meta.url))
);
const vector = set.vectors.find((row) => row.id === 'C9.world-select');

async function selection({ seed, refuseExposed = false }) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const guard = emulatedGuard(browser, { protectedOrigins });
  const evidence = {};
  const client = {
    ...guard.client,
    send: async (method, params, session) => {
      const id = params?.contextId ?? params?.executionContextId;
      if (
        refuseExposed &&
        id !== undefined &&
        guard.client.events.some(
          (event) =>
            event.sessionId === session &&
            event.method === 'Runtime.executionContextCreated' &&
            event.params.context.id === id
        )
      )
        throw new Error('slicc: refused: all numeric selectors');
      const out = await guard.client.send(method, params, session);
      if (seed && method === 'Page.enable') {
        const { frameTree } = await browser.client.send('Page.getFrameTree', {}, session);
        if (frameTree.frame.url === 'about:blank')
          await browser.client.send(
            'Page.createIsolatedWorld',
            { frameId: frameTree.frame.id, worldName: 'c9-ordinary-seed' },
            session
          );
      }
      return out;
    },
  };
  try {
    const execution = await run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      {
        client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: { extensionWorld: true },
        rowTimeoutMs: 30000,
        debug: (entry) => {
          if (entry.calls?.world?.result) evidence[entry.side] = entry.calls.world.result;
        },
      }
    );
    return { row: execution.results[0], evidence, summary: execution.summary() };
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
}

test('numeric ids 1..32 never reach the hidden marker, but exposed contexts remain usable', {
  timeout: 60000,
}, async () => {
  const { row, evidence, summary } = await selection({ seed: false });
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(summary.pass, true);
  assert.equal(evidence.control.pageMarkerAbsent, true);
  assert.equal(evidence.control.guessesReached, true);
  for (let id = 1; id <= 32; id++) {
    const probes = evidence.guarded.numericGuesses.filter((guess) => guess.id === id);
    assert.equal(probes.length, 2, JSON.stringify(evidence));
    for (const guess of probes) {
      assert.equal(guess.reached, false, JSON.stringify(guess));
      assert.equal(
        guess.exposed ? guess.ok && !guess.refused : guess.refused,
        true,
        JSON.stringify(guess)
      );
    }
  }
  assert(
    evidence.guarded.numericGuesses
      .filter((guess) => guess.id === evidence.guarded.hiddenNumericId)
      .every((guess) => guess.refused)
  );
  assert(evidence.guarded.uniqueGuesses.every((guess) => guess.refused));
});

test('a control-tab numeric id that aliases the guarded page default context must succeed', {
  timeout: 60000,
}, async () => {
  const { row, evidence } = await selection({ seed: true });
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  const aliases = evidence.guarded.numericGuesses.filter(
    (guess) => guess.id === evidence.guarded.controlNumericId
  );
  assert.equal(aliases.length, 2);
  for (const guess of aliases) {
    assert.equal(guess.exposed, true, JSON.stringify(evidence));
    assert.equal(guess.ok, true);
    assert.equal(guess.refused, false);
    assert.equal(guess.reached, false);
  }
  assert.notEqual(evidence.guarded.controlNumericId, evidence.guarded.hiddenNumericId);
});

test('blanket refusal of numeric contexts exposed to the client fails the selector row', {
  timeout: 60000,
}, async () => {
  const { row, evidence } = await selection({ seed: false, refuseExposed: true });
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(evidence.guarded.exposedContextsWork, false);
});
