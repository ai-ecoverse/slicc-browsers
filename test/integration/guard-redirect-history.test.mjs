import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';
import { ordinary, redirectHistoryFixture } from './redirect-history-fixture.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));

async function exercise(options = {}) {
  const browser = redirectHistoryFixture(options);
  const execution = await run(
    {
      ...set,
      variants: { prompt: 0 },
      vectors: set.vectors.filter(
        (vector) =>
          vector.id.startsWith('C2.redirect') &&
          (!options.bodyOnly || vector.id === 'C2.redirect-body')
      ),
    },
    {
      client: browser.client,
      unguarded: browser.reader,
      fixture: browser.fixture,
      targets: { ordinary },
      capabilities: { browserSession: true },
      rowTimeoutMs: 120000,
    }
  );
  return { ...browser, execution };
}

test('C2 redirect rows recover on fresh tabs after protected-history content refusals', {
  timeout: 120000,
}, async () => {
  const { execution, calls, sessions, routes } = await exercise();
  assert.equal(execution.results.length, 3);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.observations.guarded.sessionSurvives, true);
    assert.deepEqual(row.errors, []);
  }
  const survival = calls.filter(
    (call) => call.method === 'Runtime.evaluate' && call.params.expression === 'document.title'
  );
  assert.equal(survival.length, 6);
  for (const call of survival)
    assert.equal(sessions.get(call.sessionId).tab.protectedHistory, false);
  assert.equal(routes.size, 0);
});

test('C2 redirect rows still fail a leak delayed in a protected-history tab', {
  timeout: 120000,
}, async () => {
  const { execution } = await exercise({ leak: true, late: true });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.observations.guarded.secretHidden, false);
    assert.equal(row.observations.guarded.sessionSurvives, true);
    assert.deepEqual(row.errors, []);
  }
});

test('a missing override pause is incomplete while received leaks still fail', {
  timeout: 120000,
}, async () => {
  for (const leak of [false, true]) {
    const { execution } = await exercise({ missingPause: true, leak, bodyOnly: true });
    const row = execution.results.find((entry) => entry.id === 'C2.redirect-body');
    assert.equal(row.guarded, leak ? 'fail' : 'incomplete', JSON.stringify(row));
    assert.equal(row.observations.guarded.overridesRefused, 'incomplete');
    assert.match(row.incomplete.join('; '), /override pause/);
    assert.deepEqual(row.errors, []);
  }
});
