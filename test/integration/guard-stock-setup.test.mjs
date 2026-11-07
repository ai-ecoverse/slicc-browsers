import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const ids = [
  'E7.init-script',
  'E7.emulation',
  'E7.binding',
  'C3.tab-attach',
  'C3.tab-create',
  'C3.tab-attach.synthetic',
  'C3.tab-create.synthetic',
];
const vectors = set.vectors.filter((vector) => ids.includes(vector.id));
const stock = new Set([
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Emulation.setFocusEmulationEnabled',
  'Emulation.setEmulatedMedia',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled',
  'Runtime.addBinding',
  'Page.createIsolatedWorld',
  'Target.setAutoAttach',
]);
const base = { autoAttach: true, browserSession: true, browserContexts: true };
const declared = { ...base, stockSetup: true, syntheticAutoAttach: true };

async function execute(mode, capabilities) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const guard =
    mode === 'none'
      ? { client: browser.client, stop: async () => {} }
      : emulatedGuard(
          browser,
          mode === 'refuse'
            ? { refuse: (method) => stock.has(method) }
            : { swallow: (method) => stock.has(method) }
        );
  try {
    return await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities,
        rowTimeoutMs: 60000,
      }
    );
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
}

test('the stock-setup rows are the positive rows the vectors publish', () => {
  assert.deepEqual(vectors.map((vector) => vector.id).sort(), [...ids].sort());
  for (const vector of vectors) {
    assert.deepEqual(vector.targets, ['ordinary']);
    assert.equal(vector.control.via, 'unguarded');
    assert.ok(
      vector.requires.includes(
        vector.id.endsWith('.synthetic') ? 'syntheticAutoAttach' : 'stockSetup'
      )
    );
    assert.deepEqual(vector.expected, vector.control.expected);
  }
});

test('without a guard every stock-setup row passes', { timeout: 600000 }, async () => {
  const execution = await execute('none', declared);
  for (const row of execution.results)
    assert.deepEqual(
      [row.control, row.guarded, row.live],
      ['pass', 'pass', 'pass'],
      JSON.stringify(row)
    );
  assert.match(execution.summary({ guard: 'none' }).line, /^GUARD-PASS /);
});

for (const mode of ['refuse', 'swallow'])
  test(`a guard that ${mode === 'refuse' ? 'refuses' : 'answers without forwarding'} the stock setup calls fails every positive row`, {
    timeout: 600000,
  }, async () => {
    const execution = await execute(mode, declared);
    assert.equal(execution.results.length, ids.length);
    for (const row of execution.results) assert.equal(row.guarded, 'fail', JSON.stringify(row));
    const summary = execution.summary({ guard: mode });
    assert.equal(summary.pass, false);
    assert.match(summary.line, /^GUARD-FAIL /);
  });

test('a guard that declares neither capability skips every row, never passes it', async () => {
  const client = { events: [], send: async () => assert.fail('a skipped row sent CDP') };
  const fixture = await fixtureServer();
  try {
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      { client, unguarded: client, fixture, targets: origins(fixture), capabilities: base }
    );
    for (const row of execution.results) {
      assert.deepEqual([row.control, row.guarded, row.live], ['skip', 'skip', 'skip']);
      assert.equal(
        row.reason,
        row.id.endsWith('.synthetic')
          ? 'not-supported:syntheticAutoAttach'
          : 'not-supported:stockSetup'
      );
    }
    const summary = execution.summary({ guard: 'old' });
    assert.deepEqual(summary.forged, []);
    assert.equal(summary.counts.guarded.pass, 0);
    assert.equal(summary.counts.guarded.skip, ids.length);
    assert.match(
      summary.line,
      / skips 7 \(not-supported:stockSetup=5, not-supported:syntheticAutoAttach=2\)$/
    );
  } finally {
    await fixture.close();
  }
});
