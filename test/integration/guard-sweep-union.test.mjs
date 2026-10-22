import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import {
  capabilities,
  drivable,
  expectedLive,
  expectedSkip,
  guardEvidence,
  liveNeedsGuard,
  partitions,
  published,
  rowsFor,
  selection,
  verdictProblems,
} from './guard-sweep.mjs';

const targets = [...new Set(published.vectors.flatMap((vector) => vector.targets))];
const vector = (predicate) => published.vectors.find(predicate);

function clean(set, target) {
  return rowsFor(set, [target]).map((row) => {
    const v = set.vectors.find((candidate) => candidate.id === row.id);
    if (v.kind === 'text')
      return { ...row, control: 'not-run', guarded: 'not-run', live: 'not-run' };
    const reason = expectedSkip(v, target);
    if (reason) return { ...row, control: 'skip', guarded: 'skip', live: 'skip', reason };
    return {
      ...row,
      control: 'pass',
      guarded: drivable.has(v.id) ? 'pass' : 'fail',
      live: expectedLive(v, target),
    };
  });
}

function changed(target, id, change) {
  const set = selection(published, target);
  const results = clean(set, target).map((row) => (row.id === id ? { ...row, ...change } : row));
  return verdictProblems(set, [target], results);
}

test('the sweep partitions take every published target exactly once, each in its own test file', async () => {
  const assigned = Object.values(partitions).flat();
  assert.equal(new Set(assigned).size, assigned.length, 'a target is in two partitions');
  assert.deepEqual([...assigned].sort(), [...targets].sort());
  for (const [name, list] of Object.entries(partitions))
    assert.ok(rowsFor(published, list).length > 0, `${name} has rows`);
  const files = (await readdir(new URL('./', import.meta.url))).filter((file) =>
    /^guard-sweep-.+\.test\.mjs$/.test(file)
  );
  assert.deepEqual(
    files.sort(),
    [
      ...Object.keys(partitions).map((name) => `guard-sweep-${name}.test.mjs`),
      'guard-sweep-union.test.mjs',
    ].sort()
  );
});

test('the sweep declares every capability a published vector requires but the ones a real browser lacks', () => {
  const required = new Set(published.vectors.flatMap((v) => v.requires ?? []));
  const missing = [...required].filter((capability) => capabilities[capability] !== true).sort();
  assert.deepEqual(missing, ['inboundDelay']);
  for (const id of drivable)
    assert.ok(
      vector((v) => v.id === id),
      id
    );
});

test('a complete sweep of every target, with its declared skips, has no problems', () => {
  for (const target of targets) {
    const set = selection(published, target);
    assert.deepEqual(verdictProblems(set, [target], clean(set, target)), [], target);
  }
});

test('an all-skip sweep fails every row and says it proved nothing', () => {
  const set = selection(published, 'seven');
  const results = rowsFor(set, ['seven']).map((row) => ({
    ...row,
    control: 'skip',
    guarded: 'skip',
    live: 'skip',
    reason: 'not-applicable',
  }));
  const problems = verdictProblems(set, ['seven'], results);
  assert.ok(problems.includes('seven: no row ran, so the sweep proved nothing'));
  const declared = results.filter(
    (row) =>
      expectedSkip(
        set.vectors.find((v) => v.id === row.id),
        'seven'
      ) === 'not-applicable'
  ).length;
  assert.equal(problems.length, results.length - declared + 1);
});

test('a skip is only accepted with the reason its vector declares', () => {
  const runnable = vector(
    (v) => v.kind === 'cdp' && v.targets.includes('seven') && !expectedSkip(v, 'seven')
  );
  const skip = { control: 'skip', guarded: 'skip', live: 'skip' };
  assert.equal(changed('seven', runnable.id, skip).length, 2, 'a skip without a reason');
  assert.equal(
    changed('seven', runnable.id, { ...skip, reason: 'not-supported:browserSession' }).length,
    2,
    'a skip for a capability the sweep declares'
  );
  const declared = vector((v) => v.skip);
  const { target, reason } = declared.skip;
  assert.deepEqual(changed(target, declared.id, { ...skip, reason }), []);
  assert.equal(
    changed(target, declared.id, { ...skip, reason: 'not-applicable' }).length,
    2,
    'another reason than the declared one'
  );
  assert.equal(
    changed(target, declared.id, { control: 'pass', guarded: 'fail', live: 'pass' }).length,
    2,
    'running a row that declares a skip'
  );
  const gated = vector((v) => v.requires?.includes('inboundDelay'));
  const [first] = gated.targets;
  assert.deepEqual(changed(first, gated.id, { ...skip, reason: 'not-supported:inboundDelay' }), []);
  const unobservable = vector((v) => v.observable?.own === false);
  assert.deepEqual(changed('own', unobservable.id, { ...skip, reason: 'not-applicable' }), []);
});

test('only published rows whose liveCheck takes guard evidence may be dead without a guard', () => {
  for (const [id, list] of liveNeedsGuard) {
    const v = vector((candidate) => candidate.id === id);
    assert.equal(v?.kind, 'cdp', id);
    assert.ok(list.length > 0, id);
    for (const target of list) assert.ok(v.targets.includes(target), `${id} ${target}`);
    assert.ok(guardEvidence(v.liveCheck), `${id} can be live from the browser and fixture alone`);
  }
  assert.equal(guardEvidence({ loaded: '{target}/doc', observer: 'fixture' }), false);
  assert.equal(
    guardEvidence({
      all: [{ state: {}, observer: 'unguarded' }, { any: [{ refused: ['call'] }] }],
    }),
    true
  );
  const fixtureOnly = published.vectors.filter(
    (v) => v.kind === 'cdp' && !guardEvidence(v.liveCheck)
  );
  assert.ok(fixtureOnly.length > 0);
  for (const v of fixtureOnly)
    for (const target of v.targets) assert.equal(expectedLive(v, target), 'pass', v.id);
});

test('a row must pass its control and fail its protection, unless it is a drivable row, and be live unless only a guard can make it so', () => {
  const runnable = vector(
    (v) =>
      v.kind === 'cdp' &&
      v.targets.includes('seven') &&
      !expectedSkip(v, 'seven') &&
      !drivable.has(v.id) &&
      !liveNeedsGuard.has(v.id)
  );
  for (const change of [
    { control: 'fail' },
    { control: 'incomplete' },
    { live: 'fail' },
    { live: 'incomplete' },
    { guarded: 'pass' },
    { guarded: 'incomplete' },
    { live: 'skip' },
    { control: 'not-run', guarded: 'not-run', live: 'not-run' },
  ])
    assert.equal(changed('seven', runnable.id, change).length, 2, JSON.stringify(change));
  const page = vector((v) => drivable.has(v.id) && !expectedSkip(v, v.targets[0]));
  assert.equal(changed(page.targets[0], page.id, { guarded: 'fail' }).length, 2);
  const text = vector((v) => v.kind === 'text');
  assert.equal(
    changed(text.targets[0], text.id, { control: 'pass', guarded: 'fail', live: 'pass' }).length,
    2
  );
  for (const change of [{ live: 'pass' }, { live: 'incomplete' }, { live: 'skip' }])
    assert.equal(changed('seven', 'C6.getCookies', change).length, 2, JSON.stringify(change));
  assert.equal(changed('seven', 'C6.read-cookies', { live: 'pass' }).length, 2);
  assert.equal(changed('vault-x', 'C6.read-cookies', { live: 'fail' }).length, 2);
  assert.deepEqual(changed('apex', 'C6.read-cookies', {}), []);
});

test('a missing, repeated or unselected row fails the sweep', () => {
  const set = selection(published, 'vault');
  const results = clean(set, 'vault');
  const problems = verdictProblems(
    set,
    ['vault'],
    [...results.slice(1), results[2], { ...results[3], id: 'Z9.unknown' }]
  );
  const [dropped, doubled] = [results[0], results[2]];
  assert.ok(problems.includes(`${dropped.id} vault ${dropped.variant} ran 0 times`));
  assert.ok(problems.includes(`${doubled.id} vault ${doubled.variant} ran 2 times`));
  assert.ok(problems.includes(`Z9.unknown vault ${results[3].variant} is not selected`));
  assert.ok(
    problems.some(
      (problem) =>
        problem.startsWith('Z9.unknown vault ') && problem.includes('is not a published vector')
    )
  );
});
