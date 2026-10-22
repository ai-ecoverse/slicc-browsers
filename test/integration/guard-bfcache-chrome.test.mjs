import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { connect, launch, origins } from './cdp-client.mjs';

async function gatedClient(endpoint, seed = () => []) {
  let gate;
  const calls = [];
  const sessions = new Map();
  const raw = await connect(endpoint, {
    inbound(message, deliver, sessionId) {
      if (!gate || sessionId !== gate.sessionId) return deliver();
      gate.held.push(deliver);
      if (
        message.method === 'Page.frameNavigated' &&
        message.params?.type === 'BackForwardCacheRestore'
      ) {
        gate.count++;
        gate.first ??= Date.now();
      }
    },
    outbound(call) {
      calls.push(call);
    },
  });
  const client = {
    ...raw,
    async send(method, params, sessionId) {
      const answer = await raw.send(method, params, sessionId);
      if (method === 'Target.attachToTarget') sessions.set(answer.sessionId, params.targetId);
      return answer;
    },
    commits(targetId) {
      return raw.events.filter(
        (event) =>
          sessions.get(event.sessionId) === targetId && event.method === 'Page.frameNavigated'
      );
    },
    arm({ targetId, sessionId, ms }) {
      const commits = [...client.commits(targetId), ...seed(targetId)];
      gate = { sessionId, held: [], count: 0 };
      return {
        targetId,
        sessionId,
        ms,
        gate: true,
        protectedObserved: commits.some((event) =>
          new URL(event.params.frame.url).hostname.endsWith('sliccy.ai')
        ),
        ordinaryObserved: commits.some((event) =>
          new URL(event.params.frame.url).searchParams.get('n')?.endsWith('-b')
        ),
        audit({ probes }) {
          return {
            complete: true,
            probes: probes.map((probe) => ({
              id: probe.id,
              forwarded: calls.some(
                (call) =>
                  call.sessionId === sessionId &&
                  call.method === probe.method &&
                  call.sentAt >= probe.sentAt &&
                  JSON.stringify(call.params) === JSON.stringify(probe.params)
              ),
            })),
          };
        },
        release() {
          const held = gate;
          gate = undefined;
          for (const deliver of held.held) deliver();
          return { delayedEvents: held.count, firstDelayedAt: held.first, releasedAt: Date.now() };
        },
      };
    },
  };
  client.inboundDelay = ({ client: stream, ...options }) => stream.arm(options);
  return client;
}

test('history restore controls run through an inbound gate', { timeout: 180000 }, async () => {
  const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
  const selected = {
    ...set,
    vectors: set.vectors.filter((vector) => vector.id.startsWith('C8.protected-bfcache-restore')),
    variants: { prompt: 0 },
  };
  assert.equal(selected.vectors.length, 2);
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    const execution = await run(selected, {
      clientFactory: async () => {
        const unguarded = await gatedClient(browser.ws);
        const client = await gatedClient(browser.ws, (targetId) => unguarded.commits(targetId));
        return {
          client,
          unguarded,
          close: () => {
            client.close();
            unguarded.close();
          },
        };
      },
      targets: origins(fixture),
      fixture,
      capabilities: { inboundDelay: true, forwardAudit: true },
    });
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'fail', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.equal(row.observations.guarded.commandsUnforwarded, false);
      assert.equal(row.observations.guarded.sideEffectAbsent, false);
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});
