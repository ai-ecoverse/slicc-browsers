import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseURL } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { origins } from './cdp-client.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
export const vector = data.vectors.find((v) => v.id === 'C3.popup-self-nav');
export const settleMs = Math.max(...vector.setup.map((step) => step.settle?.ms ?? 0));
const childSteps = vector.setup.find((step) => step.children).children.length;
const refusal = "slicc: refused: target is on seven's origin";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function slowChildGuard(client, unguarded, protectedHosts, latencyMs) {
  const children = new Map();
  const guards = new Map();
  const work = new Set();
  const trail = [];
  const counts = { closed: 0, refused: 0, slowed: 0, late: 0 };
  let clock = 0;
  const mark = (what) => {
    clock++;
    if (trail.length < 120) trail.push(`${clock} ${what}`);
    return clock;
  };
  const track = (promise) => {
    const done = promise
      .catch((error) => mark(`error ${error.message}`))
      .finally(() => work.delete(done));
    work.add(done);
    return done;
  };
  const install = async (entry) => {
    const { sessionId } = await unguarded.send('Target.attachToTarget', {
      targetId: entry.targetId,
      flatten: true,
    });
    guards.set(sessionId, entry);
    await unguarded.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] },
      sessionId
    );
    mark(`guard ready ${entry.child}`);
    return sessionId;
  };
  const release = async (entry) => {
    const sessionId = await entry.ready;
    if (!(await entry.resumed)) return;
    await unguarded.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    mark(`guard resumed ${entry.child}`);
  };
  const attached = (event) => {
    if (event.method !== 'Target.attachedToTarget' || !event.params.waitingForDebugger) return;
    const entry = {
      child: event.params.sessionId,
      targetId: event.params.targetInfo.targetId,
      closedAt: undefined,
      done: [],
    };
    entry.resumed = new Promise((resolve) => {
      entry.resume = resolve;
    });
    children.set(entry.child, entry);
    mark(`attached ${entry.child} ${event.params.targetInfo.url}`);
    entry.ready = install(entry);
    track(entry.ready);
    track(release(entry));
  };
  const decide = async (event) => {
    const entry = guards.get(event.sessionId);
    if (!entry) return;
    const { requestId, request } = event.params;
    if (protectedHosts.includes(parseURL(request.url)?.host)) {
      entry.closedAt = mark(`close ${entry.child} on ${request.url}`);
      counts.closed++;
      counts.late += entry.done.filter((at) => at === undefined).length;
      await unguarded
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId)
        .catch(() => undefined);
      await unguarded
        .send('Target.closeTarget', { targetId: entry.targetId })
        .catch(() => undefined);
      return;
    }
    mark(`continue ${entry.child} ${request.url}`);
    await unguarded
      .send('Fetch.continueRequest', { requestId }, event.sessionId)
      .catch(() => undefined);
  };
  const paused = (event) => {
    if (event.method === 'Fetch.requestPaused') track(decide(event));
  };
  const slow = async (entry, method, params) => {
    const index = entry.done.push(undefined) - 1;
    await entry.ready.catch(() => undefined);
    await pause(latencyMs);
    counts.slowed++;
    try {
      if (entry.closedAt !== undefined) {
        counts.refused++;
        throw new Error(refusal);
      }
      return await client.send(method, params, entry.child);
    } finally {
      entry.done[index] = mark(`${method} ${entry.child}`);
    }
  };
  const stops = [client.listen(attached), unguarded.listen(paused)];
  return {
    client: {
      ...client,
      send: async (method, params, sessionId) => {
        const entry = sessionId ? children.get(sessionId) : undefined;
        if (entry && method.startsWith('Page.')) return slow(entry, method, params);
        if (!entry || method !== 'Runtime.runIfWaitingForDebugger')
          return client.send(method, params, sessionId);
        try {
          return await client.send(method, params, sessionId);
        } finally {
          mark(`runner resumed ${sessionId}`);
          entry.resume(true);
        }
      },
    },
    report: () => ({ ...counts, trail }),
    stop: async () => {
      for (const stop of stops) stop();
      for (const entry of children.values()) entry.resume(false);
      while (work.size) await Promise.all([...work]);
    },
  };
}

export async function slowPopupRow(browser, fixture, latencyMs) {
  const targets = origins(fixture);
  const guard = slowChildGuard(
    browser.client,
    browser.unguarded,
    [new URL(targets.seven).host],
    latencyMs
  );
  let execution;
  try {
    execution = await run(
      { ...data, vectors: [{ ...vector, targets: ['seven'] }], variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
      }
    );
  } finally {
    await guard.stop();
  }
  const row = execution.results[0];
  const report = guard.report();
  const beacons = (await fixture.log())
    .filter((entry) => parseURL(entry.url)?.pathname === '/beacon')
    .map((entry) => entry.url);
  const why = JSON.stringify({ row, report, beacons });
  assert.doesNotMatch(row.why ?? '', /refused only on the protected target/, why);
  assert.equal(row.control, 'pass', why);
  assert.equal(row.guarded, 'pass', why);
  assert.ok(report.closed >= 1, why);
  assert.equal(report.refused, 0, why);
  assert.equal(report.late, 0, why);
  assert.ok(report.slowed >= 2 * childSteps, why);
  return { row, report };
}
