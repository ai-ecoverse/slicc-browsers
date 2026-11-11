import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  debuggerCleanup,
  debuggerPaused,
  idleDebuggerCleanup,
  isRefusal,
  judge,
  outcome,
  refusalError,
  trustedClientOnly,
} from '../../guard-driver.mjs';
import {
  leftoverPersistentWorker,
  releasePersistentWorkerSessions,
  reusableAttachSession,
} from '../../guard-runner.mjs';
import { probeHarnessIncomplete, probeWorkerSessions } from '../../protected-worker.mjs';
import { withPausedSharedWorkerStall } from './guard-emulator.mjs';
import { drivable } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const byId = Object.fromEntries(set.vectors.map((vector) => [vector.id, vector]));

const ordinary = ['C3.tab-worker-leak', 'C3.tab-service-worker-leak'];
const protectedRows = [
  'C3.protected-worker-dedicated',
  'C3.protected-worker-shared',
  'C3.protected-service-worker',
  'C3.protected-worker-framed',
];
const kinds = {
  'C3.protected-worker-dedicated': {
    spawn: 'dedicated',
    type: 'worker',
    path: '/worker.js',
    reachable: 'either',
  },
  'C3.protected-worker-shared': {
    spawn: 'shared',
    type: 'shared_worker',
    path: '/shared-worker.js',
    reachable: true,
  },
  'C3.protected-service-worker': {
    spawn: 'service',
    type: 'service_worker',
    path: '/sw.js',
    secure: true,
    reachable: true,
  },
  'C3.protected-worker-framed': {
    spawn: 'dedicated',
    type: 'worker',
    path: '/worker.js',
    frame: '{ordinary}/doc?n=host-{tag}',
    reachable: 'either',
  },
};

const identityAny = (check, type, path) => {
  const arms = check?.any ?? [];
  assert.ok(
    arms.some((arm) => arm.where?.params?.targetInfo?.targetId === '{workerTarget}'),
    'targetId arm'
  );
  assert.ok(
    arms.some(
      (arm) =>
        arm.where?.params?.targetInfo?.type === type &&
        arm.where?.params?.targetInfo?.url === undefined
    ),
    'type arm'
  );
  assert.ok(
    arms.some(
      (arm) =>
        arm.where?.params?.targetInfo?.type === type &&
        arm.where?.params?.targetInfo?.url?.$contains === '{target}'
    ),
    'origin arm'
  );
  assert.ok(
    arms.some(
      (arm) =>
        arm.where?.params?.targetInfo?.type === type &&
        arm.where?.params?.targetInfo?.url?.$contains === path
    ),
    'url arm'
  );
};

const listedAny = (check, type, path) => {
  const arms = check?.any ?? [];
  assert.ok(
    arms.some((arm) => arm.equals?.$some?.targetId === '{workerTarget}'),
    'listed targetId'
  );
  assert.ok(
    arms.some((arm) => arm.equals?.$some?.type === type && arm.equals?.$some?.url === undefined),
    'listed type'
  );
  assert.ok(
    arms.some(
      (arm) => arm.equals?.$some?.type === type && arm.equals?.$some?.url?.$contains === '{target}'
    ),
    'listed origin'
  );
  assert.ok(
    arms.some(
      (arm) => arm.equals?.$some?.type === type && arm.equals?.$some?.url?.$contains === path
    ),
    'listed url'
  );
};

test('ordinary worker rows allow either attachment under a correct guard', () => {
  for (const id of ordinary) {
    const vector = byId[id];
    assert.ok(vector, id);
    assert.equal(vector.expected.workerAttached, 'either', id);
    assert.equal(vector.control.expected.workerAttached, true, id);
    assert.equal(vector.expected.workerExists, true, id);
    assert.equal(vector.control.expected.admitted, true, id);
    assert.ok((vector.designDependent ?? []).includes('workerAttached'), id);
    assert.equal(drivable.has(id), true, id);
  }
});

test('protected-origin worker rows are attack rows spawned by the unguarded observer', () => {
  for (const id of protectedRows) {
    const vector = byId[id];
    const kind = kinds[id];
    assert.ok(vector, id);
    assert.equal(drivable.has(id), false, id);
    const spawn = [...vector.setup, ...vector.trigger].find((step) => step.spawnWorker);
    assert.equal(spawn?.spawnWorker, kind.spawn, id);
    assert.equal(spawn?.url, '{target}/doc?n=host-{tag}', id);
    assert.equal(spawn?.frame, kind.frame, id);
    assert.deepEqual(vector.targets, ['seven', 'vault'], id);
    assert.ok(vector.requires.includes('stockSetup'), id);
    assert.ok(vector.requires.includes('autoAttach'), id);
    if (kind.secure) assert.ok(vector.requires.includes('secureOrigin'), id);
    assert.equal(vector.expected.workerExists, true, id);
    assert.equal(vector.expected.workerAttached, false, id);
    assert.equal(vector.expected.workerListed, false, id);
    assert.equal(vector.expected.workerDiscovered, false, id);
    assert.equal(vector.expected.attachSession, false, id);
    assert.equal(vector.expected.attachRefused, 'either', id);
    assert.equal(vector.expected.workerReachable, false, id);
    assert.equal(Object.hasOwn(vector.expected, 'attachForwarded'), false, id);
    assert.equal(Object.hasOwn(vector.control.expected, 'attachForwarded'), false, id);
    assert.equal(vector.requires.includes('forwardAudit'), false, id);
    assert.equal(vector.control.expected.workerExists, true, id);
    assert.equal(vector.control.expected.attachSession, true, id);
    assert.equal(vector.control.expected.attachRefused, false, id);
    assert.equal(vector.control.expected.workerReachable, kind.reachable, id);
    const probe = vector.trigger.find((step) => step.probeSessions);
    assert.equal(probe?.probeSessions?.since, 'spawn', id);
    assert.equal(probe?.probeSessions?.path, kind.path, id);
    assert.deepEqual(probe?.probeSessions?.attach, ['attach'], id);
    const attach = vector.trigger.find((step) => step.cdp === 'Target.attachToTarget');
    assert.equal(attach?.reuseSession, true, id);
    assert.equal(attach?.params?.targetId, '{workerTarget}', id);
    const wait = vector.trigger.findIndex((step) => step.wait === 1500);
    const targets = vector.trigger.findIndex((step) => step.as === 'targets');
    const probeAt = vector.trigger.findIndex((step) => step.probeSessions);
    assert.ok(wait >= 0 && targets > wait && probeAt > targets, `${id} getTargets after wait`);
    if (id === 'C3.protected-worker-framed')
      assert.deepEqual(vector.setup.find((step) => step.children)?.where?.types, [
        'page',
        'iframe',
      ]);
    identityAny(vector.observe.workerAttached.check, kind.type, kind.path);
    listedAny(vector.observe.workerListed.check, kind.type, kind.path);
    identityAny(vector.observe.workerDiscovered.check, kind.type, kind.path);
    assert.equal(vector.observe.workerReachable.check.result, 'probe', id);
    assert.equal(vector.observe.workerReachable.check.path, 'result.reachable', id);
    assert.equal(vector.observe.workerListed.absencePoll, true, id);
  }
});

test('a narrowing or per-target-hiding guard passes the protected worker rows', () => {
  for (const id of protectedRows) {
    const vector = byId[id];
    const observed = {
      admitted: true,
      workerExists: true,
      workerAttached: false,
      workerListed: false,
      workerDiscovered: false,
      attachSession: false,
      attachRefused: true,
      workerReachable: false,
    };
    assert.equal(judge(vector, 'guarded', observed).pass, true, id);
    assert.equal(
      judge(vector, 'guarded', { ...observed, attachRefused: false }).pass,
      true,
      `${id} attach fail without refusal`
    );
    assert.equal(
      judge(vector, 'guarded', { ...observed, attachForwarded: true }).pass,
      true,
      `${id} forward-and-cut is not judged on the ledger`
    );
  }
  for (const id of ordinary) {
    const vector = byId[id];
    assert.equal(
      judge(vector, 'guarded', { admitted: true, workerAttached: true, workerExists: true }).pass,
      true,
      `${id} delivers ordinary workers`
    );
    assert.equal(
      judge(vector, 'guarded', { admitted: true, workerAttached: false, workerExists: true }).pass,
      true,
      `${id} narrows away ordinary workers`
    );
  }
});

test('a guard that delivers a protected worker fails each protected row', () => {
  for (const id of protectedRows) {
    const vector = byId[id];
    const base = {
      admitted: true,
      workerExists: true,
      workerAttached: false,
      workerListed: false,
      workerDiscovered: false,
      attachSession: false,
      attachRefused: true,
      workerReachable: false,
    };
    assert.equal(
      judge(vector, 'guarded', { ...base, workerAttached: true }).pass,
      false,
      `${id} attached`
    );
    assert.equal(
      judge(vector, 'guarded', { ...base, workerListed: true }).pass,
      false,
      `${id} listed`
    );
    assert.equal(
      judge(vector, 'guarded', {
        ...base,
        attachSession: true,
        attachRefused: false,
      }).pass,
      false,
      `${id} attach session`
    );
    assert.equal(
      judge(vector, 'guarded', { ...base, workerReachable: true }).pass,
      false,
      `${id} reachable`
    );
  }
});

test('a rewritten or empty-targetInfo attach still fails via workerReachable', () => {
  for (const id of protectedRows) {
    const vector = byId[id];
    assert.equal(
      judge(vector, 'guarded', {
        admitted: true,
        workerExists: true,
        workerAttached: false,
        workerListed: false,
        workerDiscovered: false,
        attachSession: false,
        attachRefused: true,
        workerReachable: true,
      }).pass,
      false,
      id
    );
  }
});

test('a redacted-URL worker delivery still fails each protected row via identity', () => {
  for (const id of protectedRows) {
    const vector = byId[id];
    assert.equal(
      judge(vector, 'guarded', {
        admitted: true,
        workerExists: true,
        workerAttached: true,
        workerListed: true,
        workerDiscovered: true,
        attachSession: false,
        attachRefused: true,
        workerReachable: false,
      }).pass,
      false,
      id
    );
  }
});

test('a lying attach reply that still returns a session id fails attachSession', () => {
  for (const id of protectedRows) {
    const vector = byId[id];
    assert.equal(
      judge(vector, 'guarded', {
        admitted: true,
        workerExists: true,
        workerAttached: false,
        workerListed: false,
        workerDiscovered: false,
        attachSession: true,
        attachRefused: true,
        workerReachable: false,
      }).pass,
      false,
      id
    );
  }
});

test('protectedWorker records the worker target id from getTargets', async () => {
  const page = 'http://vault.example.test/doc?n=host-t';
  const workerUrl = 'http://vault.example.test/worker.js?n=t';
  const calls = [];
  let spawned = false;
  const reader = {
    events: [],
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createBrowserContext')
        throw new Error('dedicated spawn must not create a browser context');
      if (method === 'Target.createTarget') {
        assert.equal(params.browserContextId, undefined);
        return { targetId: 'page-1' };
      }
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId: params.targetId, type: 'page', url: 'about:blank' } };
      if (method === 'Target.attachToTarget') return { sessionId: 'page-session' };
      if (method === 'Target.setAutoAttach') {
        assert.equal(sessionId, 'page-session');
        assert.equal(params.waitForDebuggerOnStart, false);
        return {};
      }
      if (method === 'Target.detachFromTarget') return {};
      if (method === 'Page.enable' || method === 'Runtime.enable') return {};
      if (method === 'Page.navigate') return {};
      if (method === 'Target.getTargets')
        return {
          targetInfos: spawned
            ? [
                { targetId: 'page-1', type: 'page', url: page },
                { targetId: 'worker-1', type: 'worker', url: workerUrl },
              ]
            : [{ targetId: 'page-1', type: 'page', url: page }],
        };
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
        if (String(params.expression).includes('new Worker')) {
          spawned = true;
          return { result: { value: 'spawned' } };
        }
        if (String(params.expression).includes('__sliccW')) return { result: { value: true } };
        throw new Error(`unexpected evaluate ${params.expression}`);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const { protectedWorker } = await import('../../protected-worker.mjs');
  const out = await protectedWorker({
    reader,
    kind: 'dedicated',
    pageUrl: page,
    tag: 't',
    context: 'stale-context',
    notes: [],
    budget: 200,
  });
  assert.equal(out.workerTargetId, 'worker-1');
  assert.equal(out.exists, true);
  assert.equal(out.browserContextId, undefined);
  assert.ok(calls.some((call) => call.method === 'Target.setAutoAttach'));
});

test('protectedWorker matches a new empty-url dedicated worker after the before snapshot', async () => {
  let spawned = false;
  const page = 'https://seven.sliccy.ai:443/doc?n=host-t';
  const reader = {
    events: [],
    async send(method, params = {}) {
      if (method === 'Target.createTarget') return { targetId: 'page-1' };
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId: params.targetId, type: 'page', url: 'about:blank' } };
      if (method === 'Target.attachToTarget') return { sessionId: 'page-session' };
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Target.detachFromTarget') return {};
      if (method === 'Page.enable' || method === 'Runtime.enable') return {};
      if (method === 'Page.navigate') return {};
      if (method === 'Target.getTargets')
        return {
          targetInfos: spawned
            ? [
                { targetId: 'page-1', type: 'page', url: page },
                { targetId: 'stale', type: 'worker', url: '', openerId: 'other' },
                { targetId: 'worker-1', type: 'worker', url: '' },
              ]
            : [
                { targetId: 'page-1', type: 'page', url: page },
                { targetId: 'stale', type: 'worker', url: '', openerId: 'other' },
              ],
        };
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
        if (String(params.expression).includes('new Worker')) {
          spawned = true;
          return { result: { value: 'spawned' } };
        }
        if (String(params.expression).includes('__sliccW')) return { result: { value: true } };
        throw new Error(`unexpected evaluate ${params.expression}`);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const { protectedWorker, pickSpawnedWorker } = await import('../../protected-worker.mjs');
  assert.equal(
    pickSpawnedWorker(
      [
        { targetId: 'stale', type: 'worker', url: '' },
        { targetId: 'worker-1', type: 'worker', url: '', openerId: 'page-1' },
      ],
      {
        type: 'worker',
        path: '/worker.js',
        tag: 't',
        beforeIds: new Set(['stale']),
        owners: new Set(['page-1']),
      }
    )?.targetId,
    'worker-1'
  );
  const out = await protectedWorker({
    reader,
    kind: 'dedicated',
    pageUrl: page,
    tag: 't',
    notes: [],
    budget: 500,
  });
  assert.equal(out.workerTargetId, 'worker-1');
  assert.equal(out.workerUrl, '');
});

test('protectedWorker notes before and after getTargets when the worker never appears', async () => {
  const notes = [];
  const reader = {
    events: [],
    async send(method, params = {}) {
      if (method === 'Target.createTarget') return { targetId: 'page-1' };
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId: params.targetId, type: 'page', url: 'about:blank' } };
      if (method === 'Target.attachToTarget') return { sessionId: 'page-session' };
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Target.detachFromTarget') return {};
      if (method === 'Page.enable' || method === 'Runtime.enable') return {};
      if (method === 'Page.navigate') return {};
      if (method === 'Target.getTargets')
        return {
          targetInfos: [
            {
              targetId: 'page-1',
              type: 'page',
              url: 'https://seven.sliccy.ai/doc',
              openerId: 'opener-1',
            },
            {
              targetId: 'other',
              type: 'shared_worker',
              url: 'https://ordinary.example.test/sw',
              parentId: 'page-9',
            },
          ],
        };
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
        if (String(params.expression).includes('new Worker'))
          return { result: { value: 'spawned' } };
        throw new Error(`unexpected evaluate ${params.expression}`);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const { protectedWorker } = await import('../../protected-worker.mjs');
  await assert.rejects(
    () =>
      protectedWorker({
        reader,
        kind: 'dedicated',
        pageUrl: 'https://seven.sliccy.ai/doc?n=host-t',
        tag: 't',
        notes,
        budget: 80,
      }),
    /did not appear/
  );
  assert.ok(
    notes.some(
      (note) =>
        note.includes('protected worker dedicated getTargets before:') &&
        note.includes('openerId=opener-1') &&
        note.includes('parentId=page-9')
    )
  );
  assert.ok(
    notes.some(
      (note) =>
        note.includes('protected worker dedicated getTargets after:') &&
        note.includes('shared_worker,url=https://ordinary.example.test/sw')
    )
  );
});

test('shared protectedWorker isolates the spawn in its own browser context', async () => {
  const page = 'http://vault.example.test/doc?n=host-t';
  const workerUrl = 'http://vault.example.test/shared-worker.js?n=t';
  let spawned = false;
  const reader = {
    events: [],
    async send(method, params = {}) {
      if (method === 'Target.createBrowserContext') return { browserContextId: 'ctx-shared' };
      if (method === 'Target.createTarget') {
        assert.equal(params.browserContextId, 'ctx-shared');
        return { targetId: 'page-1' };
      }
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId: params.targetId, type: 'page', url: 'about:blank' } };
      if (method === 'Target.attachToTarget') return { sessionId: 'page-session' };
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Target.detachFromTarget') return {};
      if (method === 'Page.enable' || method === 'Runtime.enable') return {};
      if (method === 'Page.navigate') return {};
      if (method === 'Target.getTargets')
        return {
          targetInfos: spawned
            ? [
                { targetId: 'page-1', type: 'page', url: page },
                { targetId: 'worker-1', type: 'shared_worker', url: workerUrl },
              ]
            : [{ targetId: 'page-1', type: 'page', url: page }],
        };
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
        if (String(params.expression).includes('SharedWorker')) {
          spawned = true;
          return { result: { value: 'spawned' } };
        }
        if (String(params.expression).includes('__sliccW')) return { result: { value: true } };
        throw new Error(`unexpected evaluate ${params.expression}`);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const { protectedWorker } = await import('../../protected-worker.mjs');
  const out = await protectedWorker({
    reader,
    kind: 'shared',
    pageUrl: page,
    tag: 't',
    notes: [],
    budget: 200,
  });
  assert.equal(out.workerTargetId, 'worker-1');
  assert.equal(out.browserContextId, 'ctx-shared');
});

test('framed protectedWorker evaluates inside an iframe target session', async () => {
  const host = 'http://ordinary.example.test/doc?n=host-t';
  const page = 'http://vault.example.test/doc?n=host-t';
  const workerUrl = 'http://vault.example.test/worker.js?n=t';
  const events = [];
  let iframeAttached = false;
  let spawned = false;
  const reader = {
    events,
    async send(method, params = {}, sessionId) {
      if (method === 'Target.createBrowserContext')
        throw new Error('framed dedicated spawn must not create a browser context');
      if (method === 'Target.createTarget') {
        assert.equal(params.browserContextId, undefined);
        return { targetId: 'page-1' };
      }
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId: params.targetId, type: 'page', url: 'about:blank' } };
      if (method === 'Target.attachToTarget') {
        if (params.targetId === 'page-1') return { sessionId: 'page-session' };
        if (params.targetId === 'iframe-1') {
          iframeAttached = true;
          return { sessionId: 'iframe-session' };
        }
        throw new Error(`unexpected attach ${params.targetId}`);
      }
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Runtime.runIfWaitingForDebugger') return {};
      if (method === 'Target.detachFromTarget') return {};
      if (method === 'Page.enable' || method === 'Runtime.enable') return {};
      if (method === 'Page.navigate') return {};
      if (method === 'Target.getTargets') {
        const infos = [
          { targetId: 'page-1', type: 'page', url: host },
          { targetId: 'iframe-1', type: 'iframe', url: page },
        ];
        if (spawned)
          infos.push({
            targetId: 'worker-1',
            type: 'worker',
            url: workerUrl,
            openerId: 'iframe-1',
          });
        return { targetInfos: infos };
      }
      if (method === 'Runtime.evaluate') {
        if (sessionId === 'page-session') {
          if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
          if (String(params.expression).includes('iframe')) return { result: { value: true } };
          throw new Error(`unexpected page evaluate ${params.expression}`);
        }
        if (sessionId === 'iframe-session') {
          if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
          if (String(params.expression).includes('new Worker')) {
            spawned = true;
            return { result: { value: 'spawned' } };
          }
          if (String(params.expression).includes('__sliccW')) return { result: { value: true } };
          throw new Error(`unexpected iframe evaluate ${params.expression}`);
        }
        throw new Error(`unexpected session ${sessionId}`);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const { protectedWorker } = await import('../../protected-worker.mjs');
  const out = await protectedWorker({
    reader,
    kind: 'dedicated',
    pageUrl: page,
    hostUrl: host,
    tag: 't',
    notes: [],
    budget: 200,
  });
  assert.equal(out.exists, true);
  assert.equal(out.workerTargetId, 'worker-1');
  assert.equal(out.framed, true);
  assert.equal(iframeAttached, true);
});

test('probeWorkerSessions treats rejections as neutral', async () => {
  const out = await probeWorkerSessions({
    client: {
      async send(method, _params, sessionId) {
        if (method === 'Runtime.runIfWaitingForDebugger') return {};
        if (sessionId === 'tab') throw new Error("slicc: 'Runtime.evaluate' wasn't found");
        return { result: { value: false } };
      },
    },
    sessions: ['tab', 'page'],
    path: '/worker.js',
    tag: 't',
  });
  assert.equal(out.reachable, false);
  assert.equal(out.incomplete, undefined);
});

test('probeWorkerSessions is incomplete when a rejecting tab masks a worker timeout', async () => {
  const out = await probeWorkerSessions({
    client: {
      async send(method, _params, sessionId) {
        if (method === 'Runtime.runIfWaitingForDebugger') return {};
        if (sessionId === 'tab') throw new Error('slicc: refused: protected target');
        if (sessionId === 'worker') throw new Error('waitEvent timed out');
        return { result: { value: false } };
      },
    },
    sessions: ['tab', 'worker'],
    path: '/worker.js',
    tag: 't',
  });
  assert.equal(out.reachable, false);
  assert.match(out.incomplete ?? '', /harness error/);
});

test('probeWorkerSessions keeps a true beside a rejecting tab', async () => {
  const client = {
    async send(method, _params, sessionId) {
      if (method === 'Runtime.runIfWaitingForDebugger') return {};
      if (sessionId === 'tab') throw new Error("slicc: 'Runtime.evaluate' wasn't found");
      return { result: { value: sessionId === 'worker' } };
    },
  };
  const first = await probeWorkerSessions({
    client,
    sessions: ['tab', 'worker'],
    path: '/worker.js',
    tag: 't',
  });
  assert.equal(first.reachable, true);
  assert.equal(first.incomplete, undefined);
  const second = await probeWorkerSessions({
    client,
    sessions: ['worker', 'tab'],
    path: '/worker.js',
    tag: 't',
  });
  assert.equal(second.reachable, true);
  assert.equal(second.incomplete, undefined);
});

test('probeWorkerSessions is incomplete when a silent tab times out alone', async () => {
  const out = await probeWorkerSessions({
    client: {
      async send(method) {
        if (method === 'Runtime.runIfWaitingForDebugger') return {};
        throw new Error('waitEvent timed out');
      },
    },
    sessions: ['tab'],
    path: '/worker.js',
    tag: 't',
  });
  assert.equal(out.reachable, false);
  assert.match(out.incomplete ?? '', /harness error/);
});

test('control probe stalls stay pass or fail closed; guarded stalls are incomplete', async () => {
  let resumed = 0;
  const out = await probeWorkerSessions({
    client: {
      async send(method) {
        if (method === 'Runtime.runIfWaitingForDebugger') {
          resumed++;
          return {};
        }
        throw new Error('CDP timed out: Runtime.evaluate');
      },
    },
    sessions: ['tab'],
    path: '/worker.js',
    tag: 't',
  });
  assert.equal(resumed, 1);
  assert.equal(out.reachable, false);
  assert.match(out.incomplete ?? '', /harness error/);
  assert.equal(probeHarnessIncomplete('control', out.incomplete), undefined);
  assert.match(probeHarnessIncomplete('guarded', out.incomplete) ?? '', /harness error/);
  const control = {
    admitted: true,
    workerExists: true,
    workerAttached: true,
    workerListed: true,
    attachSession: true,
    attachRefused: false,
    workerReachable: false,
  };
  assert.equal(judge(byId['C3.protected-worker-framed'], 'control', control).pass, true);
  assert.equal(judge(byId['C3.protected-worker-dedicated'], 'control', control).pass, true);
  assert.equal(judge(byId['C3.protected-worker-shared'], 'control', control).pass, false);
  assert.equal(judge(byId['C3.protected-service-worker'], 'control', control).pass, false);
});

test('stockSetup and README admit either narrowing or per-target hiding for workers', () => {
  assert.match(set.capabilities.stockSetup, /narrows to tab targets or hides per target/);
  assert.match(set.capabilities.stockSetup, /worker/);
  assert.equal(set.placeholders.workerTarget.includes('spawnWorker'), true);
});

test('emulator narrowAutoAttach rewrites only the browser session to tab targets', async () => {
  const source = await readFile(new URL('./guard-emulator.mjs', import.meta.url), 'utf8');
  const plain = source.indexOf('function emulatedGuardPlain');
  const worker = source.indexOf('function emulatedGuardWithWorkerRules');
  for (const from of [plain, worker]) {
    const start = source.indexOf('options.narrowAutoAttach &&', from);
    const end = source.indexOf('forwarded.push', start);
    const block = source.slice(start, end);
    assert.ok(block.includes('!sessionId'));
    assert.ok(block.includes("filter: [{ type: 'tab' }]"));
    assert.equal(block.includes("{ type: 'page' }"), false);
  }
});

test('emulator does not Fetch-shield foreign observer pages under resumeUnexposed', async () => {
  const source = await readFile(new URL('./guard-emulator.mjs', import.meta.url), 'utf8');
  const worker = source.indexOf('function emulatedGuardWithWorkerRules');
  const start = source.indexOf("if (event.method !== 'Target.attachedToTarget') continue;", worker);
  const end = source.indexOf('learnFrames();', start);
  const block = source.slice(start, end);
  assert.ok(block.includes('const owned = pages.has(info.targetId) || pages.has(info.openerId)'));
  assert.ok(block.includes('if (!owned)'));
  assert.ok(block.includes('foreign.add(event.params.sessionId)'));
  assert.match(block, /if \(!owned\) \{\s*foreign\.add\(event\.params\.sessionId\);\s*continue;/);
  const resume = source.indexOf('options.resumeUnexposed && event.method ===', worker);
  const resumeBlock = source.slice(resume, source.indexOf('if (event.method !==', resume));
  assert.ok(resumeBlock.includes('const foreign ='));
  assert.ok(resumeBlock.includes("(foreign || (type !== 'page' && type !== 'iframe'))"));
});

test('adopt resumes a paused child before running nested steps on worker rows', async () => {
  const source = await readFile(new URL('../../guard-runner.mjs', import.meta.url), 'utf8');
  const adopt = source.indexOf('  adopt(event) {');
  const worker = source.indexOf('if (workerRow) {', adopt);
  const resume = source.indexOf('Runtime.runIfWaitingForDebugger', worker);
  const execute = source.indexOf('await this.execute(nested', resume);
  assert.ok(adopt >= 0 && worker > adopt);
  assert.ok(resume > worker && resume < execute);
  assert.ok(source.includes("adopt ${info?.type ?? 'target'} ${child}:"));
});

test('emulator skips Page.getFrameTree on worker attach and probes only page-like targets', async () => {
  const source = await readFile(new URL('./guard-emulator.mjs', import.meta.url), 'utf8');
  const start = source.indexOf(
    "if (catalog && method === 'Target.attachToTarget')",
    source.indexOf('function emulatedGuardWithWorkerRules')
  );
  const end = source.indexOf('const frameRules =', start);
  const block = source.slice(start, end);
  assert.ok(block.includes("const pageLike = ['page', 'iframe', 'tab'].includes(targetInfo.type)"));
  assert.ok(block.includes('if (pageLike)'));
  assert.ok(block.includes('timedSend'));
  assert.ok(block.includes('3000'));
  assert.ok(block.includes('attach probe'));
  assert.equal(/unguarded\.send\(\s*'Page\.getFrameTree'/.test(block), false);
});

test('emulator decision treats empty-url workers as protected via opener/parent', async () => {
  const source = await readFile(new URL('./guard-emulator.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function emulatedGuardWithWorkerRules');
  const decision = source.indexOf('const decision = async (targetId) =>', start);
  const end = source.indexOf('const contexts = new Set()', decision);
  const block = source.slice(decision, end);
  assert.ok(source.includes('options.workerRules'));
  assert.ok(source.includes('emulatedGuardPlain'));
  assert.ok(source.includes('const ownerOpener = async (info) =>'));
  assert.ok(source.includes('info.openerId'));
  assert.ok(source.includes('info.parentId'));
  assert.ok(source.includes('info.openerFrameId'));
  assert.ok(source.includes("return info.url ? undefined : 'unknown'"));
  assert.ok(
    block.includes(
      'if (blocked || options.targetURLOnly || !workerType(targetInfo)) return blocked'
    )
  );
  assert.ok(block.includes('const opener = await ownerOpener(targetInfo)'));
  assert.ok(block.includes('opener,'));
});

test('emulator without workerRules keeps main attach probe and foreign shield paths', async () => {
  const source = await readFile(new URL('./guard-emulator.mjs', import.meta.url), 'utf8');
  const plain = source.slice(
    source.indexOf('function emulatedGuardPlain'),
    source.indexOf('async function timedSend')
  );
  assert.equal(plain.includes('ownerOpener'), false);
  assert.equal(plain.includes('timedSend'), false);
  assert.ok(plain.includes("unguarded.send('Page.getFrameTree'"));
  assert.ok(plain.includes('if (!pages.has(info.targetId) && !pages.has(info.openerId))'));
});

test('emulator attach still refuses empty-url workers when hiding', async () => {
  const source = await readFile(new URL('./guard-emulator.mjs', import.meta.url), 'utf8');
  const start = source.indexOf(
    "if (catalog && method === 'Target.attachToTarget')",
    source.indexOf('function emulatedGuardWithWorkerRules')
  );
  const end = source.indexOf('const frameRules =', start);
  const block = source.slice(start, end);
  assert.ok(block.includes('emptyWorker'));
  assert.ok(block.includes('(blocked || (emptyWorker && !options.exposeProtectedWorkers))'));
});

test('emulator hides empty-url workers whose opener page is protected', async () => {
  const { emulatedGuard } = await import('./guard-emulator.mjs');
  const catalog = JSON.parse(
    await readFile(new URL('../../catalog.json', import.meta.url), 'utf8')
  );
  const infos = {
    'page-protected': {
      targetId: 'page-protected',
      type: 'page',
      url: 'https://seven.sliccy.ai/doc?n=host',
    },
    'page-ordinary': {
      targetId: 'page-ordinary',
      type: 'page',
      url: 'https://ordinary.example.test/doc',
    },
    'worker-protected': {
      targetId: 'worker-protected',
      type: 'worker',
      url: '',
      openerId: 'page-protected',
    },
    'worker-ordinary': {
      targetId: 'worker-ordinary',
      type: 'worker',
      url: '',
      openerId: 'page-ordinary',
    },
  };
  const raw = {
    events: [],
    send: async (method, params = {}) => {
      if (method === 'Target.getTargetInfo') return { targetInfo: infos[params.targetId] };
      if (method === 'Target.getTargets') return { targetInfos: Object.values(infos) };
      if (method === 'Target.attachToTarget') return { sessionId: `s-${params.targetId}` };
      if (method === 'Target.detachFromTarget') return {};
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { url: infos[params.targetId]?.url ?? '', id: 'f' } } };
      if (method === 'Runtime.runIfWaitingForDebugger') return {};
      return {};
    },
  };
  const guard = emulatedGuard(
    { client: raw, unguarded: raw },
    {
      protectedOrigins: catalog.protectedOrigins,
      extraOrigins: ['https://seven.sliccy.ai'],
      workerRules: true,
    }
  );
  try {
    const listed = await guard.client.send('Target.getTargets');
    const ids = listed.targetInfos.map((info) => info.targetId);
    assert.equal(ids.includes('worker-protected'), false);
    assert.equal(ids.includes('worker-ordinary'), true);
    assert.equal(ids.includes('page-ordinary'), true);
  } finally {
    await guard.stop();
  }
});

test('rewrite attack helpers split browser-level vs page-session worker rows', async () => {
  const source = await readFile(new URL('./protected-worker-chrome.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('assertRewriteAttackOutcomes'));
  assert.ok(source.includes('browserAutoAttachWorkerIds'));
  assert.ok(source.includes('pageSessionWorkerIds'));
  assert.ok(
    source.includes(
      'dedicated/framed workers are page-session auto-attach only; browser-level rewrite never delivers them so guarded passes'
    )
  );
});

test('spawnWorker rows record client CDP traces on failure and bound Page.getFrameTree', async () => {
  const source = await readFile(new URL('../../guard-runner.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('installClientTrace()'));
  assert.ok(source.includes('noteClientTrace()'));
  assert.ok(source.includes('client cdp:'));
  assert.ok(source.includes('cdpTrace.length >= 40'));
  assert.ok(source.includes('__sliccOnSend'));
  assert.ok(source.includes('const rawSend = client.send.bind(client)'));
  assert.ok(source.includes('__sliccBoundGetFrameTree'));
  assert.ok(source.includes('after 3000ms'));
});

test('tracked-style proxy does not recurse when target.send is replaced later', async () => {
  let hits = 0;
  const target = {
    events: [],
    async send() {
      hits += 1;
      return { ok: true };
    },
  };
  let boom = 0;
  const lookupSend = (method, params, sessionId) =>
    Promise.resolve().then(() => target.send(method, params, sessionId));
  const lookupProxy = new Proxy(target, {
    get(base, key) {
      if (key === 'send') return lookupSend;
      return Reflect.get(base, key);
    },
  });
  target.send = async (method, params, sessionId) => {
    boom += 1;
    if (boom > 50) throw new Error('unbounded send recursion');
    return lookupProxy.send(method, params, sessionId);
  };
  await assert.rejects(() => lookupProxy.send('Page.getFrameTree', {}, 's1'), /unbounded/);
  hits = 0;
  boom = 0;
  const original = async () => {
    hits += 1;
    return { ok: true };
  };
  target.send = original;
  const rawSend = target.send.bind(target);
  const boundSend = (method, params, sessionId) =>
    Promise.resolve().then(() => rawSend(method, params, sessionId));
  const boundProxy = new Proxy(target, {
    get(base, key) {
      if (key === 'send') return boundSend;
      return Reflect.get(base, key);
    },
  });
  target.send = async (method, params, sessionId) => boundProxy.send(method, params, sessionId);
  for (let i = 0; i < 1000; i++) await boundProxy.send('Runtime.evaluate', {}, undefined);
  assert.equal(hits, 1000);
  assert.equal(boom, 0);
});

const c8AttachRows = ['C8.newtab', 'C8.network-error', 'C8.iframe-error', 'C8.browser-ui-attach'];

test('adopt resumes a paused worker even when its browser context does not match', async () => {
  const source = await readFile(new URL('../../guard-runner.mjs', import.meta.url), 'utf8');
  const adopt = source.indexOf('  adopt(event) {');
  const foreign = source.indexOf('browserContextId !== this.vars.context', adopt);
  const resume = source.indexOf('Runtime.runIfWaitingForDebugger', foreign);
  const matched = source.indexOf('const matched =', foreign);
  assert.ok(adopt >= 0 && foreign > adopt);
  assert.ok(resume > foreign && resume < matched);
  assert.ok(source.includes('async resumeWaiting('));
  assert.ok(source.includes('releasePersistentWorkerSessions'));
  assert.ok(source.includes('ensurePriorWorkersGone'));
  assert.ok(source.includes('cleanupSpawnedWorkerLeg'));
  assert.ok(source.includes('browserContextId'));
  assert.ok(source.includes('if (paused && workerRow)'));
  const workerSource = await readFile(
    new URL('../../protected-worker.mjs', import.meta.url),
    'utf8'
  );
  assert.ok(workerSource.includes("byId.get(targetId)?.type === 'iframe'"));
  assert.ok(workerSource.includes("kind === 'shared' || kind === 'service'"));
  assert.ok(workerSource.includes('Target.createBrowserContext'));
  assert.ok(workerSource.includes('Target.disposeBrowserContext'));
});

test('shared and service browser auto-attach do not wait for debugger on start', () => {
  for (const id of ['C3.protected-worker-shared', 'C3.protected-service-worker']) {
    const browserAttach = byId[id].setup.find(
      (step) => step.cdp === 'Target.setAutoAttach' && step.session === 'browser'
    );
    assert.equal(browserAttach.params.waitForDebuggerOnStart, false, id);
  }
  const dedicated = byId['C3.protected-worker-dedicated'].setup.find(
    (step) => step.cdp === 'Target.setAutoAttach' && step.session === 'browser'
  );
  assert.equal(dedicated.params.waitForDebuggerOnStart, true);
});

test('framed protected worker where uses types array', () => {
  const step = byId['C3.protected-worker-framed'].setup.find((entry) => entry.where);
  assert.deepEqual(step.where, { types: ['page', 'iframe'] });
  assert.equal(Object.hasOwn(step.where, 'type'), false);
});

test('emulator stall: leftover paused shared worker blocks the next createTarget until released', async () => {
  const workers = [
    {
      targetId: 'w1',
      type: 'shared_worker',
      url: 'http://ordinary.example.test/shared-worker.js?n=host-control-1',
    },
  ];
  const pages = [{ targetId: 'page-1', type: 'page', url: 'http://ordinary.example.test/doc' }];
  const base = {
    events: [
      {
        method: 'Target.attachedToTarget',
        params: {
          waitingForDebugger: true,
          sessionId: 'ws',
          targetInfo: workers[0],
        },
      },
    ],
    send: async (method, params = {}) => {
      if (method === 'Target.getTargets') return { targetInfos: [...workers, ...pages] };
      if (method === 'Target.closeTarget') {
        const drop = (list) => {
          const i = list.findIndex((info) => info.targetId === params.targetId);
          if (i >= 0) list.splice(i, 1);
        };
        drop(workers);
        drop(pages);
        return { success: true };
      }
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Target.createTarget') {
        const targetId = `p${pages.length + 2}`;
        pages.push({ targetId, type: 'page', url: params.url ?? 'about:blank' });
        return { targetId };
      }
      return {};
    },
  };
  const client = withPausedSharedWorkerStall(base);
  await assert.rejects(
    () => client.send('Target.createTarget', { url: 'about:blank' }),
    /CDP timed out: Target.createTarget/
  );
  assert.equal(
    (await leftoverPersistentWorker(client, { type: 'shared_worker', url: workers[0].url }))
      ?.targetId,
    'w1'
  );
  await releasePersistentWorkerSessions({
    client,
    reader: client,
    events: client.events,
    from: 0,
    tag: 'host-control-1',
    targets: ['page-1', 'w1'],
    attachSessions: [undefined],
  });
  assert.equal(client.pausedSharedSessions.size, 0);
  assert.equal(
    await leftoverPersistentWorker(client, { type: 'shared_worker', url: workers[0]?.url }),
    undefined
  );
  const created = await client.send('Target.createTarget', { url: 'about:blank' });
  assert.ok(created.targetId);
});

test('emulator stall: disposing the spawn browser context also unblocks createTarget', async () => {
  const workers = [
    {
      targetId: 'w2',
      type: 'shared_worker',
      url: 'http://ordinary.example.test/shared-worker.js?n=host-control-2',
    },
  ];
  const contexts = new Set(['ctx-stall']);
  const pages = [{ targetId: 'page-2', type: 'page', url: 'about:blank' }];
  const base = {
    events: [
      {
        method: 'Target.attachedToTarget',
        params: {
          waitingForDebugger: true,
          sessionId: 'ws2',
          targetInfo: workers[0],
        },
      },
    ],
    send: async (method, params = {}, sessionId) => {
      if (method === 'Runtime.runIfWaitingForDebugger' && sessionId) return {};
      if (method === 'Target.detachFromTarget') return {};
      if (method === 'Target.getTargets') return { targetInfos: [...workers, ...pages] };
      if (method === 'Target.disposeBrowserContext') {
        contexts.delete(params.browserContextId);
        workers.length = 0;
        pages.length = 0;
        return {};
      }
      if (method === 'Target.createTarget') {
        if (contexts.has('ctx-stall') && workers.length)
          throw new Error('CDP timed out: Target.createTarget');
        const targetId = `p${pages.length + 3}`;
        pages.push({ targetId, type: 'page', url: params.url ?? 'about:blank' });
        return { targetId };
      }
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Target.closeTarget') return { success: true };
      return {};
    },
  };
  const client = withPausedSharedWorkerStall(base);
  await assert.rejects(
    () => client.send('Target.createTarget', { url: 'about:blank' }),
    /CDP timed out: Target.createTarget/
  );
  await releasePersistentWorkerSessions({
    client,
    reader: client,
    events: client.events,
    from: 0,
    tag: 'host-control-2',
    targets: [],
    attachSessions: [],
  });
  await client.send('Target.disposeBrowserContext', { browserContextId: 'ctx-stall' });
  assert.equal(client.pausedSharedSessions.size, 0);
  const created = await client.send('Target.createTarget', { url: 'about:blank' });
  assert.ok(created.targetId);
});

test('C8 attach rows do not opt into session reuse', () => {
  for (const id of c8AttachRows) {
    const attach = [...byId[id].setup, ...byId[id].trigger].find(
      (step) => step.cdp === 'Target.attachToTarget'
    );
    assert.ok(attach, id);
    assert.equal(Object.hasOwn(attach, 'reuseSession'), false, id);
  }
});

test('a refused C8-shaped trigger attach stays refused when setup already attached the page', () => {
  const events = [
    {
      method: 'Target.attachedToTarget',
      params: { targetInfo: { targetId: 'page-1' }, sessionId: 's-page' },
    },
  ];
  const refused = { ok: false, error: { message: 'slicc: refused' } };
  const step = { cdp: 'Target.attachToTarget', as: 'attach' };
  assert.equal(reusableAttachSession(step, refused, { targetId: 'page-1' }, events, 0), undefined);
  assert.equal(isRefusal(refused, { ...step, refusal: { match: 'refused' } }), true);
  assert.equal(refused.ok, false);
});

test('reuseSession recovers an already-attached worker answer from the auto-attach event', () => {
  const events = [
    {
      method: 'Target.attachedToTarget',
      params: { targetInfo: { targetId: 'w1' }, sessionId: 'ws' },
    },
  ];
  assert.equal(
    reusableAttachSession(
      { cdp: 'Target.attachToTarget', reuseSession: true },
      { ok: false, error: { message: 'Target is attaching or attached already.' } },
      { targetId: 'w1' },
      events,
      0
    ),
    'ws'
  );
  assert.equal(
    reusableAttachSession(
      { cdp: 'Target.attachToTarget', reuseSession: true },
      { ok: true, result: {} },
      { targetId: 'w1' },
      events,
      0
    ),
    'ws'
  );
});

test('a worker attach refusal stays refused when an attachedToTarget event already exists', () => {
  const events = [
    {
      method: 'Target.attachedToTarget',
      params: { targetInfo: { targetId: 'w1' }, sessionId: 'ws' },
    },
  ];
  const refused = { ok: false, error: { message: 'slicc: refused' } };
  assert.equal(
    reusableAttachSession(
      {
        cdp: 'Target.attachToTarget',
        reuseSession: true,
        refusable: true,
        refusal: { match: 'refused' },
      },
      refused,
      { targetId: 'w1' },
      events,
      0
    ),
    undefined
  );
  assert.equal(
    reusableAttachSession(
      { cdp: 'Target.attachToTarget', reuseSession: true },
      { ok: false, error: { code: -32000, message: 'Internal error' } },
      { targetId: 'w1' },
      events,
      0
    ),
    undefined
  );
});

{
  const source = await readFile(new URL('../../guard-runner.mjs', import.meta.url), 'utf8');
  const cdpStart = source.indexOf('  async cdp(step, sessionId');
  const cdpEnd = source.indexOf('\n  async seedContext', cdpStart);
  const recordStart = source.indexOf('  record(step, out, session, phase, gone)');
  const recordEnd = source.indexOf('\n  async execute', recordStart);
  const methods = new Function(
    'debuggerCleanup',
    'debuggerPaused',
    'idleDebuggerCleanup',
    'outcome',
    'supported',
    'sleep',
    'refusedOut',
    'exitsClient',
    'refusalError',
    'trustedClientOnly',
    'reusableAttachSession',
    `return { ${source.slice(cdpStart, cdpEnd)}, ${source.slice(recordStart, recordEnd)} };`
  )(
    debuggerCleanup,
    debuggerPaused,
    idleDebuggerCleanup,
    outcome,
    () => false,
    async () => {},
    (step, out) => isRefusal(out, step),
    () => false,
    refusalError,
    trustedClientOnly,
    reusableAttachSession
  );

  test('extracted cdp keeps a C8-shaped refusal when setup already attached the page', async () => {
    const notes = [];
    const execution = {
      vector: { id: 'C8.newtab' },
      client: {
        events: [
          {
            method: 'Target.attachedToTarget',
            params: { targetInfo: { targetId: 'page-1' }, sessionId: 's-page' },
          },
        ],
        send: async () => {
          throw Object.assign(new Error('slicc: refused'), {
            cdp: { message: 'slicc: refused' },
          });
        },
      },
      eventStart: 0,
      options: {},
      vars: {},
      notes,
      note: (message) => notes.push(message),
      attachSettings: new Map(),
      targets: [],
      contexts: [],
      referenced: (value) => value,
      actor: () => execution.client,
      bound: (ms) => ms,
    };
    const out = await methods.cdp.call(execution, {
      cdp: 'Target.attachToTarget',
      params: { targetId: 'page-1', flatten: true },
      as: 'attach',
    });
    assert.equal(out.ok, false);
    assert.match(String(out.error?.message ?? ''), /refused/);
    assert.equal(notes.length, 0);
  });

  test('extracted cdp reuses only an already-attached worker answer when reuseSession is set', async () => {
    let mode = 'already';
    const notes = [];
    const execution = {
      vector: { id: 'C3.protected-worker-dedicated' },
      client: {
        events: [
          {
            method: 'Target.attachedToTarget',
            params: { targetInfo: { targetId: 'w1' }, sessionId: 'ws' },
          },
        ],
        send: async () => {
          if (mode === 'already')
            throw Object.assign(new Error('Target is attaching or attached already.'), {
              cdp: { message: 'Target is attaching or attached already.' },
            });
          throw Object.assign(new Error('slicc: refused'), {
            cdp: { message: 'slicc: refused' },
          });
        },
      },
      eventStart: 0,
      options: {},
      vars: {},
      notes,
      note: (message) => notes.push(message),
      attachSettings: new Map(),
      targets: [],
      contexts: [],
      referenced: (value) => value,
      actor: () => execution.client,
      bound: (ms) => ms,
    };
    const reused = await methods.cdp.call(execution, {
      cdp: 'Target.attachToTarget',
      params: { targetId: 'w1', flatten: true },
      reuseSession: true,
      as: 'attach',
    });
    assert.equal(reused.ok, true);
    assert.equal(reused.result.sessionId, 'ws');
    assert.equal(reused.result.reused, true);
    mode = 'refuse';
    const kept = await methods.cdp.call(execution, {
      cdp: 'Target.attachToTarget',
      params: { targetId: 'w1', flatten: true },
      reuseSession: true,
      refusable: true,
      refusal: { match: 'refused' },
      as: 'attach',
    });
    assert.equal(kept.ok, false);
    assert.match(String(kept.error?.message ?? ''), /refused/);
  });
}
