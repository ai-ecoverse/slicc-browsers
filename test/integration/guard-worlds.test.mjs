import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const vectors = set.vectors.filter((vector) => vector.id.startsWith('C9.'));
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  chromeUrlsAttach: true,
  extensionWorld: true,
};

test('C9 skips transports without a foreign extension world before sending commands', async () => {
  const fixture = await fixtureServer();
  try {
    const client = { events: [], send: async () => assert.fail('unsupported transport sent CDP') };
    for (const declared of [{}, [], { extensionWorld: false }]) {
      const execution = await run(
        { ...set, vectors, variants: { prompt: 0 } },
        { client, unguarded: client, fixture, targets: origins(fixture), capabilities: declared }
      );
      assert.equal(execution.results.length, 4);
      for (const row of execution.results) {
        assert.equal(row.control, 'skip');
        assert.equal(row.guarded, 'skip');
        assert.equal(row.reason, 'not-supported:extensionWorld');
      }
    }
  } finally {
    await fixture.close();
  }
});

test('C9 through run: catalog guard isolates worlds, plain and cutting guards fail', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    for (const mode of ['catalog', 'plain', 'cutting', '1.8.5']) {
      const guard =
        mode === 'plain'
          ? { client: browser.client, stop: async () => {} }
          : emulatedGuard(browser, {
              protectedOrigins: catalog.protectedOrigins,
              cutExtensionWorlds: mode === 'cutting',
              exposeExtensionWorlds: mode === '1.8.5',
            });
      try {
        const execution = await run(
          { ...set, vectors, variants: { prompt: 0 } },
          {
            client: guard.client,
            unguarded: browser.unguarded,
            fixture,
            targets: origins(fixture),
            capabilities,
            rowTimeoutMs: 30000,
          }
        );
        assert.equal(execution.summary().pass, mode === 'catalog');
        assert.match(
          execution.summary({ guard: 'emulator', sha: mode }).line,
          mode === 'catalog' ? /^GUARD-PASS / : /^GUARD-FAIL /
        );
        for (const row of execution.results) {
          assert.equal(row.control, 'pass', JSON.stringify({ mode, row }));
          const expected =
            mode === 'catalog' || (row.id === 'C9.page-drivable' && mode !== 'cutting')
              ? 'pass'
              : 'fail';
          assert.equal(row.guarded, expected, JSON.stringify({ mode, row }));
          if (expected === 'pass') assert.equal(row.live, 'pass', JSON.stringify({ mode, row }));
        }
      } finally {
        await guard.stop();
      }
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('seven protection rows remain passing with the content-script extension present', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  const ids = [
    'C1.href',
    'C2.302',
    'C3.popup-self-nav',
    'C4.static-same-site',
    'C4.static-cross-site',
    'C4.script-same-site',
    'C5.document',
  ];
  const seven = set.vectors.filter((vector) => ids.includes(vector.id));
  assert.equal(seven.length, 7);
  try {
    for (const vector of seven) {
      const browser = await launch(fixture);
      const guard = emulatedGuard(browser, {
        protectedHosts: [new URL(origins(fixture).seven).host],
        protectedOrigins: {
          ...catalog.protectedOrigins,
          domains: [],
          hosts: [new URL(origins(fixture).seven).hostname],
        },
      });
      try {
        const execution = await run(
          {
            ...set,
            vectors: [{ ...vector, defaultContext: true, targets: ['seven'] }],
            variants: { prompt: 0 },
          },
          {
            client: guard.client,
            unguarded: browser.unguarded,
            fixture,
            targets: origins(fixture),
            capabilities,
            rowTimeoutMs: 30000,
          }
        );
        for (const row of execution.results) {
          assert.equal(row.control, 'pass', JSON.stringify(row));
          assert.equal(row.guarded, 'pass', JSON.stringify(row));
          assert.equal(row.live, 'pass', JSON.stringify(row));
        }
      } finally {
        await guard.stop();
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
});
