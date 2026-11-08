import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { judge } from '../../guard-driver.mjs';
import { drivable } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const byId = Object.fromEntries(set.vectors.map((vector) => [vector.id, vector]));

const ordinary = ['C3.tab-worker-leak', 'C3.tab-service-worker-leak'];
const protectedRows = [
  'C3.protected-worker-dedicated',
  'C3.protected-worker-shared',
  'C3.protected-service-worker',
];
const kinds = {
  'C3.protected-worker-dedicated': { spawn: 'dedicated', type: 'worker', path: '/worker.js' },
  'C3.protected-worker-shared': {
    spawn: 'shared',
    type: 'shared_worker',
    path: '/shared-worker.js',
  },
  'C3.protected-service-worker': {
    spawn: 'service',
    type: 'service_worker',
    path: '/sw.js',
    secure: true,
  },
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
    assert.equal(vector.expected.attachForwarded, false, id);
    assert.equal(vector.control.expected.workerExists, true, id);
    assert.equal(vector.control.expected.attachSession, true, id);
    assert.equal(vector.control.expected.attachRefused, false, id);
    assert.equal(vector.control.expected.attachForwarded, true, id);
    assert.ok(vector.requires.includes('forwardAudit'), id);
    assert.ok(
      Object.hasOwn(vector.observe.workerExists, 'dependsOn') &&
        Object.hasOwn(vector.observe.workerAttached, 'dependsOn') &&
        Object.hasOwn(vector.observe.workerListed, 'dependsOn') &&
        Object.hasOwn(vector.observe.attachSession, 'dependsOn'),
      id
    );
    assert.deepEqual(vector.observe.workerExists.dependsOn, [], id);
    assert.deepEqual(vector.observe.workerAttached.dependsOn, [], id);
    assert.deepEqual(vector.observe.workerListed.dependsOn, [], id);
    assert.ok(JSON.stringify(vector.liveCheck).includes('loaded'), id);
    assert.equal(JSON.stringify(vector.liveCheck).includes('"title"'), false, id);
    const attach = vector.trigger.find((step) => step.as === 'attach');
    assert.equal(attach?.cdp, 'Target.attachToTarget', id);
    assert.equal(attach?.params?.targetId, '{workerTarget}', id);
    assert.equal(attach?.refusable, true, id);
    assert.equal(vector.observe.workerAttached.check.where.params.targetInfo.type, kind.type, id);
    assert.equal(
      vector.observe.workerAttached.check.where.params.targetInfo.url.$contains,
      kind.path,
      id
    );
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
      attachForwarded: false,
    };
    assert.equal(judge(vector, 'guarded', observed).pass, true, id);
    assert.equal(
      judge(vector, 'guarded', { ...observed, attachRefused: false }).pass,
      true,
      `${id} attach fail without refusal`
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
      attachForwarded: false,
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
        attachForwarded: true,
      }).pass,
      false,
      `${id} attach session`
    );
  }
});

test('a lying attach refusal that still forwards Target.attachToTarget fails the protected rows', () => {
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
        attachForwarded: true,
      }).pass,
      false,
      id
    );
  }
});

test('stockSetup and README admit either narrowing or per-target hiding for workers', () => {
  assert.match(set.capabilities.stockSetup, /narrows to tab targets or hides per target/);
  assert.match(set.capabilities.stockSetup, /worker/);
  assert.equal(set.placeholders.workerTarget.includes('spawnWorker'), true);
});
