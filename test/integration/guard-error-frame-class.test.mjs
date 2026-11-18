import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { capabilities as sweepCapabilities } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vectors = set.vectors.filter((v) => v.id === 'C8.iframe-error');

const idle = { send: async () => ({}), events: [] };

async function rowFor(capabilities) {
  const fixture = await fixtureServer();
  try {
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: idle,
        unguarded: idle,
        fixture,
        targets: {
          ordinary: `http://ordinary.example.test:${fixture.port}`,
          'network-error': `http://network-error.test:${fixture.port}`,
        },
        capabilities,
      }
    );
    assert.equal(execution.results.length, 1);
    return execution.results[0];
  } finally {
    await fixture.close();
  }
}

test('errorFrameClass is a declared capability and the only error-frame row requires it', () => {
  assert.match(set.capabilities.errorFrameClass, /protected URL without being given the URL/);
  assert.equal(vectors.length, 1);
  assert.deepEqual(vectors[0].requires, ['browserSession', 'errorFrameClass']);
  const gated = set.vectors.filter((v) => (v.requires ?? []).includes('errorFrameClass'));
  assert.deepEqual(
    gated.map((v) => v.id),
    ['C8.iframe-error']
  );
  assert.equal(sweepCapabilities.errorFrameClass, true);
});

test('a guard that cannot classify error frames skips C8.iframe-error as not-supported:errorFrameClass', async () => {
  for (const declared of [
    { browserSession: true },
    { browserSession: true, errorFrameClass: false },
    { browserSession: true, autoAttach: true, browserContexts: true },
  ]) {
    const row = await rowFor(declared);
    assert.deepEqual([row.control, row.guarded, row.live], ['skip', 'skip', 'skip']);
    assert.equal(row.reason, 'not-supported:errorFrameClass');
  }
});

test('declaring errorFrameClass satisfies its gate: the next missing capability is reported instead', async () => {
  const row = await rowFor({ errorFrameClass: true });
  assert.equal(row.reason, 'not-supported:browserSession');
  const declared = await rowFor({ errorFrameClass: true, browserSession: true });
  assert.notEqual(declared.reason, 'not-supported:errorFrameClass');
});
