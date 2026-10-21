import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { connect, launch, origins } from './cdp-client.mjs';

const set = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  clientExit: true,
};

async function exitRow(leaky) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const legs = [];
  try {
    const vector = { ...set.vectors.find((v) => v.id === 'X1.after-exit'), targets: ['seven'] };
    const execution = await run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      {
        clientFactory: async ({ leg }) => {
          legs.push(leg ?? 'control');
          const raw = await connect(browser.ws);
          const unguarded = await connect(browser.ws);
          const client = leaky ? { ...raw, close: () => {} } : raw;
          return {
            client,
            unguarded,
            close: () => {
              raw.close();
              unguarded.close();
            },
          };
        },
        targets: origins(fixture),
        capabilities,
        fixture,
      }
    );
    return { row: execution.results[0], legs };
  } finally {
    await browser.close();
    await fixture.close();
  }
}

test('a client that really exits passes X1.after-exit with a fresh client per leg', {
  timeout: 120000,
}, async () => {
  const { row, legs } = await exitRow(false);
  assert.deepEqual(legs, ['control', 'guarded']);
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.live, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.served, true);
  assert.equal(row.observations.guarded.scripted, false);
});

test('a client whose session outlives its exit fails X1.after-exit', {
  timeout: 120000,
}, async () => {
  const { row } = await exitRow(true);
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.forged, true, JSON.stringify(row.observations));
  assert.equal(row.observations.guarded.paused, true, JSON.stringify(row.observations));
});
