import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { summary as driverSummary, result } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';

const full = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const capabilities = ['autoAttach', 'browserSession'];
const narrowed = (vector) => {
  if (vector.kind === 'text') return vector;
  if (vector.skip) return { ...vector, targets: [vector.skip.target] };
  if ((vector.requires ?? []).some((c) => !capabilities.includes(c))) return vector;
  if (vector.targets.includes('apex')) return { ...vector, targets: ['apex'] };
  return null;
};
const set = { ...full, vectors: full.vectors.map(narrowed).filter(Boolean) };

const genuine = async () => {
  const client = { transport: 'cdp', events: [], messages: [], send: async () => ({}) };
  const execution = await run(set, {
    client,
    clientFactory: () => client,
    capabilities,
    targets: {
      ordinary: 'http://ordinary.test/',
      'ordinary-same-site': 'http://same.ordinary.test/',
      seven: 'http://seven.test/',
      vault: 'http://vault.test/',
      'vault-x': 'http://x.vault.test/',
      apex: null,
      own: 'http://own.test/',
      client: 'http://client.test/',
      log: 'http://log.test/',
    },
    fixture: { log: async () => [] },
  });
  return execution;
};

test('a genuine run of text and skipped rows still passes', async () => {
  const execution = await genuine();
  const statuses = new Set(execution.results.flatMap((r) => [r.control, r.guarded, r.live]));
  assert.deepEqual([...statuses].sort(), ['not-run', 'skip']);
  const reasons = new Set(execution.results.map((r) => r.reason).filter(Boolean));
  assert.ok(reasons.has('not-applicable'));
  assert.ok(reasons.has('not-applicable:no-apex-origin'));
  assert.ok([...reasons].some((r) => r.startsWith('not-supported:')));
  const report = execution.summary({ guard: 'reference', sha: 'test' });
  assert.equal(report.pass, true);
  assert.deepEqual(report.forged ?? [], []);
  assert.match(report.line, /^GUARD-PASS /);
});

test('a genuine driver result with the vector skip reason still passes', () => {
  const vectors = full.vectors.filter((v) => v.skip);
  const one = { ...full, vectors: vectors.map((v) => ({ ...v, targets: [v.skip.target] })) };
  const results = Object.keys(full.variants).flatMap((variant) =>
    one.vectors.map((v) =>
      result(v, { target: v.skip.target, variant, transport: 'cdp', live: true })
    )
  );
  assert.ok(results.every((r) => r.reason === one.vectors.find((v) => v.id === r.id).skip.reason));
  assert.equal(driverSummary({ guard: 'reference', sha: 'test', set: one, results }).pass, true);
});

test('a runnable row reported as not-run fails the run', async () => {
  const execution = await genuine();
  const vector = set.vectors.find((v) => v.kind === 'cdp');
  const row = execution.results.find((r) => r.id === vector.id);
  const forgedRow = { ...row, control: 'not-run', guarded: 'not-run', live: 'not-run' };
  delete forgedRow.reason;
  execution.results.splice(execution.results.indexOf(row), 1, forgedRow);
  const report = execution.summary({ guard: 'reference', sha: 'test' });
  assert.equal(report.pass, false);
  assert.match(report.line, /^GUARD-FAIL /);
  assert.ok(report.forged.some((f) => f.id === vector.id && /not-run/.test(f.why)));
});

test('a skip without a reason fails the run', async () => {
  const execution = await genuine();
  const row = execution.results.find((r) => r.control === 'skip');
  const forgedRow = { ...row };
  delete forgedRow.reason;
  execution.results.splice(execution.results.indexOf(row), 1, forgedRow);
  const report = execution.summary({ guard: 'reference', sha: 'test' });
  assert.equal(report.pass, false);
  assert.match(report.line, /^GUARD-FAIL /);
  assert.ok(report.forged.some((f) => f.id === row.id && /without a reason/.test(f.why)));
});

test('a skip with a reason the runner never gives fails the run', async () => {
  const execution = await genuine();
  const row = execution.results.find((r) => r.control === 'skip');
  execution.results.splice(execution.results.indexOf(row), 1, { ...row, reason: 'trust-me' });
  const report = driverSummary({
    guard: 'reference',
    sha: 'test',
    set,
    results: execution.results,
  });
  assert.equal(report.pass, false);
  assert.ok(report.forged.some((f) => f.id === row.id && /trust-me/.test(f.why)));
});
