import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { connect, launch, origins } from './cdp-client.mjs';

const set = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);
const late = 1500;
const ids = ['C5.guessed-id.continue-response', 'C5.guessed-id.continue-with-auth', 'C5.auth'];

test('a guess waits for the held pause, so a late pause still leaves the control passing', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer({
    latency: (url) => {
      const n = url.searchParams.get('n') ?? '';
      const held =
        (url.pathname === '/data' || url.pathname.startsWith('/auth/')) &&
        n !== '' &&
        !/^(a|b|before|after)-/.test(n);
      return held ? late : 0;
    },
  });
  const browser = await launch(fixture);
  const client = await connect(browser.ws);
  try {
    const vectors = set.vectors
      .filter((vector) => ids.includes(vector.id))
      .map((vector) => ({ ...vector, targets: ['seven'] }));
    assert.equal(vectors.length, ids.length);
    const { results } = await run(
      { ...set, vectors, variants: { prompt: set.variants.prompt } },
      {
        client,
        unguarded: client,
        targets: origins(fixture),
        fixture,
        capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
      }
    );
    assert.deepEqual(
      results
        .map(({ id, control, why, errors }) => ({ id, control, why, errors }))
        .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
      ids.map((id) => ({
        id,
        control: 'pass',
        why: results.find((row) => row.id === id)?.why,
        errors: [],
      }))
    );
  } finally {
    await client.close();
    await browser.close();
    await fixture.close();
  }
});

test('a pause that never comes fails the control row by name', { timeout: 120000 }, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const client = await connect(browser.ws);
  try {
    const vector = structuredClone(
      set.vectors.find((item) => item.id === 'C5.guessed-id.continue-response')
    );
    const step = vector.trigger.find((item) => item.paused);
    step.paused = { url: '{target}/data?n=never-{tag}', ms: 500 };
    const { results } = await run(
      { ...set, vectors: [{ ...vector, targets: ['seven'] }], variants: { prompt: 0 } },
      {
        client,
        unguarded: client,
        targets: origins(fixture),
        fixture,
        capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
      }
    );
    assert.equal(results[0].control, 'fail');
    assert.ok(
      results[0].errors.some((error) =>
        /^paused: no pause for http:\/\/[^ ]+\/data\?n=never-[^ ]+ within 500ms$/.test(error)
      ),
      JSON.stringify(results[0].errors)
    );
  } finally {
    await client.close();
    await browser.close();
    await fixture.close();
  }
});
