import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const rows = ['C2.through-302', 'C2.through-307'];
const origins = {
  ordinary: 'http://ordinary.example.test',
  client: 'http://client.example.test',
  log: 'http://log.example.test',
  seven: 'https://seven.sliccy.ai',
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const protectedURL = (url) => new URL(url).hostname.endsWith('.sliccy.ai');
const protectedChain = (url) =>
  new URL(url).pathname === '/hop' && decodeURIComponent(url).includes('.sliccy.ai');
const ordinaryHop = (url) =>
  new URL(url).origin === origins.ordinary && new URL(url).pathname === '/hop';

function refusingGuard({ cut = () => false, delay = () => 0, skip = () => false } = {}) {
  const log = [];
  const targets = new Map();
  const sessions = new Map();
  let next = 0;
  const emit = (target, method, params) => {
    for (const [sessionId, entry] of sessions)
      if (entry.target === target)
        entry.transport.events.push({ method, params: structuredClone(params), sessionId });
  };
  const commit = (target, loaderId, url, unreachableUrl) => {
    target.history.push(unreachableUrl ?? url);
    target.url = url;
    target.unreachable = unreachableUrl;
    emit(target, 'Page.frameNavigated', {
      frame: { id: target.frame, loaderId, url, ...(unreachableUrl ? { unreachableUrl } : {}) },
    });
    emit(target, 'Page.loadEventFired', {});
  };
  const go = async (target, url, loaderId = `L${++next}`) => {
    let at = url;
    for (;;) {
      await sleep(delay(at));
      if (cut(at)) {
        const requestId = `R${++next}`;
        emit(target, 'Network.requestWillBeSent', {
          requestId,
          loaderId,
          frameId: target.frame,
          type: 'Document',
          request: { url: at },
        });
        emit(target, 'Network.loadingFailed', {
          requestId,
          type: 'Document',
          errorText: 'net::ERR_BLOCKED_BY_CLIENT',
          blockedReason: 'inspector',
        });
        commit(target, loaderId, 'chrome-error://chromewebdata/', at);
        return;
      }
      if (!skip(at)) log.push({ url: at, headers: {} });
      const parsed = new URL(at);
      if (parsed.pathname !== '/hop') break;
      at = parsed.searchParams.get('to');
    }
    commit(target, loaderId, at);
  };
  const make = (guard) => {
    const transport = { events: [], messages: [] };
    transport.send = async (method, params = {}, sessionId) => {
      await sleep(1);
      const target = sessions.get(sessionId)?.target;
      if (guard && method === 'Page.addScriptToEvaluateOnNewDocument')
        throw new Error('slicc: refused: init scripts');
      if (method === 'Target.createTarget') {
        const id = `T${++next}`;
        targets.set(id, { id, frame: `F${id}`, url: params.url, history: [params.url] });
        return { targetId: id };
      }
      if (method === 'Target.attachToTarget') {
        const id = `S${++next}`;
        sessions.set(id, { target: targets.get(params.targetId), transport });
        return { sessionId: id };
      }
      if (method === 'Target.detachFromTarget') {
        sessions.delete(params.sessionId);
        return {};
      }
      if (method === 'Target.getTargetInfo') {
        const entry = targets.get(params.targetId);
        return { targetInfo: { targetId: entry.id, type: 'page', url: entry.url, attached: true } };
      }
      if (method === 'Target.getTargets')
        return {
          targetInfos: [...targets.values()].map((entry) => ({
            targetId: entry.id,
            type: 'page',
            url: entry.url,
          })),
        };
      if (method === 'Page.navigate') {
        const loaderId = `L${++next}`;
        await go(target, params.url, loaderId);
        return { frameId: target.frame, loaderId };
      }
      if (method === 'Page.getFrameTree')
        return {
          frameTree: {
            frame: {
              id: target.frame,
              loaderId: 'L',
              url: target.url,
              ...(target.unreachable ? { unreachableUrl: target.unreachable } : {}),
            },
          },
        };
      if (method === 'Page.getNavigationHistory')
        return {
          currentIndex: target.history.length - 1,
          entries: target.history.map((url, id) => ({ id, url })),
        };
      if (method === 'Runtime.evaluate') {
        const pre = /sendBeacon\(("[^"]*") \+ encodeURIComponent\(("[^"]*")\)\)/.exec(
          params.expression
        );
        if (pre) log.push({ url: JSON.parse(pre[1]) + encodeURIComponent(JSON.parse(pre[2])) });
        const href = /location\.href=("[^"]*")/.exec(params.expression);
        if (href) setTimeout(() => go(target, JSON.parse(href[1])), 5);
        return { result: { type: 'string', value: href ? JSON.parse(href[1]) : 'complete' } };
      }
      return {};
    };
    transport.waitEvent = () => new Promise(() => {});
    return transport;
  };
  return { client: make(true), unguarded: make(false), fixture: { log: async () => log } };
}

async function measure(vector, guard) {
  const execution = await run(
    { ...set, vectors: [{ ...vector, targets: ['seven'] }], variants: { prompt: 0 } },
    {
      client: guard.client,
      unguarded: guard.unguarded,
      fixture: guard.fixture,
      targets: origins,
      settleScale: 0.05,
    }
  );
  assert.equal(execution.results.length, 1);
  return { row: execution.results[0], summary: execution.summary() };
}

const published = (id) => set.vectors.find((entry) => entry.id === id);

const controlMeasured = (row) => {
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.observations.control['refused.3'], true);
  assert.equal(row.observations.control.chainStarted, true);
  assert.equal(row.observations.control.protectedHop, true);
  assert.equal(row.observations.control.landed, true);
  for (const name of ['allowedBeacon', 'afterBeacon', 'detached'])
    assert.equal(Object.hasOwn(row.observations.control, name), false, name);
};

for (const id of rows) {
  test(`${id}: a guard that refuses addScript and lets the chain through the protected hop fails`, async () => {
    const { row } = await measure(published(id), refusingGuard());
    controlMeasured(row);
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.observations.guarded['refused.3'], true);
    assert.equal(row.observations.guarded.chainStarted, true);
    assert.equal(row.observations.guarded.protectedHop, true);
    assert.equal(row.observations.guarded.landed, true);
    assert.deepEqual(row.errors, []);
  });

  test(`${id}: the trigger settle waits for a late arrival when addScript is refused, so a late leak still fails`, async () => {
    const { row } = await measure(
      published(id),
      refusingGuard({ delay: (url) => (protectedURL(url) ? 700 : 0) })
    );
    controlMeasured(row);
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.observations.guarded.protectedHop, true);
    assert.equal(row.observations.guarded.landed, true);
    assert.deepEqual(row.errors, []);
  });

  test(`${id}: a guard that refuses addScript and cuts the chain at the protected hop passes`, async () => {
    const { row } = await measure(published(id), refusingGuard({ cut: protectedURL }));
    controlMeasured(row);
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.observations.guarded['refused.3'], true);
    assert.equal(row.observations.guarded.chainStarted, true);
    assert.equal(row.observations.guarded.protectedHop, false);
    assert.equal(row.observations.guarded.landed, false);
    assert.equal(row.incomplete, undefined);
    assert.deepEqual(row.errors, []);
  });

  test(`${id}: a guard that refuses addScript and never starts the chain is incomplete, never a pass`, async () => {
    const { row, summary } = await measure(published(id), refusingGuard({ cut: protectedChain }));
    controlMeasured(row);
    assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
    assert.equal(row.observations.guarded.chainStarted, 'incomplete');
    assert.equal(row.observations.guarded.protectedHop, false);
    assert.equal(row.observations.guarded.landed, false);
    assert.deepEqual(row.incomplete, ['guarded chainStarted: first hop not observed']);
    assert.deepEqual(row.errors, []);
    assert.equal(summary.pass, false);
  });

  test(`${id}: a control whose chain never starts is incomplete, not a failed control`, async () => {
    const { row, summary } = await measure(published(id), refusingGuard({ cut: ordinaryHop }));
    assert.equal(row.control, 'incomplete', JSON.stringify(row));
    assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
    for (const name of ['chainStarted', 'protectedHop', 'landed'])
      assert.equal(row.observations.control[name], 'incomplete', name);
    assert.deepEqual(row.incomplete, [
      'control chainStarted: first hop not observed',
      'guarded chainStarted: first hop not observed',
    ]);
    assert.deepEqual(row.errors, []);
    assert.equal(summary.pass, false);
  });

  test(`${id}: a guard that skips the first hop but serves the protected hop still fails`, async () => {
    const { row } = await measure(
      published(id),
      refusingGuard({ skip: (url) => ordinaryHop(url) && protectedChain(url) })
    );
    controlMeasured(row);
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.observations.guarded.chainStarted, 'incomplete');
    assert.equal(row.observations.guarded.protectedHop, true);
    assert.equal(row.observations.guarded.landed, true);
    assert.deepEqual(row.errors, []);
  });

  test(`${id}: a control on which every observation is excused by a refusal measured nothing and is incomplete`, async () => {
    const vector = structuredClone(published(id));
    for (const observation of Object.values(vector.observe))
      observation.dependsOn = [...new Set([...(observation.dependsOn ?? []), 'refused.3'])];
    const { row, summary } = await measure(vector, refusingGuard());
    assert.equal(row.control, 'incomplete', JSON.stringify(row));
    assert.deepEqual(row.observations.control, { 'refused.3': true, 'refused.4': false });
    assert.deepEqual(row.incomplete, ['control measured nothing']);
    assert.deepEqual(row.errors, []);
    assert.equal(summary.pass, false);
  });
}
