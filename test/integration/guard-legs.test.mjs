import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const capabilities = { autoAttach: true, browserSession: true, browserContexts: true };
const scripts = (method) => /^Page\.(addScriptToEvaluateOnNewDocument|setBypassCSP)$/.test(method);

async function row(id, options) {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    const targets = origins(fixture);
    const guard = emulatedGuard(browser, {
      protectedHosts: [new URL(targets.seven).host],
      ...options,
    });
    try {
      const vector = { ...data.vectors.find((v) => v.id === id), targets: ['seven'] };
      const execution = await run(
        { ...data, vectors: [vector], variants: { prompt: 0 } },
        { client: guard.client, unguarded: browser.unguarded, targets, fixture, capabilities }
      );
      return { result: execution.results[0], ordinary: targets.ordinary };
    } finally {
      await guard.stop();
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
}

const passes = (result) => {
  assert.equal(result.control, 'pass', JSON.stringify(result));
  assert.equal(result.guarded, 'pass', JSON.stringify(result));
  assert.equal(result.live, 'pass', JSON.stringify(result));
};

for (const id of ['C3.popup-on-redirect-302', 'C3.popup-on-redirect-chain']) {
  test(`${id}: popup steps that ran only on the control are reported, not refused`, async () => {
    const { result } = await row(id, { refuse: scripts, hideOpened: true });
    passes(result);
    assert.deepEqual(result.ran, { 'refused.5': 'control-only', 'refused.6': 'control-only' });
  });
}

test('C4.script-cross-site: the same-site control frame beacon follows the page init script', async () => {
  const { result } = await row('C4.script-cross-site', {
    refuse: scripts,
    refuseFrameAttach: true,
  });
  passes(result);
  assert.equal(result.observations.control['refused.3'], true);
  assert.equal(result.observations.control.beacon, undefined);
});

test('C3.popup-self-nav: a settle on a refused init script is skipped and recorded', async () => {
  const { result, ordinary } = await row('C3.popup-self-nav', {
    refuse: scripts,
    refuseLatencyMs: 2000,
  });
  passes(result);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.notes, [
    `control settle:skipped-refused beacon ${ordinary}`,
    `guarded settle:skipped-refused beacon ${ordinary}`,
  ]);
});

test('C3.popup-self-nav: a settle whose beacon never arrives without a refusal still fails', async () => {
  const { result, ordinary } = await row('C3.popup-self-nav', {
    swallow: (method, _params, child) =>
      child && method === 'Page.addScriptToEvaluateOnNewDocument',
  });
  assert.equal(result.control, 'fail');
  assert.ok(
    result.errors.includes(`settle: no beacon from ${ordinary} within 5000ms`),
    JSON.stringify(result.errors)
  );
});
