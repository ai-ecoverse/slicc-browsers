import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { launch } from './cdp-client.mjs';
import { slowPopupRow } from './child-latency-guard.mjs';

test('slow popup steps finish before the trigger, so a guard closing the popup refuses nothing', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    try {
      await slowPopupRow(browser, fixture, 300);
    } finally {
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
});
