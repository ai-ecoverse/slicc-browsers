import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { connect, launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const capabilities = { autoAttach: true, browserSession: true, browserContexts: true };
const { protectedOrigins } = JSON.parse(
  await readFile(new URL('../../catalog.json', import.meta.url))
);
const ids = data.vectors
  .map(({ id }) => id)
  .filter((id) =>
    ['C1.script-nav', 'C1.href', 'C1.replace', 'C5.document', 'C5.fulfill'].includes(id)
  );

async function hold(ws, ms) {
  const holder = await connect(ws);
  const sessions = new Set();
  const held = [];
  let stopped = false;
  const pump = (async () => {
    let seen = 0;
    while (!stopped) {
      for (; seen < holder.events.length; seen++) {
        const event = holder.events[seen];
        if (event.method === 'Target.attachedToTarget' && event.params.targetInfo.type === 'page') {
          const { sessionId } = event.params;
          sessions.add(sessionId);
          holder
            .send(
              'Fetch.enable',
              { patterns: [{ urlPattern: '*step=pre*', requestStage: 'Request' }] },
              sessionId
            )
            .catch(() => {})
            .finally(() =>
              holder.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
            );
        }
        if (event.method === 'Fetch.requestPaused') {
          held.push(event.params.request.url);
          const { requestId } = event.params;
          setTimeout(() => {
            holder.send('Fetch.continueRequest', { requestId }, event.sessionId).catch(() => {});
          }, ms);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  await holder.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  return {
    held,
    stop: async () => {
      stopped = true;
      await pump;
      for (const sessionId of sessions)
        await holder.send('Fetch.disable', {}, sessionId).catch(() => {});
      holder.close();
    },
  };
}

async function rows({ guarded, ms, only = ids }) {
  const fixture = await fixtureServer();
  try {
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
    const holder = await hold(browser.ws, ms);
    try {
      const vectors = data.vectors
        .filter((vector) => only.includes(vector.id))
        .map((vector) => ({ ...vector, targets: ['seven'] }));
      assert.equal(vectors.length, only.length);
      const { results } = await run(
        { ...data, vectors, variants: { prompt: 0 } },
        {
          client: guard?.client ?? browser.client,
          unguarded: browser.unguarded,
          targets,
          fixture,
          capabilities,
        }
      );
      assert(holder.held.length > 0, 'no pre beacon was held');
      return results;
    } finally {
      await holder.stop();
      await guard?.stop();
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
}

test('a pre beacon held on the runner session still passes the guarded rows', {
  timeout: 300000,
}, async () => {
  const results = await rows({ guarded: true, ms: 2500 });
  assert.deepEqual(
    results.map(({ id, control, guarded, live, why, errors }) => ({
      id,
      control,
      guarded,
      live,
      why,
      errors,
    })),
    ids.map((id) => ({
      id,
      control: 'pass',
      guarded: 'pass',
      live: 'pass',
      why: undefined,
      errors: [],
    }))
  );
});

test('a plain client still fails the guarded rows with a held pre beacon', {
  timeout: 300000,
}, async () => {
  const results = await rows({ guarded: false, ms: 2500 });
  assert.deepEqual(
    results.map(({ id, control, guarded }) => ({ id, control, guarded })),
    ids.map((id) => ({ id, control: 'pass', guarded: 'fail' }))
  );
});

test('a pre beacon that never arrives leaves the guarded rows not live, never a false detached', {
  timeout: 300000,
}, async () => {
  const results = await rows({ guarded: true, ms: 12000, only: ['C1.script-nav', 'C5.document'] });
  for (const result of results) {
    assert.equal(result.live, 'fail', JSON.stringify(result));
    assert.match(result.why, /not live: pre beacon not observed for /, JSON.stringify(result));
    assert.doesNotMatch(result.why, /detached: got/, JSON.stringify(result));
  }
  assert.deepEqual(
    results.map(({ guarded }) => guarded),
    ['pass', 'pass']
  );
});
