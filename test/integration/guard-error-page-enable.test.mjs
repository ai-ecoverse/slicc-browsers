import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { fixtureServer } from '../../fixture-server.mjs';
import * as real from '../../guard-runner.mjs';
import { chrome, quarantining } from './error-page-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vectors = set.vectors.filter((v) => v.trigger.some((s) => s.errorPage));
const recover = 'C8.protected-error-page';
const steps = ['Page.enable', 'Runtime.enable', 'Target.setDiscoverTargets'];
const refusal = (method) =>
  new Error(
    `slicc: refused: ${method} at http://seven.sliccy.ai/doc?n=x sid=secret-value ${'y'.repeat(400)}`
  );
const bounded = (method) =>
  `slicc: refused: ${method} at <url> sid=<value> ${'y'.repeat(400)}`.slice(0, 200);
const failure = (method) => new Error(`${method} dropped after slicc: refused: ${method}`);
const sessionless = (method) => method === 'Target.setDiscoverTargets';

const guardedAt = (step, error) => (method, tab, quarantined) =>
  method === step && (sessionless(method) || (tab && quarantined(tab))) ? error : undefined;

function controlAt(conn, step, error) {
  const attaches = new Map();
  const send = conn.send;
  let armed;
  conn.send = async (method, params = {}, sessionId) => {
    if (armed && method === step && (sessionless(method) || sessionId === armed)) {
      armed = undefined;
      throw error;
    }
    const out = await send(method, params, sessionId);
    if (method === 'Target.attachToTarget') {
      const count = (attaches.get(params.targetId) ?? 0) + 1;
      attaches.set(params.targetId, count);
      if (count === 2) armed = out.sessionId;
    }
    return out;
  };
  return conn;
}

async function rows(
  ids,
  { options, control, runner = real, capabilities = { discovery: true }, fixture } = {}
) {
  const own = fixture ?? (await fixtureServer());
  try {
    const browser = chrome();
    const unguarded = browser.connect();
    const origin = (host) => `http://${host}:${own.port}`;
    const execution = await runner.run(
      { ...set, vectors: vectors.filter((v) => ids.includes(v.id)), variants: { prompt: 0 } },
      {
        client: quarantining(browser, options),
        unguarded: control ? control(unguarded) : unguarded,
        fixture: own,
        settleScale: 0.1,
        capabilities,
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    return execution.results;
  } finally {
    if (!fixture) await own.close();
  }
}

const shown = (row) => JSON.stringify(row);
const verdict = (row) => ({
  control: row.control,
  guarded: row.guarded,
  live: row.live,
  observations: row.observations,
  errors: row.errors,
  incomplete: row.incomplete,
});
const stable = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .replace(/guard-\d+-\d+-\d+-(control|guarded)-[a-z0-9]+/g, 'guard-<tag>-$1')
      .replace(/"elapsedMs":\d+/g, '"elapsedMs":0')
      .replace(/\b([LRST])\d+\b/g, '$1<n>')
  );

const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function swap(source, from, to) {
  assert.equal(source.split(from).length, 2, `mutation anchor not unique: ${from}`);
  return source.replace(from, () => to);
}

const linked = (source, here, local = []) =>
  source.replaceAll(
    /from '\.\/([^']+)'/g,
    (_, file) => `from '${local.includes(file) ? `./${file}` : new URL(file, here).href}'`
  );

async function mutant(from, to) {
  const pageFile = new URL('../../protected-error-page.mjs', import.meta.url);
  const runnerFile = new URL('../../guard-runner.mjs', import.meta.url);
  const dir = await mkdtemp(join(tmpdir(), 'error-page-enable-'));
  dirs.push(dir);
  const page = swap(await readFile(pageFile, 'utf8'), from, to);
  await writeFile(join(dir, 'protected-error-page.mjs'), linked(page, pageFile));
  await writeFile(
    join(dir, 'guard-runner.mjs'),
    linked(await readFile(runnerFile, 'utf8'), runnerFile, ['protected-error-page.mjs'])
  );
  return import(pathToFileURL(join(dir, 'guard-runner.mjs')).href);
}

const wrapped =
  'const out = await outcome(client.send(method, ...args));\n    if (out.ok) continue;';
const unwrapped = 'await client.send(method, ...args);\n    continue;';
const before = mutant(wrapped, unwrapped);

const cases = {
  guarded: {
    name: 'a guarded refusal is not live and scored as a refused attach',
    run: async (step, runner) => {
      const fixture = await fixtureServer();
      try {
        const [row] = await rows([recover], {
          options: { reject: guardedAt(step, refusal(step)) },
          runner,
          fixture,
        });
        const [attach] = await rows([recover], {
          options: { refuseAttach: (tab, quarantined) => quarantined(tab) },
          fixture,
        });
        return { row, attach };
      } finally {
        await fixture.close();
      }
    },
    check: ({ row, attach }, step) => {
      assert.equal(row.control, 'pass', shown(row));
      assert.equal(row.guarded, 'fail', shown(row));
      assert.equal(row.live, 'fail', shown(row));
      assert.deepEqual(row.errors, [], shown(row));
      assert.equal(row.incomplete, undefined, shown(row));
      assert.equal(row.observations.guarded.live, false, shown(row));
      assert.equal(row.observations.guarded.attached, false, shown(row));
      assert(row.why.endsWith(`not live: ${step} refused: ${bounded(step)}`), row.why);
      assert.equal(row.why.includes('secret-value'), false, row.why);
      assert.deepEqual(row.evidence.guarded.errorPage.clientAttach, {
        outcome: 'answered',
        sessionId: true,
      });
      assert.deepEqual(verdict(row), verdict(attach));
    },
  },
  control: {
    name: 'a control refusal is incomplete naming the step',
    run: async (step, runner) => {
      const [row] = await rows([recover], {
        control: (conn) => controlAt(conn, step, refusal(step)),
        runner,
      });
      return { row };
    },
    check: ({ row }, step) => {
      assert.equal(row.control, 'incomplete', shown(row));
      assert.equal(row.guarded, 'pass', shown(row));
      assert.equal(row.live, 'pass', shown(row));
      assert.deepEqual(row.errors, [], shown(row));
      assert.deepEqual(row.incomplete, [
        `control errorPage: protected-error-page: ${step} refused on the control leg: ${bounded(step)}`,
      ]);
      assert.equal(row.observations.control.live, 'incomplete', shown(row));
    },
  },
  failure: {
    name: 'a failure without a refusal stays the row error it was',
    run: async (step, runner) => {
      const fixture = await fixtureServer();
      try {
        const legs = {};
        for (const [side, choose] of [
          ['guarded', (error) => ({ options: { reject: guardedAt(step, error) } })],
          ['control', (error) => ({ control: (conn) => controlAt(conn, step, error) })],
        ]) {
          const [row] = await rows([recover], { ...choose(failure(step)), runner, fixture });
          const [today] = await rows([recover], {
            ...choose(failure(step)),
            runner: await before,
            fixture,
          });
          legs[side] = { row, today };
        }
        return legs;
      } finally {
        await fixture.close();
      }
    },
    check: (legs, step) => {
      for (const [side, { row, today }] of Object.entries(legs)) {
        assert.equal(row.control, side === 'control' ? 'fail' : 'pass', shown(row));
        assert.equal(row.guarded, 'fail', shown(row));
        assert.deepEqual(row.errors, [`errorPage: ${failure(step).message}`], shown(row));
        assert.deepEqual(row.errorLegs, [side], shown(row));
        assert.equal(row.incomplete, undefined, shown(row));
        assert.deepEqual(stable(row), stable(today));
      }
    },
  },
  leak: {
    name: 'a guarded refusal on a leg that exposes the failed URL still fails',
    run: async (step, runner) => {
      const [row] = await rows([recover], {
        options: { exposeURL: true, reject: guardedAt(step, refusal(step)) },
        runner,
      });
      return { row };
    },
    check: ({ row }, step) => {
      assert.equal(row.control, 'pass', shown(row));
      assert.equal(row.guarded, 'fail', shown(row));
      assert.equal(row.live, 'fail', shown(row));
      assert.deepEqual(row.errors, [], shown(row));
      assert.equal(row.incomplete, undefined, shown(row));
      assert(row.why.endsWith(`not live: ${step} refused: ${bounded(step)}`), row.why);
    },
  },
};

for (const step of steps)
  for (const kase of Object.values(cases))
    test(`${step}: ${kase.name}`, async () => kase.check(await kase.run(step), step));

for (const step of steps)
  test(`${step}: a guarded refusal is no row error, and control reads what it measured either way`, async () => {
    const fixture = await fixtureServer();
    try {
      const options = { reject: guardedAt(step, refusal(step)) };
      const [row] = await rows([recover], { options, fixture });
      const [today] = await rows([recover], { options, runner: await before, fixture });
      assert.deepEqual(
        [today.control, today.guarded, today.errors, today.errorLegs],
        ['pass', 'fail', [`errorPage: ${refusal(step).message}`], ['guarded']],
        shown(today)
      );
      assert.deepEqual(
        [row.control, row.guarded, row.errors, row.errorLegs],
        ['pass', 'fail', [], undefined],
        shown(row)
      );
    } finally {
      await fixture.close();
    }
  });

test('a guarded leg that exposes the failed URL without a refusal fails as it did', async () => {
  const fixture = await fixtureServer();
  try {
    const ids = vectors.map((v) => v.id);
    const now = await rows(ids, { options: { exposeURL: true }, fixture });
    const today = await rows(ids, { options: { exposeURL: true }, runner: await before, fixture });
    assert.equal(now.length, 7);
    for (const row of now) {
      assert.equal(row.control, 'pass', shown(row));
      assert.equal(row.guarded, 'fail', shown(row));
      assert.equal(row.live, 'pass', shown(row));
      assert.equal(row.observations.guarded.infoRedacted, false, shown(row));
    }
    assert.deepEqual(stable(now), stable(today));
  } finally {
    await fixture.close();
  }
});

for (const [name, capabilities] of [
  ['with discovery', { discovery: true }],
  ['without discovery', {}],
])
  test(`with nothing refused every error-page row is unchanged ${name}`, async () => {
    const fixture = await fixtureServer();
    try {
      const ids = vectors.map((v) => v.id);
      const now = await rows(ids, { capabilities, fixture });
      const today = await rows(ids, { capabilities, runner: await before, fixture });
      assert.equal(now.length, 7);
      for (const row of now)
        assert.deepEqual(
          [row.control, row.guarded, row.live],
          ['pass', 'pass', 'pass'],
          shown(row)
        );
      assert.deepEqual(stable(now), stable(today));
    } finally {
      await fixture.close();
    }
  });

const mutants = [
  {
    name: 'swallows a guarded refusal as a pass',
    from: 'if (out.ok) continue;',
    to: "if (out.ok || side === 'guarded') continue;",
    against: 'guarded',
    shows: ({ row }) => assert.equal(row.guarded, 'pass', shown(row)),
  },
  {
    name: 'settles a refusal on a leaking guarded leg as clean',
    from: ': notLive(result, `${method} refused: ${why}`),',
    to: ': missing(`${method} refused: ${why}`),',
    against: 'leak',
    shows: ({ row }) => assert.equal(row.guarded, 'incomplete', shown(row)),
  },
  {
    name: 'passes a control refusal of Page.enable or Runtime.enable (a swallowed Target.setDiscoverTargets refusal reads as fail)',
    from: 'if (out.ok) continue;',
    to: "if (out.ok || side === 'control') continue;",
    against: 'control',
    only: ['Page.enable', 'Runtime.enable'],
    shows: ({ row }) => assert.equal(row.control, 'pass', shown(row)),
  },
  {
    name: 'reads a refusal by substring',
    from: 'if (!protectedRefusal(out))',
    to: 'if (!/slicc: refused/.test(out.error.message))',
    against: 'failure',
    shows: (legs) => assert.deepEqual(legs.guarded.row.errors, [], shown(legs.guarded.row)),
  },
  {
    name: 'treats a failure without a refusal as one',
    from: 'if (!protectedRefusal(out))',
    to: 'if (false)',
    against: 'failure',
    shows: (legs) => assert.deepEqual(legs.control.row.errors, [], shown(legs.control.row)),
  },
];

for (const { name, from, to, against, only = steps, shows } of mutants)
  test(`mutant: a probe that ${name} fails "${cases[against].name}"`, async () => {
    const runner = await mutant(from, to);
    const kase = cases[against];
    await Promise.all(
      only.map(async (step) => {
        const out = await kase.run(step, runner);
        shows(out);
        assert.throws(() => kase.check(out, step), assert.AssertionError, step);
      })
    );
  });
