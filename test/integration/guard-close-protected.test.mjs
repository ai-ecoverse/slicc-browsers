import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { summary as driverSummary, judge } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { chrome, quarantining } from './error-page-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const ids = [
  'C8.protected-document-restore',
  'C8.protected-error-page-sticky',
  'C8.protected-error-page-sticky.query',
  'C8.protected-error-page-sticky.fragment',
];
const vectors = set.vectors.filter((v) => ids.includes(v.id));
const one = { ...set, vectors: vectors.slice(0, 1), variants: { prompt: 0 } };

test('the four C8 lock rows gate closed behind closeProtected and closeRefused behind unless', () => {
  assert.equal(set.capabilities.closeProtected.includes('Target.closeTarget'), true);
  for (const vector of vectors) {
    assert.deepEqual(vector.observe.closed.requires, ['closeProtected']);
    assert.deepEqual(vector.observe.closeRefused.unless, ['closeProtected']);
    assert.equal(vector.expected.closed, true);
    assert.equal(vector.expected.closeRefused, true);
    assert.equal(vector.control.expected.closed, true);
    assert.equal(vector.control.expected.closeRefused, false);
    assert.equal(vector.requires, undefined);
  }
});

test('judge skips closed without closeProtected and skips closeRefused when it is declared', () => {
  const vector = vectors[0];
  const undeclared = {
    ...vector.expected,
    closed: 'not-supported',
    closeRefused: true,
  };
  assert.equal(judge(vector, 'guarded', undeclared).pass, true);
  assert.deepEqual(judge(vector, 'guarded', undeclared).skipped, ['closed']);
  const declared = {
    ...vector.expected,
    closed: true,
    closeRefused: 'not-supported',
  };
  assert.equal(judge(vector, 'guarded', declared).pass, true);
  assert.deepEqual(judge(vector, 'guarded', declared).skipped, ['closeRefused']);
  assert.equal(
    judge(vector, 'guarded', { ...vector.expected, closed: false, closeRefused: true }).pass,
    false
  );
  assert.equal(
    judge(vector, 'guarded', { ...vector.expected, closed: true, closeRefused: false }).pass,
    false
  );
});

test('forgeries reject a forged not-supported closeRefused on an undeclared run', () => {
  const row = {
    id: one.vectors[0].id,
    target: 'seven',
    variant: 'prompt',
    transport: 'cdp',
    control: 'pass',
    guarded: 'pass',
    live: 'pass',
    notSupported: ['closeRefused'],
  };
  const forged = driverSummary({
    guard: 'fake',
    sha: 'test',
    set: one,
    results: [row],
    capabilities: {},
  });
  assert.equal(forged.pass, false);
  assert.ok(
    forged.forged.some((f) =>
      f.why.includes('not-supported:closeRefused while the observation should run')
    )
  );
  const honest = driverSummary({
    guard: 'fake',
    sha: 'test',
    set: one,
    results: [{ ...row, notSupported: ['closed'] }],
    capabilities: {},
  });
  assert.equal(honest.pass, true);
  const opted = driverSummary({
    guard: 'fake',
    sha: 'test',
    set: one,
    results: [{ ...row, notSupported: ['closeRefused'] }],
    capabilities: { closeProtected: true },
  });
  assert.equal(opted.pass, true);
});

async function rows({ closeProtected = false, refuseClose = false, capabilities = {} } = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = chrome();
    const origin = (host) => `http://${host}:${fixture.port}`;
    return await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: quarantining(browser, { closeProtected, refuseClose }),
        unguarded: browser.connect(),
        fixture,
        settleScale: 0.1,
        capabilities: { discovery: true, ...capabilities },
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
  } finally {
    await fixture.close();
  }
}

test('an undeclared guard that refuses close passes on closeRefused', async () => {
  const execution = await rows();
  assert.equal(execution.results.length, 4);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.observations.guarded.closeRefused, true, JSON.stringify(row));
    assert.equal(row.observations.guarded.closed, 'not-supported', JSON.stringify(row));
    assert.equal(row.observations.guarded.evaluateRefused, true);
    assert.equal(row.observations.guarded.attachRefused, true);
  }
  assert.equal(execution.summary().pass, true);
});

test('a declared guard that closes passes on closed', async () => {
  const execution = await rows({
    closeProtected: true,
    capabilities: { closeProtected: true },
  });
  for (const row of execution.results) {
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.observations.guarded.closed, true, JSON.stringify(row));
    assert.equal(row.observations.guarded.closeRefused, 'not-supported', JSON.stringify(row));
    assert.equal(row.observations.guarded.evaluateRefused, true);
    assert.equal(row.observations.guarded.attachRefused, true);
  }
  assert.equal(execution.summary().pass, true);
});

test('a declared guard that still refuses close fails closed', async () => {
  const execution = await rows({
    closeProtected: true,
    refuseClose: true,
    capabilities: { closeProtected: true },
  });
  for (const row of execution.results) {
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.observations.guarded.closed, false, JSON.stringify(row));
    assert.equal(row.observations.guarded.closeRefused, 'not-supported', JSON.stringify(row));
    assert.equal(row.observations.guarded.evaluateRefused, true);
    assert.equal(row.observations.guarded.attachRefused, true);
  }
  assert.equal(execution.summary().pass, false);
});

test('an undeclared guard that closes fails closeRefused', async () => {
  const execution = await rows({ closeProtected: true });
  for (const row of execution.results) {
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.observations.guarded.closeRefused, false, JSON.stringify(row));
    assert.equal(row.observations.guarded.closed, 'not-supported', JSON.stringify(row));
  }
  assert.equal(execution.summary().pass, false);
});
