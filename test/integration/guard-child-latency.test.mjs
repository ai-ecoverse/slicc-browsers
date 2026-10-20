import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { parseURL } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const latencyMs = 300;

function slowChildGuard(client, unguarded, protectedHosts) {
  const children = new Set();
  const closed = new Set();
  const guards = new Map();
  let cursor = 0;
  let guardCursor = 0;
  let stopped = false;
  const shield = async (event) => {
    const child = event.params.sessionId;
    children.add(child);
    const targetId = event.params.targetInfo.targetId;
    const { sessionId } = await unguarded.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    guards.set(sessionId, { child, targetId });
    await unguarded.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] },
      sessionId
    );
    await unguarded.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  };
  const decide = async (event) => {
    const guard = guards.get(event.sessionId);
    if (!guard) return;
    const { requestId, request } = event.params;
    if (protectedHosts.includes(parseURL(request.url)?.host)) {
      closed.add(guard.child);
      await unguarded
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId)
        .catch(() => undefined);
      await unguarded
        .send('Target.closeTarget', { targetId: guard.targetId })
        .catch(() => undefined);
      return;
    }
    await unguarded
      .send('Fetch.continueRequest', { requestId }, event.sessionId)
      .catch(() => undefined);
  };
  const watch = (async () => {
    while (!stopped) {
      for (const event of client.events.slice(cursor)) {
        cursor++;
        if (event.method === 'Target.attachedToTarget' && event.params.waitingForDebugger)
          await shield(event).catch(() => undefined);
      }
      for (const event of unguarded.events.slice(guardCursor)) {
        guardCursor++;
        if (event.method === 'Fetch.requestPaused') await decide(event);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    client: {
      ...client,
      send: async (method, params, sessionId) => {
        if (sessionId && children.has(sessionId) && method.startsWith('Page.')) {
          await new Promise((resolve) => setTimeout(resolve, latencyMs));
          if (closed.has(sessionId)) throw new Error("slicc: refused: target is on seven's origin");
        }
        return client.send(method, params, sessionId);
      },
    },
    stop: async () => {
      stopped = true;
      await watch;
    },
  };
}

test('slow popup steps finish before the trigger, so a guard closing the popup refuses nothing', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    const targets = origins(fixture);
    const guard = slowChildGuard(browser.client, browser.unguarded, [new URL(targets.seven).host]);
    try {
      const vector = {
        ...data.vectors.find((v) => v.id === 'C3.popup-self-nav'),
        targets: ['seven'],
      };
      const execution = await run(
        { ...data, vectors: [vector], variants: { prompt: 0 } },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          targets,
          fixture,
          capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
        }
      );
      const row = execution.results[0];
      assert.doesNotMatch(
        row.why ?? '',
        /refused only on the protected target/,
        JSON.stringify(row)
      );
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
    } finally {
      await guard.stop();
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
});
