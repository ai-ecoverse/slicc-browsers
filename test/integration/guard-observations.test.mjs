import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';

const set = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);

for (const expression of [
  "Promise.race([new Promise(() => {}), new Promise(resolve => setTimeout(() => resolve('timeout'), 25))])",
  "Promise.reject(new Error('observation timed out'))",
])
  for (const check of [
    { compare: ['one', 'two'], path: 'result.result.value', observer: 'client' },
    { result: 'one', path: 'result.result.value', equals: 'timeout', observer: 'client' },
    { expression, equals: 'timeout', via: 'unguarded', observer: 'unguarded' },
  ])
    test(`incomplete observations fail instead of comparing: ${JSON.stringify(check)} ${expression}`, async () => {
      const fixture = await fixtureServer();
      const browser = await launch(fixture);
      try {
        const vector = {
          id: 'C1.timeout',
          kind: 'cdp',
          scope: 'any',
          targets: ['seven'],
          setup: [{ page: 'tab', url: '{ordinary}/doc?n={tag}' }],
          trigger: [
            { page: 'eval', expression, as: 'one' },
            { page: 'eval', expression, as: 'two' },
          ],
          observe: { completed: { check } },
          liveCheck: { loaded: '{ordinary}/doc?n={tag}', observer: 'fixture' },
          control: { origin: 'ordinary', via: 'guard', expected: { completed: true } },
          expected: { completed: false },
        };
        const execution = await run(
          { ...set, vectors: [vector], variants: { prompt: 0 } },
          {
            client: browser.client,
            unguarded: browser.unguarded,
            targets: origins(fixture),
            fixture,
          }
        );
        assert.equal(execution.results[0].control, 'fail');
        assert.equal(execution.results[0].guarded, 'fail');
        assert(execution.results[0].errors.includes('Observation did not complete'));
      } finally {
        await browser.close();
        await fixture.close();
      }
    });

test('auth observations use request evidence without a plain baseline', async () => {
  const fixture = await fixtureServer();
  try {
    const vector = set.vectors.find(({ id }) => id === 'C5.auth');
    const execution = await run(
      { ...set, vectors: [{ ...vector, targets: ['seven', 'vault'] }], variants: { prompt: 0 } },
      {
        clientFactory: async () => {
          const browser = await launch(fixture);
          return { client: browser.client, unguarded: browser.client, close: browser.close };
        },
        targets: origins(fixture),
        fixture,
      }
    );
    for (const row of execution.results) {
      assert.equal(row.control, 'pass');
      assert.equal(row.guarded, 'fail');
      assert.equal(row.live, 'pass');
      assert.equal(row.observations.control.authed, true);
      assert.equal(row.observations.guarded.refused, false);
    }
    const requests = await fixture.log();
    assert(!requests.some(({ url }) => new URL(url).searchParams.has('plain')));
  } finally {
    await fixture.close();
  }
});
