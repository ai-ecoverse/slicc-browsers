import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { launch } from './cdp-client.mjs';
import { settleMs, slowPopupRow } from './child-latency-guard.mjs';

const repetitions = 3;
const latencyMs = settleMs + 1000;

test('popup steps each slower than the whole settle still finish before the trigger, run after run', async () => {
  assert.ok(latencyMs > settleMs);
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    try {
      for (let repetition = 0; repetition < repetitions; repetition++)
        await slowPopupRow(browser, fixture, latencyMs);
    } finally {
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
});
