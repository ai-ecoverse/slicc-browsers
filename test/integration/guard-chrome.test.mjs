import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const capabilities = { autoAttach: true, browserSession: true, browserContexts: true };
const privileged = (url) =>
  /^(view-source:)?(chrome|chrome-untrusted|chrome-extension|devtools|file):/i.test(
    String(url ?? '')
  );

test('a guard that keeps Chrome privileged UI out passes the C8 rows, and no guard fails them', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    const { targetInfos } = await browser.unguarded.send('Target.getTargets');
    const ui = new Set(
      targetInfos.filter((info) => info.type === 'browser_ui').map((info) => info.targetId)
    );
    assert.ok(ui.size > 0, 'this Chrome has no browser_ui target');
    const guard = emulatedGuard(browser, {
      protectedHosts: [new URL(origins(fixture).seven).host],
      refuse: (method, params) =>
        ((method === 'Page.navigate' || method === 'Target.createTarget') &&
          privileged(params.url)) ||
        (method === 'Target.attachToTarget' && ui.has(params.targetId)),
      hideTypes: ['browser_ui'],
    });
    const vectors = data.vectors.filter((v) => v.id.startsWith('C8.'));
    assert.equal(vectors.length, 5);
    const rows = async (client) =>
      (
        await run(
          { ...data, vectors, variants: { prompt: 0 } },
          { client, unguarded: browser.unguarded, targets: origins(fixture), fixture, capabilities }
        )
      ).results;
    try {
      for (const row of await rows(guard.client)) {
        assert.equal(row.control, 'pass', JSON.stringify(row));
        assert.equal(row.guarded, 'pass', JSON.stringify(row));
        assert.equal(row.live, 'pass', JSON.stringify(row));
      }
    } finally {
      await guard.stop();
    }
    for (const row of await rows(browser.client)) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'fail', JSON.stringify(row));
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});
