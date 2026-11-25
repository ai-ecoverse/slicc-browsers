import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fixtureServer } from '../../fixture-server.mjs';
import * as real from '../../guard-runner.mjs';
import { origins } from './cdp-client.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const byId = Object.fromEntries(set.vectors.map((vector) => [vector.id, vector]));
const attachIds = ['C3.protected-worker-dedicated', 'C3.protected-worker-framed'];
const reachIds = ['C3.protected-worker-shared', 'C3.protected-service-worker'];
const ids = [...attachIds, ...reachIds];
const workerTypes = new Set(['worker', 'shared_worker', 'service_worker']);
const premises = ['workerAttached', 'workerReachable'];
const premisesOf = (id) => (reachIds.includes(id) ? premises : ['workerAttached']);
const pairs = [
  ...attachIds.map((id) => [id, 'workerAttached']),
  ...reachIds.map((id) => [id, 'workerReachable']),
];
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  stockSetup: true,
  syntheticAutoAttach: true,
  discovery: true,
  secureOrigin: true,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const stringAfter = (expression, marker) => {
  const at = expression.indexOf(marker);
  if (at < 0) return undefined;
  const rest = expression.slice(at + marker.length);
  const end = rest.indexOf('"', 1);
  return JSON.parse(rest.slice(0, end + 1));
};

function workerBrowser({ fixture, protectedOrigins, reach = true, announce = true, guard }) {
  let count = 0;
  const next = (prefix) => `${prefix}${++count}`;
  const targets = new Map();
  const sessions = new Map();
  const probes = { client: [], unguarded: [] };
  const protectedWorker = (target) =>
    workerTypes.has(target.type) &&
    protectedOrigins.some((origin) => target.url.startsWith(origin));
  const hidden = (connection, target) =>
    connection.name === 'client' && guard !== 'leak' && protectedWorker(target);
  const info = (target) => ({
    targetId: target.targetId,
    type: target.type,
    title: target.url,
    url: target.url,
    attached: false,
    browserContextId: target.browserContextId,
    ...(target.parentId ? { parentId: target.parentId } : {}),
  });
  const load = (target, url) => {
    target.url = url;
    if (url.startsWith('http')) fixture.record(url);
  };
  const add = (type, url, extra = {}) => {
    const target = { targetId: next(type.toUpperCase()), type, url: 'about:blank', ...extra };
    targets.set(target.targetId, target);
    if (url) load(target, url);
    return target;
  };
  const known = (targetId) => {
    const target = targets.get(targetId);
    if (!target) throw new Error('No target with given id found');
    return target;
  };
  const value = (result) => ({ result: { type: typeof result, value: result } });
  const reached = (connection, sessionId, target) => {
    if (!workerTypes.has(target.type)) return false;
    probes[connection.name].push(sessionId);
    if (typeof reach !== 'function') return reach;
    return reach(connection.name, probes[connection.name].length);
  };
  const evaluate = (connection, sessionId, target, expression) => {
    if (expression.includes('WorkerGlobalScope'))
      return value(reached(connection, sessionId, target));
    if (expression.includes('document.readyState')) return value('complete');
    for (const [marker, type, spawned] of [
      ['new Worker(', 'worker', 'spawned'],
      ['new SharedWorker(', 'shared_worker', 'spawned'],
      ['serviceWorker.register(', 'service_worker', 'registered'],
    ]) {
      const worker = stringAfter(expression, marker);
      if (!worker) continue;
      add(type, worker, { parentId: target.targetId });
      return value(spawned);
    }
    if (expression.includes('getRegistration')) return value(true);
    const frame = stringAfter(expression, 'f.src=');
    if (frame) {
      add('iframe', frame, { parentId: target.targetId });
      return value(true);
    }
    if (expression.includes('__sliccW')) return value(true);
    return value(target.url);
  };
  const browserCommand = (connection, method, params) => {
    switch (method) {
      case 'Target.createBrowserContext':
        return { browserContextId: next('CONTEXT') };
      case 'Target.createTarget':
        return {
          targetId: add('page', params.url, { browserContextId: params.browserContextId }).targetId,
        };
      case 'Target.getTargetInfo':
        return { targetInfo: info(known(params.targetId)) };
      case 'Target.getTargets':
        return {
          targetInfos: [...targets.values()]
            .filter((target) => !hidden(connection, target))
            .map(info),
        };
      case 'Target.attachToTarget': {
        const target = known(params.targetId);
        if (hidden(connection, target))
          throw new Error(
            guard === 'refuse'
              ? 'slicc: refused: protected worker'
              : 'No target with given id found'
          );
        const sessionId = next('SESSION');
        sessions.set(sessionId, { connection, targetId: target.targetId });
        if (announce || connection.name !== 'unguarded' || !workerTypes.has(target.type))
          connection.emit('Target.attachedToTarget', {
            sessionId,
            targetInfo: info(target),
            waitingForDebugger: false,
          });
        return { sessionId };
      }
      case 'Target.detachFromTarget':
        sessions.delete(params.sessionId);
        return {};
      case 'Target.closeTarget':
        return { success: targets.delete(params.targetId) };
      case 'Target.disposeBrowserContext':
        for (const target of [...targets.values()])
          if (target.browserContextId === params.browserContextId) targets.delete(target.targetId);
        return {};
      default:
        return {};
    }
  };
  const sessionCommand = (connection, method, params, sessionId) => {
    const session = sessions.get(sessionId);
    if (!session || session.connection !== connection)
      throw new Error('Session with given id not found.');
    const target = known(session.targetId);
    switch (method) {
      case 'Page.navigate':
        load(target, params.url);
        return { frameId: target.targetId, loaderId: next('LOADER') };
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: target.targetId, url: target.url } } };
      case 'Runtime.evaluate':
        return evaluate(connection, sessionId, target, params.expression ?? '');
      default:
        return {};
    }
  };
  const connection = (name) => {
    const self = { name, transport: 'cdp', events: [] };
    self.emit = (method, params, sessionId) =>
      self.events.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    self.waitEvent = async (predicate, ms = 10000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = self.events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('CDP event timed out');
        await tick();
      }
    };
    self.send = async (method, params = {}, sessionId) => {
      await tick();
      return sessionId
        ? sessionCommand(self, method, params, sessionId)
        : browserCommand(self, method, params);
    };
    return self;
  };
  return { client: connection('client'), unguarded: connection('unguarded'), probes };
}

async function execute(id, fake = {}, { vector = byId[id], runner = real } = {}) {
  const fixture = await fixtureServer();
  try {
    const targets = origins(fixture);
    const browser = workerBrowser({
      fixture,
      protectedOrigins: [targets.seven, targets.vault],
      guard: 'refuse',
      ...fake,
    });
    const { probes, ...clients } = browser;
    const execution = await runner.run(
      { ...set, vectors: [{ ...vector, targets: ['seven'] }], variants: { prompt: 0 } },
      { ...clients, fixture, targets, capabilities, settleScale: 0.05, namedResultMs: 2000 }
    );
    assert.equal(execution.results.length, 1);
    return { row: execution.results[0], summary: execution.summary(), probes };
  } finally {
    await fixture.close();
  }
}

const shown = (row) =>
  JSON.stringify({
    legs: [row.control, row.guarded, row.live],
    why: row.why,
    errors: row.errors,
    incomplete: row.incomplete,
    control: row.observations?.control,
  });

const misses = {
  workerAttached: { announce: false },
  workerReachable: { reach: false },
};

function assertPremiseMissed({ row, summary }, name) {
  assert.deepEqual(row.errors, [], shown(row));
  assert.equal(row.control, 'incomplete', shown(row));
  assert.equal(row.guarded, 'incomplete', shown(row));
  assert.equal(row.live, 'pass', shown(row));
  assert.equal(row.observations.control[name], 'incomplete', shown(row));
  assert.ok(
    row.incomplete.includes(`control ${name}: the unguarded control did not show it`),
    shown(row)
  );
  for (const other of premises.filter((entry) => entry !== name))
    assert.equal(row.observations.control[other], true, shown(row));
  assert.equal(summary.pass, false);
  assert.equal(summary.incomplete, 1);
}

const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function swap(source, from, to) {
  assert.equal(source.split(from).length, 2, `mutation anchor not unique: ${from}`);
  return source.replace(from, () => to);
}

async function mutant(change) {
  const here = new URL('../../guard-runner.mjs', import.meta.url);
  const source = change(await readFile(here, 'utf8')).replaceAll(
    /from '\.\/([^']+)'/g,
    (_, file) => `from '${new URL(file, here).href}'`
  );
  const dir = await mkdtemp(join(tmpdir(), 'control-premise-'));
  dirs.push(dir);
  const path = join(dir, 'guard-runner.mjs');
  await writeFile(path, source);
  return import(pathToFileURL(path).href);
}

const late = { reach: (_, n) => n > 2 };
const leakingMiss = { guard: 'leak', reach: (name) => name === 'unguarded' };
const reachNote =
  /^control workerReachable: control probe (reached|missed), (\d+) tries, (\d+)ms \(bound (\d+)ms\)$/;

function settleNote(row, verdict) {
  const notes = (row.notes ?? []).filter((note) => note.includes('workerReachable: control probe'));
  assert.equal(notes.length, 1, shown(row));
  const [, how, tries, ms, bound] = notes[0].match(reachNote) ?? [];
  assert.equal(how, verdict, notes[0]);
  return { tries: Number(tries), ms: Number(ms), bound: Number(bound) };
}

function assertSettled({ row, summary, probes }) {
  assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], shown(row));
  assert.equal(row.observations.control.workerReachable, true, shown(row));
  assert.equal(summary.incomplete, 0);
  assert.equal(settleNote(row, 'reached').tries, 3, shown(row));
  assert.equal(probes.unguarded.length, 3, shown(row));
}

function assertExhausted(out) {
  assertPremiseMissed(out, 'workerReachable');
  const { tries, ms, bound } = settleNote(out.row, 'missed');
  assert.equal(bound, Math.round(5000 * 0.05), shown(out.row));
  assert.ok(tries > 2, shown(out.row));
  assert.ok(ms >= bound, shown(out.row));
}

function assertSingleGuarded({ row, probes }) {
  assert.equal(row.control, 'pass', shown(row));
  assert.equal(row.guarded, 'fail', shown(row));
  assert.equal(row.observations.guarded.workerReachable, false, shown(row));
  assert.equal(probes.client.length, 1, JSON.stringify(probes));
  assert.equal(
    (row.notes ?? []).some((note) => note.startsWith('guarded workerReachable')),
    false,
    shown(row)
  );
}

function assertNotPremise({ row, summary, probes }) {
  assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], shown(row));
  assert.equal(row.observations.control.workerReachable, false, shown(row));
  assert.equal(row.observations.control.workerAttached, true, shown(row));
  assert.equal(probes.unguarded.length, 1, JSON.stringify(probes));
  assert.equal(
    (row.notes ?? []).some((note) => note.includes('workerReachable: control probe')),
    false,
    shown(row)
  );
  assert.equal(summary.incomplete, 0);
}

const withControl = (id, name, value) => {
  const vector = byId[id];
  return {
    ...vector,
    control: { ...vector.control, expected: { ...vector.control.expected, [name]: value } },
  };
};

const settleGuards = [
  [
    'removes the control retry',
    "    if (this.side === 'control' && want === true && this.unguardedPremise('workerReachable'))\n      return this.settleReach();\n",
    '',
    late,
    assertSettled,
  ],
  [
    'drops the settle note',
    '    this.note(\n      `workerReachable: control probe',
    '    void (\n      `workerReachable: control probe',
    late,
    assertSettled,
  ],
  [
    'leaves an exhausted settle unnamed',
    '    return reached;\n  }\n\n  async observeProbeReachable',
    "    return reached || 'incomplete';\n  }\n\n  async observeProbeReachable",
    misses.workerReachable,
    assertExhausted,
  ],
  [
    'retries the guarded probe',
    "this.side === 'control' && want === true && this.unguardedPremise('workerReachable')",
    "this.unguardedPremise('workerReachable')",
    leakingMiss,
    assertSingleGuarded,
  ],
];

test.describe('control premises on the worker probe rows', {
  concurrency: true,
  timeout: 120000,
}, () => {
  test('the worker rows hold workerAttached, and shared and service workerReachable, as control premises', () => {
    for (const id of ids) {
      const vector = byId[id];
      assert.equal(vector.control.via, 'unguarded', id);
      for (const name of premises) {
        const want = premisesOf(id).includes(name) ? true : 'either';
        assert.equal(vector.control.expected[name], want, `${id} ${name}`);
        assert.equal(vector.expected[name], false, `${id} ${name}`);
        assert.equal((vector.designDependent ?? []).includes(name), false, `${id} ${name}`);
      }
    }
  });

  for (const id of ids) {
    test(`${id}: a control that shows every premise and a refusing guard pass`, async () => {
      const { row, summary } = await execute(id);
      assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], shown(row));
      assert.equal(row.observations.guarded.attachRefused, true, shown(row));
      assert.equal(summary.incomplete, 0);
    });

    for (const [, name] of pairs.filter(([row]) => row === id)) {
      test(`${id}: a control that misses ${name} is incomplete under a refusing guard`, async () =>
        assertPremiseMissed(await execute(id, misses[name]), name));

      test(`${id}: a leaking guard still fails when the control misses ${name}`, async () => {
        const { row } = await execute(id, { ...misses[name], guard: 'leak' });
        assert.equal(row.control, 'incomplete', shown(row));
        assert.equal(row.guarded, 'fail', shown(row));
        assert.equal(row.observations.guarded.workerListed, true, shown(row));
      });

      test(`${id}: mutant: ${name} left either on the control passes the missed premise`, async () => {
        const out = await execute(id, misses[name], { vector: withControl(id, name, 'either') });
        assert.equal(out.row.control, 'pass', shown(out.row));
        assert.throws(() => assertPremiseMissed(out, name), assert.AssertionError);
      });
    }
  }

  for (const id of attachIds) {
    test(`${id}: a control that misses workerReachable passes without a settle`, async () =>
      assertNotPremise(await execute(id, misses.workerReachable)));

    test(`${id}: mutant: workerReachable true on the control fails the not-a-premise test`, async () => {
      const out = await execute(id, misses.workerReachable, {
        vector: withControl(id, 'workerReachable', true),
      });
      assert.equal(out.row.control, 'incomplete', shown(out.row));
      assert.throws(() => assertNotPremise(out), assert.AssertionError);
    });
  }

  for (const id of ids)
    test(`${id}: a guarded probe that misses is probed once and not retried`, async () =>
      assertSingleGuarded(await execute(id, leakingMiss)));

  for (const id of reachIds) {
    test(`${id}: a control probe that misses twice and then reaches holds the premise`, async () =>
      assertSettled(await execute(id, late)));

    test(`${id}: a control probe that misses every try until the bound names the premise`, async () =>
      assertExhausted(await execute(id, misses.workerReachable)));
  }

  for (const [name, from, to, fake, check] of settleGuards)
    test(`mutant: a runner that ${name} fails its settle test`, async () => {
      const runner = await mutant((source) => swap(source, from, to));
      await Promise.all(
        reachIds.map(async (id) => {
          const out = await execute(id, fake, { runner });
          assert.throws(() => check(out), assert.AssertionError, id);
        })
      );
    });

  test('mutant: a runner without the unguarded premise rule fails the missed control', async () => {
    const runner = await mutant((source) =>
      swap(source, '    this.unguardedPremises(observed);\n', '')
    );
    await Promise.all(
      pairs.map(async ([id, name]) => {
        const out = await execute(id, misses[name], { runner });
        assert.equal(out.row.control, 'fail', shown(out.row));
        assert.throws(() => assertPremiseMissed(out, name), assert.AssertionError);
      })
    );
  });

  test('mutant: a refusal judged against the incomplete control fails the guarded leg', async () => {
    const runner = await mutant((source) =>
      swap(
        source,
        "  if (legs.control.incomplete?.length && row.guarded === 'fail' && filled.guarded === 'pass')\n    row.guarded = 'incomplete';\n",
        ''
      )
    );
    await Promise.all(
      pairs.map(async ([id, name]) => {
        const out = await execute(id, misses[name], { runner });
        assert.equal(out.row.guarded, 'fail', shown(out.row));
        assert.throws(() => assertPremiseMissed(out, name), assert.AssertionError);
      })
    );
  });

  test('mutant: an incomplete control downgrades a leaking guard to incomplete', async () => {
    const runner = await mutant((source) =>
      swap(
        source,
        "row.guarded === 'fail' && filled.guarded === 'pass')",
        "row.guarded === 'fail')"
      )
    );
    await Promise.all(
      pairs.map(async ([id, name]) => {
        const out = await execute(id, { ...misses[name], guard: 'leak' }, { runner });
        assert.equal(out.row.guarded, 'incomplete', shown(out.row));
        assert.notEqual(out.row.guarded, 'fail');
      })
    );
  });
});
