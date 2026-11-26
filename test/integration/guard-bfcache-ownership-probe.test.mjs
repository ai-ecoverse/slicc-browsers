import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { run } from '../../guard-runner.mjs';
import { bfcacheClients } from './fixtures/bfcache-client.mjs';
import { bfcacheOwnershipClients } from './fixtures/bfcache-ownership-client.mjs';

const root = new URL('../../', import.meta.url);
const set = JSON.parse(await readFile(new URL('guard-vectors.json', root)));
const ids = ['C8.protected-bfcache-restore', 'C8.protected-bfcache-restore.history'];
const targets = {
  ordinary: 'http://ordinary.example.test:4811',
  seven: 'http://seven.sliccy.ai:4811',
};
const declared = { inboundDelay: true, forwardAudit: true, frameOwnershipProbe: true };
const undeclared = { inboundDelay: true, forwardAudit: true };
const exempt = /^guarded commandsUnforwarded: exempt:frameOwnershipProbe \((\d+) forwards\)$/;
const why = (row) => row.why ?? `${row.id}: no reason`;
const premise = 'guarded commandsUnforwarded: frameOwnershipProbe: command ledger unavailable';
const missing =
  'guarded bfcacheRestore: bfcache-restore: frameOwnershipProbe: command ledger unavailable';
const extending =
  'frameOwnershipProbe: command ledger unavailable (ledger does not extend the previous audit)';
const budget = 500;

async function rows(browser, capabilities = declared, runner = run, settleScale = 0.01) {
  const execution = await runner(
    {
      ...set,
      vectors: ids.map((id) => ({
        ...set.vectors.find((vector) => vector.id === id),
        targets: ['seven'],
      })),
      variants: { prompt: 0 },
    },
    { ...browser, capabilities, targets, fixture: { log: () => [] }, settleScale }
  );
  assert.equal(execution.results.length, 2);
  return execution.results;
}

const runs = new Map();
const once = (key, make) => {
  if (!runs.has(key)) runs.set(key, make());
  return runs.get(key);
};

const shape = (row) => ({
  id: row.id,
  control: row.control,
  guarded: row.guarded,
  live: row.live,
  observations: row.observations,
  notes: row.notes,
  incomplete: row.incomplete,
  errors: row.errors,
});

const withLedger = (browser, commands) => {
  const install = browser.client.inboundDelay;
  browser.client.inboundDelay = async (args) => {
    const gate = await install(args);
    return { ...gate, audit: async (options) => ({ ...(await gate.audit(options)), commands }) };
  };
  return browser;
};

const timed = (browser) => {
  const times = new Map();
  const install = browser.client.inboundDelay;
  browser.client.inboundDelay = async (args) => {
    const gate = await install(args);
    const entry = { side: args.side };
    times.set(args.sessionId, entry);
    return {
      ...gate,
      audit: async (options) => {
        const out = await gate.audit(options);
        if (options.final) entry.finalAt = Date.now();
        return out;
      },
      release: async () => {
        entry.releasedAt = Date.now();
        return gate.release();
      },
    };
  };
  for (const transport of [browser.client, browser.unguarded]) {
    const send = transport.send;
    transport.send = async (method, params, session) => {
      const entry = method === 'Target.detachFromTarget' ? times.get(params?.sessionId) : undefined;
      if (entry) entry.detachedAt ??= Date.now();
      return send(method, params, session);
    };
  }
  browser.times = times;
  return browser;
};

const ledgerOf = (row) => row.evidence.guarded.restore.delay.finalAudit.result.commands;
const previousOf = (row) => row.evidence.guarded.restore.delay.audit.result.commands;
const startOf = (row) => row.evidence.guarded.restore.delay.firstProbeAudit.result.commands;
const methodsOf = (commands) => commands.map((command) => command.method);

function passes(results) {
  for (const row of results) {
    assert.equal(row.control, 'pass', why(row));
    assert.equal(row.guarded, 'pass', why(row));
    assert.equal(row.live, 'pass', why(row));
    const seen = row.observations.guarded;
    assert.equal(seen.commandsUnforwarded, true);
    assert.equal(seen.probesRefusedOrUnforwarded, true);
    assert.equal(seen.markerHidden, true);
    assert.equal(seen.originHidden, true);
    assert.equal(seen.sideEffectAbsent, true);
    assert.equal(seen.probeRanInProtected, false);
    assert.equal(seen.touched, false);
    const note = row.notes.map((entry) => exempt.exec(entry)).find(Boolean);
    assert(note, JSON.stringify(row.notes));
    const reads = ledgerOf(row).filter((command) => command.method === 'DOM.getDocument');
    assert.equal(Number(note[1]), reads.length);
    const probes = row.evidence.guarded.restore.probes;
    const forwarded = probes.filter((probe) => probe.forwarded);
    assert(forwarded.length > 0);
    assert(forwarded.every((probe) => probe.method === 'DOM.getDocument'));
    assert(forwarded.every((probe) => probe.outcome === 'no answer'));
  }
}

const fails =
  (observation, value = false) =>
  (results) => {
    for (const row of results) {
      assert.equal(row.control, 'pass', why(row));
      assert.equal(row.guarded, 'fail', why(row));
      assert.equal(row.live, 'pass', why(row));
      assert.equal(row.observations.guarded[observation], value);
    }
  };

function incomplete(results) {
  for (const row of results) {
    assert.equal(row.control, 'pass', why(row));
    assert.equal(row.guarded, 'incomplete', why(row));
    assert.equal(row.live, 'pass', why(row));
    assert.equal(row.observations.guarded.commandsUnforwarded, 'incomplete');
    assert(row.incomplete.includes(premise), JSON.stringify(row.incomplete));
    assert(
      row.incomplete.some((entry) => entry.startsWith(missing)),
      JSON.stringify(row.incomplete)
    );
    assert(!row.notes?.some((entry) => exempt.test(entry)));
  }
}

const cases = {
  pair: {
    name: 'a declared guard forwarding only the permitted pair with the reply held passes',
    options: {},
    check: passes,
  },
  wholeDepth: {
    name: 'a forwarded DOM.getDocument with depth -1.0 on the wire is the permitted shape',
    options: { read: '{"depth":-1.0,"pierce":true}' },
    check: passes,
  },
  depthZero: {
    name: 'a forwarded DOM.getDocument with depth 0 fails',
    options: { read: '{"depth":0,"pierce":true}' },
    check: fails('commandsUnforwarded'),
  },
  depthTwo: {
    name: 'a forwarded DOM.getDocument with depth -2 fails',
    options: { read: '{"depth":-2,"pierce":true}' },
    check: fails('commandsUnforwarded'),
  },
  pierceFalse: {
    name: 'a forwarded DOM.getDocument with pierce false fails',
    options: { read: '{"depth":-1,"pierce":false}' },
    check: fails('commandsUnforwarded'),
  },
  pierceMissing: {
    name: 'a forwarded DOM.getDocument without pierce fails',
    options: { read: '{"depth":-1}' },
    check: fails('commandsUnforwarded'),
  },
  extraKey: {
    name: 'a forwarded DOM.getDocument with an extra key fails',
    options: { read: '{"depth":-1,"pierce":true,"nodeId":1}' },
    check: fails('commandsUnforwarded'),
  },
  evaluate: {
    name: 'a declared guard that also forwards Runtime.evaluate fails',
    options: { forward: ['Runtime.evaluate'] },
    check: fails('commandsUnforwarded'),
  },
  tree: {
    name: 'a declared guard that also forwards Accessibility.getFullAXTree fails',
    options: { forward: ['Accessibility.getFullAXTree'] },
    check: fails('commandsUnforwarded'),
  },
  screenshot: {
    name: 'a declared guard that also forwards Page.captureScreenshot fails',
    options: { forward: ['Page.captureScreenshot'] },
    check: fails('commandsUnforwarded'),
  },
  releaseFirst: {
    name: 'a DOM.disable before the first DOM.getDocument fails',
    options: { releaseFirst: true },
    check: fails('commandsUnforwarded'),
  },
  releaseParams: {
    name: 'a DOM.disable with params fails',
    options: { releaseParams: { nodeId: 1 } },
    check: fails('commandsUnforwarded'),
  },
  releaseEmpty: {
    name: 'a DOM.disable with an empty params object is the permitted shape',
    options: { releaseParams: {} },
    check: passes,
  },
  extra: {
    name: 'a DOM.enable in the ledger fails',
    options: { extra: 'DOM.enable' },
    check: fails('commandsUnforwarded'),
  },
  before: {
    name: 'a history trigger and a DOM.enable forwarded before the first probe are the scenario and pass',
    options: { trigger: 'forward', before: ['DOM.enable'] },
    check: (results) => {
      passes(results);
      const [restore, history] = results;
      assert.equal(history.evidence.guarded.restore.triggerPath, 'client');
      assert.deepEqual(methodsOf(startOf(restore)), ['DOM.enable']);
      assert.deepEqual(methodsOf(startOf(history)), ['DOM.enable', 'Page.navigateToHistoryEntry']);
      for (const row of results)
        assert.deepEqual(ledgerOf(row).slice(0, startOf(row).length), startOf(row));
    },
  },
  after: {
    name: 'a history navigation and a DOM.enable forwarded after the first probe fail',
    options: { after: ['Page.navigateToHistoryEntry', 'DOM.enable'] },
    check: (results) => {
      fails('commandsUnforwarded')(results);
      for (const row of results) {
        assert.deepEqual(startOf(row), []);
        const methods = methodsOf(ledgerOf(row));
        assert(methods.includes('Page.navigateToHistoryEntry'), JSON.stringify(methods));
        assert(methods.includes('DOM.enable'), JSON.stringify(methods));
      }
    },
  },
  restart: {
    name: 'a command ledger that does not start with the one audited before the first probe is incomplete',
    options: { before: ['DOM.enable'], ledger: 'restart' },
    check: incomplete,
  },
  truncate: {
    name: 'a final command ledger that omits a permitted pair the previous audit listed is incomplete',
    options: { ledger: 'truncate' },
    check: (results) => {
      incomplete(results);
      for (const row of results) {
        assert.equal(previousOf(row).length, ledgerOf(row).length + 2);
        assert(
          row.incomplete.some((entry) => entry.includes(extending)),
          JSON.stringify(row.incomplete)
        );
      }
    },
  },
  rewrite: {
    name: 'a final command ledger that rewrites an entry the previous audit listed is incomplete',
    options: { ledger: 'rewrite' },
    check: (results) => {
      incomplete(results);
      for (const row of results) {
        assert.equal(previousOf(row).length, ledgerOf(row).length);
        assert.notDeepEqual(ledgerOf(row), previousOf(row));
        assert(
          row.incomplete.some((entry) => entry.includes(extending)),
          JSON.stringify(row.incomplete)
        );
      }
    },
  },
  extend: {
    name: 'a final command ledger that extends the previous audit with a further permitted pair passes',
    options: { ledger: 'extend' },
    check: (results) => {
      passes(results);
      for (const row of results) {
        assert.deepEqual(ledgerOf(row).slice(0, previousOf(row).length), previousOf(row));
        assert.deepEqual(methodsOf(ledgerOf(row).slice(previousOf(row).length)), [
          'DOM.getDocument',
          'DOM.disable',
        ]);
      }
    },
  },
  grace: {
    name: 'a held DOM.getDocument reply delivered inside the grace period fails',
    options: { late: 'grace' },
    scale: budget / 5000,
    check: (results) => {
      fails('markerHidden')(results);
      fails('probesRefusedOrUnforwarded')(results);
      for (const row of results) {
        assert.equal(row.observations.guarded.originHidden, true);
        assert(row.evidence.guarded.restore.grace.late > 0);
      }
    },
  },
  graceOrigin: {
    name: 'a held DOM.getDocument reply carrying the origin delivered inside the grace period fails',
    options: { late: 'grace', lateReply: 'origin' },
    scale: budget / 5000,
    check: (results) => {
      fails('originHidden')(results);
      fails('markerHidden')(results);
      fails('probesRefusedOrUnforwarded')(results);
    },
  },
  detach: {
    name: 'a held DOM.getDocument reply delivered after the grace period is not observable',
    options: { late: 'detach' },
    scale: budget / 5000,
    check: async (results) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const row of results) {
        assert.equal(row.control, 'pass', why(row));
        assert.equal(row.guarded, 'pass', why(row));
        assert.equal(row.live, 'pass', why(row));
        assert.equal(row.observations.guarded.markerHidden, true);
        assert.equal(row.observations.guarded.probesRefusedOrUnforwarded, true);
        const { grace, probes } = row.evidence.guarded.restore;
        assert.equal(grace.late, 0);
        const reads = probes.filter((probe) => probe.forwarded);
        assert(reads.length > 0);
        assert(reads.every((probe) => probe.answeredAt !== undefined));
      }
    },
  },
  marker: {
    name: 'a delivered DOM.getDocument reply carrying the marker fails',
    options: { deliver: 'marker' },
    check: (results) => {
      fails('markerHidden')(results);
      fails('probesRefusedOrUnforwarded')(results);
    },
  },
  origin: {
    name: 'a delivered DOM.getDocument reply carrying the origin fails',
    options: { deliver: 'origin' },
    check: (results) => {
      fails('originHidden')(results);
      fails('probesRefusedOrUnforwarded')(results);
    },
  },
  absent: {
    name: 'a declared guard without a command ledger is incomplete',
    options: { ledger: 'missing' },
    check: incomplete,
  },
  partial: {
    name: 'a declared guard with a partial command ledger is incomplete',
    options: { ledger: 'partial' },
    check: incomplete,
  },
  touch: {
    name: 'a forwarded DOM.getDocument that leaves a side effect fails',
    options: { touch: true },
    check: (results) => {
      fails('sideEffectAbsent')(results);
      fails('touched', true)(results);
    },
  },
  elsewhere: {
    name: 'a probe that runs in the protected document outside the ledgered session fails',
    options: { elsewhere: ['Runtime.evaluate'] },
    check: (results) => {
      fails('probeRanInProtected', true)(results);
      fails('markerHidden')(results);
      fails('commandsUnforwarded', true)(results);
    },
  },
};

const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function swap(source, from, to) {
  assert.equal(source.split(from).length, 2, `mutation anchor not unique: ${from}`);
  return source.replace(from, () => to);
}

async function mutant(from, to) {
  const dir = await mkdtemp(join(tmpdir(), 'ownership-probe-'));
  dirs.push(dir);
  const absolute = (source, keep) =>
    source.replaceAll(/from '\.\/([^']+)'/g, (whole, file) =>
      file === keep ? whole : `from '${new URL(file, root).href}'`
    );
  const restore = await readFile(new URL('bfcache-restore.mjs', root), 'utf8');
  const runner = await readFile(new URL('guard-runner.mjs', root), 'utf8');
  await writeFile(join(dir, 'bfcache-restore.mjs'), absolute(swap(restore, from, to)));
  await writeFile(join(dir, 'guard-runner.mjs'), absolute(runner, 'bfcache-restore.mjs'));
  return (await import(pathToFileURL(join(dir, 'guard-runner.mjs')).href)).run;
}

const ledger = 'const commands = audit.result?.commands;';
const firstProbe = 'commands.slice(start.length)';
const mutants = [
  {
    name: 'accepts any DOM.getDocument params',
    from: ' &&\n  plain(command.params) &&\n  Object.keys(command.params).length === 2 &&\n  command.params.depth === -1 &&\n  command.params.pierce === true;',
    to: ';',
    against: ['depthZero', 'depthTwo', 'pierceFalse', 'pierceMissing', 'extraKey'],
  },
  {
    name: 'ignores the command ledger',
    from: ledger,
    to: 'const commands = this.result.probes.filter((probe) => probe.forwarded === true);',
    against: [
      'depthZero',
      'releaseFirst',
      'releaseParams',
      'extra',
      'absent',
      'partial',
      'restart',
    ],
  },
  {
    name: 'trusts a guard-reported list instead of the harness ledger',
    from: ledger,
    to: 'const commands = this.client.commands;',
    against: ['extra', 'absent'],
  },
  {
    name: 'judges the ledger from the start of the hold',
    from: firstProbe,
    to: 'commands',
    against: ['before'],
    verdict: 'fail',
  },
  {
    name: 'judges the ledger only up to the first probe',
    from: firstProbe,
    to: 'commands.slice(0, start.length)',
    against: ['after'],
    verdict: 'incomplete',
  },
  {
    name: 'checks each ledger only against the one audited before the first probe',
    from: 'const previous = this.lastLedger;',
    to: 'const previous = this.firstProbeLedger;',
    against: ['truncate', 'rewrite'],
  },
  {
    name: 'does not check held replies before detaching',
    from: '        if (this.ownershipExempt && this.grace) await this.late();\n',
    to: '',
    against: ['grace', 'graceOrigin'],
  },
];

test.describe('frameOwnershipProbe on the history restore rows', {
  concurrency: true,
  timeout: 120000,
}, () => {
  for (const [key, { name, options, scale, check }] of Object.entries(cases))
    test(name, async () =>
      check(await once(key, () => rows(bfcacheOwnershipClients(options), declared, run, scale)))
    );

  test('a declared guard that forwards nothing still needs the command ledger', async () => {
    incomplete(await rows(bfcacheClients({ guard: 'refuse' })));
  });

  test('an undeclared guard forwarding the permitted pair fails as before', async () => {
    const results = await once('undeclared', () => rows(bfcacheOwnershipClients(), undeclared));
    for (const row of results) {
      assert.equal(row.control, 'pass', why(row));
      assert.equal(row.guarded, 'fail', why(row));
      assert.equal(row.live, 'pass', why(row));
      assert.match(row.why, /commandsUnforwarded: got false, want true/);
      const seen = row.observations.guarded;
      assert.equal(seen.commandsUnforwarded, false);
      for (const name of [
        'markerHidden',
        'originHidden',
        'sideEffectAbsent',
        'probesRefusedOrUnforwarded',
        'restoredObserved',
        'sessionLive',
      ])
        assert.equal(seen[name], true, name);
      assert(!row.notes?.some((entry) => entry.includes('frameOwnershipProbe')));
      assert.equal(row.evidence.guarded.restore.skips, undefined);
    }
  });

  test('an undeclared guard is judged without its command ledger', async () => {
    const [refusing, refusingLedger, forwarding, forwardingLedger] = await Promise.all([
      rows(bfcacheClients({ guard: 'refuse' }), undeclared),
      rows(withLedger(bfcacheClients({ guard: 'refuse' }), [{ method: 'DOM.enable' }]), undeclared),
      rows(bfcacheOwnershipClients({ ledger: 'missing' }), undeclared),
      once('undeclared', () => rows(bfcacheOwnershipClients(), undeclared)),
    ]);
    assert.deepEqual(refusingLedger.map(shape), refusing.map(shape));
    assert.deepEqual(forwardingLedger.map(shape), forwarding.map(shape));
    for (const row of refusing) {
      assert.equal(row.guarded, 'pass', why(row));
      assert.equal(row.observations.guarded.commandsUnforwarded, true);
      assert(!row.notes?.some((entry) => entry.includes('frameOwnershipProbe')));
      assert.equal(row.evidence.guarded.restore.skips, undefined);
    }
    for (const row of forwarding) assert.equal(row.guarded, 'fail', why(row));
  });

  test('without forwardAudit the declaration changes nothing', async () => {
    const [without, declaring] = await Promise.all([
      rows(bfcacheOwnershipClients(), { inboundDelay: true }),
      rows(bfcacheOwnershipClients(), { inboundDelay: true, frameOwnershipProbe: true }),
    ]);
    assert.deepEqual(declaring.map(shape), without.map(shape));
    for (const row of declaring) {
      assert.equal(row.observations.guarded.commandsUnforwarded, 'not-supported');
      assert(!row.notes?.some((entry) => entry.includes('frameOwnershipProbe')));
    }
  });

  test('the control leg is the same with or without the declaration', async () => {
    const [on, off] = await Promise.all([
      once('pair', () => rows(bfcacheOwnershipClients())),
      once('undeclared', () => rows(bfcacheOwnershipClients(), undeclared)),
    ]);
    for (const [index, row] of on.entries()) {
      assert.equal(row.control, 'pass', why(row));
      assert.deepEqual(row.observations.control, off[index].observations.control);
      assert.deepEqual(
        row.notes.filter((entry) => entry.startsWith('control ')),
        off[index].notes.filter((entry) => entry.startsWith('control '))
      );
      assert.equal(row.evidence.control.restore.commandsUnforwarded, false);
      assert.equal(row.evidence.control.restore.skips, undefined);
    }
  });

  for (const { name, from, to, against, verdict = 'pass' } of mutants)
    for (const key of against)
      test(`mutant: a runner that ${name} fails "${cases[key].name}"`, async () => {
        const results = await rows(
          bfcacheOwnershipClients(cases[key].options),
          declared,
          await mutant(from, to),
          cases[key].scale
        );
        for (const row of results) assert.equal(row.guarded, verdict, why(row));
        assert.throws(() => cases[key].check(results), assert.AssertionError);
      });
});

const timedRuns = () =>
  once('timed', () => {
    const on = timed(bfcacheOwnershipClients());
    const off = timed(bfcacheOwnershipClients());
    return Promise.all([
      rows(on, declared, run, budget / 5000).then((results) => ({ results, times: on.times })),
      rows(off, undeclared, run, budget / 5000).then((results) => ({ results, times: off.times })),
    ]);
  });

test('a declared guard that never delivers a held reply passes after a grace period inside its settle budget', async () => {
  const [{ results, times }] = await timedRuns();
  passes(results);
  for (const row of results) {
    const { grace } = row.evidence.guarded.restore;
    assert.equal(grace.late, 0);
    assert(grace.ms > 0 && grace.ms <= 400, JSON.stringify(grace));
  }
  const guarded = [...times.values()].filter((entry) => entry.side !== 'control');
  assert.equal(guarded.length, 2);
  for (const entry of guarded) {
    assert(entry.detachedAt - entry.finalAt >= 200, JSON.stringify(entry));
    assert(entry.detachedAt - entry.releasedAt < budget + 100, JSON.stringify(entry));
  }
});

test('undeclared guards and the control leg spend no grace period', async () => {
  const [on, off] = await timedRuns();
  for (const row of on.results) assert.equal(row.evidence.control.restore.grace, undefined);
  for (const row of off.results) {
    assert.equal(row.evidence.control.restore.grace, undefined);
    assert.equal(row.evidence.guarded.restore.grace, undefined);
  }
  const idle = [
    ...[...on.times.values()].filter((entry) => entry.side === 'control'),
    ...off.times.values(),
  ];
  assert.equal(idle.length, 6);
  for (const entry of idle) assert(entry.detachedAt - entry.finalAt < 100, JSON.stringify(entry));
  for (const entry of off.times.values())
    if (entry.side !== 'control')
      assert(entry.detachedAt - entry.releasedAt >= budget, JSON.stringify(entry));
});
