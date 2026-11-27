import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { summary } from '../../guard-driver.mjs';

const here = new URL('../../guard-runner.mjs', import.meta.url);
const source = await readFile(here, 'utf8');
const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function swap(text, from, to) {
  assert.equal(text.split(from).length, 2, `mutation anchor not unique: ${from}`);
  return text.replace(from, () => to);
}

async function finisher(swaps = []) {
  const text = swaps
    .reduce((acc, [from, to]) => swap(acc, from, to), source)
    .replaceAll(/from '\.\/([^']+)'/g, (_, file) => `from '${new URL(file, here).href}'`);
  const dir = await mkdtemp(join(tmpdir(), 'error-legs-'));
  dirs.push(dir);
  const path = join(dir, 'guard-runner.mjs');
  await writeFile(path, `${text}\nexport { finishRow };\n`);
  return (await import(pathToFileURL(path).href)).finishRow;
}

const legsLine = '    ...(errorLegs.length ? { errorLegs } : {}),\n';
const errorsLine = 'errors: [...legs.control.errors, ...legs.guarded.errors],';
const controlLine = "if (legs.control.errors.length) row.control = 'fail';";
const guardedLine = "if (row.errors.length) row.guarded = 'fail';";
const settleStop = '  if (legs.control.errors.length) return;\n  const fill';
const settleGuarded = '  if (legs.guarded.errors.length) return;\n';

const before = finisher([
  [legsLine, ''],
  [
    `  ${controlLine}\n  ${guardedLine}\n`,
    "  if (row.errors.length) {\n    row.control = 'fail';\n    row.guarded = 'fail';\n  }\n",
  ],
  [settleStop, '  if (row.errors.length) return;\n  const fill'],
  [settleGuarded, ''],
]);
const current = finisher();

const vector = {
  id: 'X.error-legs',
  kind: 'cdp',
  scope: 'any',
  targets: ['seven'],
  setup: [],
  trigger: [],
  observe: { reached: { check: { result: 'probe', path: 'result.value', equals: true } } },
  liveCheck: { result: 'probe', path: 'result.live', equals: true },
  control: { origin: 'ordinary', via: 'guard', expected: { reached: true } },
  expected: { reached: false },
};
const set = { setVersion: '0.0.0', schemaVersion: 1, vectors: [vector], variants: { prompt: 0 } };
const base = {
  id: vector.id,
  target: 'seven',
  variant: 'prompt',
  transport: 'cdp',
  via: 'guard',
  transportVariant: false,
};
const opts = { capabilities: {} };

const controls = {
  pass: { observed: { reached: true } },
  fail: { observed: { reached: false } },
  incomplete: { observed: { reached: 'incomplete' }, incomplete: ['probe: no answer'] },
};
const guardeds = {
  refused: { observed: { reached: false } },
  leak: { observed: { reached: true } },
  dead: { observed: { reached: false }, live: false, liveWhy: 'target gone' },
  incomplete: {
    observed: { reached: 'incomplete' },
    live: 'incomplete',
    liveWhy: 'incomplete',
    incomplete: ['probe: no answer'],
  },
};
const failures = {
  control: ['control boom', 'control again'],
  guarded: ['guarded boom', 'guarded again'],
};

const leg = (shape, errors) => ({
  live: true,
  errors: [...errors],
  notes: [],
  incomplete: [],
  calls: {},
  evidence: {},
  ...structuredClone(shape),
});

function legs(control, guarded, erred) {
  return {
    control: leg(controls[control], erred.includes('control') ? failures.control : []),
    guarded: leg(guardeds[guarded], erred.includes('guarded') ? failures.guarded : []),
  };
}

const combos = Object.keys(controls).flatMap((control) =>
  Object.keys(guardeds).map((guarded) => ({ control, guarded }))
);
const shown = (row) => JSON.stringify(row);
const without = (row) =>
  JSON.stringify(row, (key, value) => (key === 'errorLegs' ? undefined : value));
const passes = (row) => summary({ guard: 'g', sha: 's', set, results: [row] }).pass;

async function rows(erred, finish, past) {
  const finishNow = await finish;
  const finishBefore = await past;
  const clean = await current;
  return combos.map(({ control, guarded }) => ({
    control,
    guarded,
    row: finishNow(vector, base, legs(control, guarded, erred), opts),
    today: finishBefore(vector, base, legs(control, guarded, erred), opts),
    measured: clean(vector, base, legs(control, guarded, []), opts),
  }));
}

function flatErrors(row, erred) {
  const want = erred.flatMap((side) => failures[side]);
  assert.deepEqual(row.errors, want, shown(row));
}

function placed(row, erred) {
  assert.deepEqual(row.errorLegs, erred, shown(row));
  const keys = Object.keys(row);
  assert.equal(keys.indexOf('errorLegs'), keys.indexOf('errors') + 1, shown(row));
}

const checks = {
  'an error on the guarded leg alone fails guarded and the row and keeps the control it measured':
    async (finish = current, past = before) => {
      const erred = ['guarded'];
      for (const { control, row, today, measured } of await rows(erred, finish, past)) {
        assert.equal(row.control, control, shown(row));
        assert.equal(row.control, measured.control, shown(row));
        assert.equal(today.control, 'fail', shown(today));
        assert.equal(row.guarded, 'fail', shown(row));
        assert.equal(row.live, today.live, shown(row));
        assert.equal(passes(row), false, shown(row));
        flatErrors(row, erred);
        assert.deepEqual(row.errors, today.errors, shown(row));
        placed(row, erred);
        assert.equal(without(row), shown({ ...today, control: row.control }));
      }
    },
  'an error on the control leg fails control and guarded as before': async (
    finish = current,
    past = before
  ) => {
    const erred = ['control'];
    for (const { row, today } of await rows(erred, finish, past)) {
      assert.deepEqual([row.control, row.guarded], ['fail', 'fail'], shown(row));
      assert.equal(passes(row), false, shown(row));
      flatErrors(row, erred);
      placed(row, erred);
      assert.equal(without(row), shown(today));
    }
  },
  'errors on both legs fail control and guarded as before, both legs named in order': async (
    finish = current,
    past = before
  ) => {
    const erred = ['control', 'guarded'];
    for (const { row, today } of await rows(erred, finish, past)) {
      assert.deepEqual([row.control, row.guarded], ['fail', 'fail'], shown(row));
      assert.equal(passes(row), false, shown(row));
      flatErrors(row, erred);
      placed(row, erred);
      assert.equal(without(row), shown(today));
    }
  },
  'a row without errors is byte-identical to before and has no errorLegs': async (
    finish = current,
    past = before
  ) => {
    for (const { control, guarded, row, today } of await rows([], finish, past)) {
      assert.equal(shown(row), shown(today));
      assert.equal(Object.hasOwn(row, 'errorLegs'), false, shown(row));
      assert.deepEqual(row.errors, [], shown(row));
      if (guarded === 'leak' && control === 'pass')
        assert.deepEqual(
          [row.control, row.guarded, row.live],
          ['pass', 'fail', 'pass'],
          shown(row)
        );
      if (guarded === 'refused' && control === 'pass') assert.equal(passes(row), true);
    }
  },
};

for (const [name, check] of Object.entries(checks)) test(name, () => check());

const [guardedCase, controlCase, bothCase, noneCase] = Object.keys(checks);
const mutants = [
  {
    name: 'rewrites control on a guarded error',
    swaps: [[controlLine, "if (row.errors.length) row.control = 'fail';"]],
    against: guardedCase,
  },
  {
    name: 'leaves guarded untouched on a control error',
    swaps: [[guardedLine, "if (legs.guarded.errors.length) row.guarded = 'fail';"]],
    against: controlCase,
  },
  {
    name: 'leaves a guarded error as the guarded verdict it measured',
    swaps: [[guardedLine, "if (legs.control.errors.length) row.guarded = 'fail';"]],
    against: guardedCase,
  },
  { name: 'drops errorLegs', swaps: [[legsLine, '']], against: bothCase },
  {
    name: 'names the legs out of order',
    swaps: [
      ["const errorLegs = ['control', 'guarded']", "const errorLegs = ['guarded', 'control']"],
    ],
    against: bothCase,
  },
  {
    name: 'adds errorLegs to rows without errors',
    swaps: [[legsLine, '    errorLegs,\n']],
    against: noneCase,
  },
  {
    name: 'reorders the errors',
    swaps: [[errorsLine, 'errors: [...legs.guarded.errors, ...legs.control.errors],']],
    against: bothCase,
  },
  {
    name: 'keeps only the control leg errors',
    swaps: [[errorsLine, 'errors: [...legs.control.errors],']],
    against: guardedCase,
  },
  {
    name: 'keeps only the guarded leg errors',
    swaps: [[errorsLine, 'errors: [...legs.guarded.errors],']],
    against: controlCase,
  },
  {
    name: 'reads an incomplete control as fail on a guarded error',
    swaps: [[settleStop, '  if (row.errors.length) return;\n  const fill']],
    against: guardedCase,
  },
  {
    name: 'settles live and why on a guarded error',
    swaps: [[settleGuarded, '']],
    against: guardedCase,
  },
];

for (const { name, swaps, against } of mutants)
  test(`mutant: a runner that ${name} fails "${against}"`, async () => {
    const finish = await finisher(swaps);
    await assert.rejects(checks[against](finish), assert.AssertionError);
  });
