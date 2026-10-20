import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const vector = set.vectors.find((item) => item.id === 'C9.world-debugger');
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  chromeUrlsAttach: true,
  extensionWorld: true,
};

function lagging(client, ms) {
  const arrived = new Map();
  const visible = (event) => {
    if (event.method !== 'Debugger.paused') return true;
    if (!arrived.has(event)) arrived.set(event, Date.now());
    return Date.now() - arrived.get(event) >= ms;
  };
  return {
    send: client.send,
    waitEvent: client.waitEvent,
    close: client.close,
    get events() {
      return client.events.filter(visible);
    },
  };
}

async function row(ms, settleScale) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const guard = emulatedGuard(browser, { protectedOrigins: catalog.protectedOrigins });
  try {
    const execution = await run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: lagging(browser.unguarded, ms),
        fixture,
        targets: origins(fixture),
        capabilities,
        settleScale,
        rowTimeoutMs: 60000,
      }
    );
    return execution.results[0];
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
}

test('a control Debugger.paused 2.5 s late still reaches the foreign world', {
  timeout: 120000,
}, async () => {
  const result = await row(2500);
  assert.equal(result.control, 'pass', JSON.stringify(result));
  assert.equal(result.guarded, 'pass', JSON.stringify(result));
  assert.equal(result.live, 'pass', JSON.stringify(result));
});

test('a control that never pauses within the scaled bound is incomplete, not unreachable', {
  timeout: 120000,
}, async () => {
  const result = await row(60000, 0.2);
  assert.equal(result.control, 'fail', JSON.stringify(result));
  assert.equal(result.observations.control.reachable, 'incomplete', JSON.stringify(result));
  assert.match(result.why, /control reachable: got "incomplete", want true/);
  assert(
    result.errors.includes('extensionWorld debugger: no Debugger.paused within 1000ms'),
    JSON.stringify(result.errors)
  );
});
