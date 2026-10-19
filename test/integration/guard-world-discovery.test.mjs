import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ID } from '@ai-ecoverse/slicc-shared-web/harness';
import { DEFAULT_EXTENSION_WORLD_ID } from '../../extension-world.mjs';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const { protectedOrigins } = JSON.parse(
  await readFile(new URL('../../catalog.json', import.meta.url))
);

function otherFirst(reader, otherId, lists) {
  return {
    ...reader,
    send: async (method, params, session) => {
      const start = reader.events.length;
      const out = await reader.send(method, params, session);
      if (method === 'Runtime.enable') {
        const added = reader.events.slice(start);
        const contexts = added.filter(
          (event) =>
            event.sessionId === session && event.method === 'Runtime.executionContextCreated'
        );
        const order = [...contexts].sort(
          (a, b) =>
            Number(b.params.context.origin === `chrome-extension://${otherId}`) -
            Number(a.params.context.origin === `chrome-extension://${otherId}`)
        );
        let index = 0;
        reader.events.splice(
          start,
          added.length,
          ...added.map((event) => (contexts.includes(event) ? order[index++] : event))
        );
        lists.push(order.map((event) => event.params.context.origin));
      }
      return out;
    },
  };
}

test('all C9 rows select the harness world when another real content-script world appears first', {
  timeout: 120000,
}, async () => {
  assert.equal(DEFAULT_EXTENSION_WORLD_ID, EXTENSION_ID);
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const lists = [];
  const { id } = await browser.unguarded.send('Extensions.loadUnpacked', {
    path: fileURLToPath(new URL('./fixtures/other-extension/', import.meta.url)),
  });
  const guard = emulatedGuard(browser, { protectedOrigins });
  try {
    for (const extensionWorldId of [undefined, EXTENSION_ID]) {
      const execution = await run(
        {
          ...set,
          vectors: set.vectors.filter((vector) => vector.id.startsWith('C9.')),
          variants: { prompt: 0 },
        },
        {
          client: guard.client,
          unguarded: otherFirst(browser.unguarded, id, lists),
          fixture,
          targets: origins(fixture),
          capabilities: { extensionWorld: true },
          extensionWorldId,
          rowTimeoutMs: 30000,
        }
      );
      assert.equal(execution.results.length, 4);
      for (const row of execution.results) {
        assert.equal(row.control, 'pass', JSON.stringify(row));
        assert.equal(row.guarded, 'pass', JSON.stringify(row));
        assert.equal(row.live, 'pass', JSON.stringify(row));
      }
    }
    const wrong = await run(
      {
        ...set,
        vectors: set.vectors.filter((vector) => vector.id === 'C9.world-select'),
        variants: { prompt: 0 },
      },
      {
        client: guard.client,
        unguarded: otherFirst(browser.unguarded, id, lists),
        fixture,
        targets: origins(fixture),
        capabilities: { extensionWorld: true },
        extensionWorldId: id,
        rowTimeoutMs: 30000,
      }
    );
    assert.equal(wrong.results[0].control, 'fail', JSON.stringify(wrong.results));
    assert.equal(lists.length, 27);
    for (const list of lists) {
      assert.equal(list[0], `chrome-extension://${id}`, JSON.stringify(list));
      assert(list.includes(`chrome-extension://${EXTENSION_ID}`), JSON.stringify(list));
    }
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});
