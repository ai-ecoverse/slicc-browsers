import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { judge } from '../../guard-driver.mjs';
import { probeWorkerSessions } from '../../protected-worker.mjs';
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
    const wait = vector.trigger.findIndex((step) => step.wait === 1500);
    const targets = vector.trigger.findIndex((step) => step.as === 'targets');
    const probeAt = vector.trigger.findIndex((step) => step.probeSessions);
    assert.ok(wait >= 0 && targets > wait && probeAt > targets, `${id} getTargets after wait`);
    if (id === 'C3.protected-worker-framed')
      assert.deepEqual(vector.setup.find((step) => step.children)?.where?.type, ['page', 'iframe']);
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

test('probeWorkerSessions treats tab refusal plus page false as not reachable', async () => {
  const client = {
    async send(_method, _params, sessionId) {
      if (sessionId === 'tab') throw new Error('slicc: refused: protected target');
      return { result: { value: false } };
    },
  };
  const out = await probeWorkerSessions({
    client,
    sessions: ['tab', 'page'],
    path: '/worker.js',
    tag: 't',
  });
  assert.equal(out.reachable, false);
  assert.equal(out.incomplete, undefined);
  assert.deepEqual(out.probedIds, ['tab', 'page']);
});

test('probeWorkerSessions keeps a true after an earlier rejection', async () => {
  const client = {
    async send(_method, _params, sessionId) {
      if (sessionId === 'tab') throw new Error('Runtime.evaluate: not allowed');
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

test('probeWorkerSessions is incomplete only when every probe is a harness error', async () => {
  const client = {
    async send() {
      throw new Error('waitEvent timed out');
    },
  };
  const out = await probeWorkerSessions({
    client,
    sessions: ['a', 'b'],
    path: '/worker.js',
    tag: 't',
  });
  assert.equal(out.reachable, false);
  assert.match(out.incomplete ?? '', /harness error/);
});

test('stockSetup and README admit either narrowing or per-target hiding for workers', () => {
  assert.match(set.capabilities.stockSetup, /narrows to tab targets or hides per target/);
  assert.match(set.capabilities.stockSetup, /worker/);
  assert.equal(set.placeholders.workerTarget.includes('spawnWorker'), true);
});
