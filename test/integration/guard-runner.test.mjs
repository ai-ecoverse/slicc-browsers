import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';

const set = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);

test('foreground tab requests are reflected by the real document', async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    const vector = {
      id: 'C1.foreground',
      kind: 'cdp',
      scope: 'any',
      targets: ['seven'],
      setup: [{ page: 'tab', url: '{ordinary}/doc?n={tag}', background: false }],
      trigger: [{ page: 'eval', expression: 'document.visibilityState', as: 'visibility' }],
      observe: {
        visible: {
          check: {
            result: 'visibility',
            path: 'result.result.value',
            equals: 'visible',
            observer: 'client',
          },
        },
      },
      liveCheck: { loaded: '{ordinary}/doc?n={tag}', observer: 'fixture' },
      control: { origin: 'ordinary', via: 'guard', expected: { visible: true } },
      expected: { visible: true },
    };
    const execution = await run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      { client: browser.client, unguarded: browser.client, targets: origins(fixture), fixture }
    );
    assert.equal(execution.results[0].control, 'pass');
    assert.equal(execution.results[0].guarded, 'pass');
  } finally {
    await browser.close();
    await fixture.close();
  }
});
