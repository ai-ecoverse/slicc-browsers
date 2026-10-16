import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const capabilities = { autoAttach: true, browserSession: true, browserContexts: true };

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
      return execution.results[0];
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

test('a guard that refuses Network.clearBrowserCookies on both legs passes C6.clear-cookies', async () => {
  passes(
    await row('C6.clear-cookies', {
      refuse: (method) => method === 'Network.clearBrowserCookies',
      ownContextsOnly: true,
    })
  );
});

test('a blocked cross-site iframe is live through its out-of-process chrome-error target', async () => {
  passes(await row('C4.iframe', {}));
});

test('a guard that replaces the error page proves the block through navigation history', async () => {
  passes(await row('C1.href', { replaceWith: 'about:blank#blocked' }));
});

test('a proven block without a detach satisfies detached', async () => {
  passes(await row('C5.document', {}));
});

test('a cross-site iframe the client cannot attach to is the error frame', async () => {
  passes(await row('C4.static-cross-site', { refuseFrameAttach: true }));
});
