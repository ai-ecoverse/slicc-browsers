import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const capabilities = { autoAttach: true, browserSession: true, browserContexts: true };
const { protectedOrigins } = JSON.parse(
  await readFile(new URL('../../catalog.json', import.meta.url))
);

async function row(id, options) {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    const targets = origins(fixture);
    const guard = emulatedGuard(browser, {
      protectedHosts: [new URL(targets.seven).host],
      protectedOrigins: {
        ...protectedOrigins,
        domains: [],
        hosts: [new URL(targets.seven).hostname],
      },
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

test('catalog adoption preserves C1-C5 blocks, including chrome-error block evidence', {
  timeout: 300000,
}, async () => {
  const ids = [
    'C1.href',
    'C2.302',
    'C3.popup-self-nav',
    'C4.iframe',
    'C4.static-cross-site',
    'C4.static-same-site',
    'C4.script-same-site',
    'C5.document',
  ];
  const vectors = data.vectors
    .filter((vector) => ids.includes(vector.id))
    .map((vector) => ({ ...vector, targets: ['seven'] }));
  assert.equal(vectors.length, ids.length);
  const fixture = await fixtureServer();
  try {
    for (const { vector, guarded } of vectors.flatMap((vector) =>
      [false, true].map((guarded) => ({ vector, guarded }))
    )) {
      const browser = await launch(fixture);
      const targets = origins(fixture);
      const guard = guarded
        ? emulatedGuard(browser, {
            protectedHosts: [new URL(targets.seven).host],
            protectedOrigins: {
              ...protectedOrigins,
              domains: [],
              hosts: [new URL(targets.seven).hostname],
            },
          })
        : undefined;
      const client = guard?.client ?? browser.client;
      try {
        const execution = await run(
          { ...data, vectors: [vector], variants: { prompt: 0 } },
          { client, unguarded: browser.unguarded, targets, fixture, capabilities }
        );
        assert.equal(execution.results.length, 1);
        for (const result of execution.results) {
          assert.equal(result.control, 'pass', JSON.stringify(result));
          assert.equal(result.guarded, guarded ? 'pass' : 'fail', JSON.stringify(result));
          if (guarded) assert.equal(result.live, 'pass', JSON.stringify(result));
        }
      } finally {
        await guard?.stop();
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
});

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

for (const id of ['C4.static-same-site', 'C4.script-same-site']) {
  test(`${id}: a same-site iframe in its own process is the error frame through the observer`, async () => {
    passes(await row(id, { refuseFrameAttach: true }));
  });
}
