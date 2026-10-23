import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { chrome, quarantining } from './error-page-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vectors = set.vectors.filter((v) => v.trigger.some((s) => s.errorPage));
const inheriting = (url) => /^about:(?:blank|srcdoc)(?:[?#]|$)/i.test(url);
const recovery = (url) => /\/blank\?n=[^#]*-recover$/.test(url ?? '');

async function rows(ids, options) {
  const fixture = await fixtureServer();
  try {
    const browser = chrome();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const execution = await run(
      { ...set, vectors: vectors.filter((v) => ids.includes(v.id)), variants: { prompt: 0 } },
      {
        client: quarantining(browser, options),
        unguarded: browser.connect(),
        fixture,
        settleScale: 0.1,
        capabilities: { discovery: true },
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    return execution;
  } finally {
    await fixture.close();
  }
}

test('error-page rows reach a verdict when the guard refuses client script in a tab with protected history', async () => {
  const execution = await rows(vectors.map((v) => v.id));
  assert.equal(execution.results.length, 7);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.deepEqual(row.errors, [], JSON.stringify(row));
    assert.equal(row.incomplete, undefined, JSON.stringify(row));
  }
  const sticky = execution.results.find((row) => row.id === 'C8.protected-error-page-sticky');
  assert.equal(sticky.observations.guarded.evaluateRefused, true);
  assert.equal(sticky.observations.guarded.stickyError, true);
  const recover = execution.results.find((row) => row.id === 'C8.protected-error-page');
  assert.equal(recover.observations.guarded.close, true);
  assert.equal(recover.observations.guarded.eventsRedacted, true);
  assert.equal(execution.summary().pass, true);
});

test('a guard that also refuses the client navigation leaves the error-page rows incomplete', async () => {
  const execution = await rows(
    ['C8.protected-error-page', 'C8.protected-error-page-sticky.query'],
    { refuseNavigation: (tab, quarantined) => quarantined(tab) }
  );
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
    assert.equal(row.live, 'incomplete', JSON.stringify(row));
    assert.deepEqual(row.errors, []);
    assert.match(
      row.incomplete.join('\n'),
      /^guarded errorPage: protected-error-page: client navigation failed: slicc: refused: navigation in a quarantined tab$/
    );
  }
  assert.equal(execution.summary().pass, false);
});

test('a refused navigation before the recover close leaves only that close incomplete', async () => {
  const execution = await rows(['C8.protected-error-page.fragment'], {
    refuseNavigation: (tab, quarantined) => quarantined(tab) && recovery(tab.frame.url),
  });
  const [row] = execution.results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.live, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.close, 'incomplete');
  assert.equal(row.observations.guarded.blank, true);
  assert.equal(row.observations.guarded.infoRedacted, true);
});

test('a guard that refuses every client navigation to an inheriting about: URL gets real error-page verdicts', async () => {
  const asked = [];
  const execution = await rows(
    vectors.map((v) => v.id),
    {
      refuseURL: (url) => {
        asked.push(url);
        return inheriting(url);
      },
    }
  );
  assert.equal(execution.results.length, 7);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.deepEqual(row.errors, [], JSON.stringify(row));
    assert.equal(row.incomplete, undefined, JSON.stringify(row));
    assert.equal(row.observations.guarded.blank, true);
    assert.equal(row.observations.guarded.attached, true);
  }
  assert.equal(asked.filter(recovery).length, 7);
  assert.deepEqual(asked.filter(inheriting), []);
  assert.equal(
    execution.results.find((row) => row.id === 'C8.protected-error-page').observations.guarded
      .close,
    true
  );
  assert.equal(execution.summary().pass, true);
});

for (const [name, options, ids, leaked] of [
  ['exposes the failed URL', { exposeURL: true }, vectors.map((v) => v.id), 'infoRedacted'],
  [
    'lets the client script a restored protected document',
    { evaluate: true },
    vectors.filter((v) => !v.trigger.some((s) => s.errorPage === 'recover')).map((v) => v.id),
    'evaluateRefused',
  ],
])
  test(`a guard that refuses inheriting about: URLs but ${name} still fails`, async () => {
    const execution = await rows(ids, { ...options, refuseURL: inheriting });
    assert.equal(execution.results.length, ids.length);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'fail', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.deepEqual(row.errors, [], JSON.stringify(row));
      assert.equal(row.incomplete, undefined, JSON.stringify(row));
      assert.equal(row.observations.guarded.blank, true);
      assert.equal(row.observations.guarded[leaked], false);
    }
    assert.equal(execution.summary().pass, false);
  });

for (const [name, options] of [
  ['refuses', { refuseURL: (url) => inheriting(url) || recovery(url) }],
  ['answers without committing', { refuseURL: inheriting, unanswered: recovery }],
])
  test(`a guard that ${name} the ordinary recovery navigation fails the error-page rows`, async () => {
    const execution = await rows(
      vectors.map((v) => v.id),
      options
    );
    assert.equal(execution.results.length, 7);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'fail', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.deepEqual(row.errors, [], JSON.stringify(row));
      assert.equal(row.incomplete, undefined, JSON.stringify(row));
      assert.equal(row.observations.guarded.blank, false);
    }
    const recover = execution.results.find((row) => row.id === 'C8.protected-error-page');
    assert.equal(recover.observations.guarded.close, false);
    assert.equal(execution.summary().pass, false);
  });

test('a refused guarded attach is recorded in the row evidence and why', async () => {
  const execution = await rows(['C8.protected-error-page'], {
    refuseAttach: (tab, quarantined) => quarantined(tab),
  });
  const [row] = execution.results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.live, 'fail', JSON.stringify(row));
  assert.deepEqual(row.errors, []);
  assert.equal(row.incomplete, undefined);
  assert.deepEqual(row.evidence.guarded.errorPage.clientAttach, {
    outcome: 'refused',
    error: 'slicc: refused: attach to a quarantined tab',
  });
  assert.equal(row.evidence.guarded.errorPage.errorCommit, undefined);
  assert.deepEqual(row.evidence.control.errorPage.clientAttach, {
    outcome: 'answered',
    sessionId: true,
  });
  assert.equal(row.evidence.control.errorPage.errorCommit.seen, true);
  assert.equal(row.evidence.control.errorPage.errorCommit.budgetMs, 500);
  assert.match(
    row.why,
    /not live: client attach refused: slicc: refused: attach to a quarantined tab$/
  );
  const summary = execution.summary();
  assert.equal(summary.pass, false);
  assert.equal(summary.results[0].evidence.guarded.errorPage.clientAttach.outcome, 'refused');
});

test('a missed guarded error commit records its wait and budget in the row evidence and why', async () => {
  const execution = await rows(['C8.protected-error-page-sticky.query'], { block: false });
  const [row] = execution.results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.live, 'fail', JSON.stringify(row));
  assert.deepEqual(row.errors, []);
  assert.equal(row.incomplete, undefined);
  const { clientAttach, errorCommit } = row.evidence.guarded.errorPage;
  assert.deepEqual(clientAttach, { outcome: 'answered', sessionId: true });
  assert.equal(errorCommit.seen, false);
  assert.equal(errorCommit.budgetMs, 500);
  assert(errorCommit.elapsedMs >= 500, JSON.stringify(errorCommit));
  assert.match(errorCommit.frame.url, /^http:\/\/seven\.sliccy\.ai:\d+\/doc\?query-secret=/);
  assert.equal(errorCommit.frame.unreachableUrl, undefined);
  assert.equal(errorCommit.targetInfo.url, errorCommit.frame.url);
  const control = row.evidence.control.errorPage.errorCommit;
  assert.equal(control.seen, true);
  assert.equal(control.frame.url, 'chrome-error://chromewebdata/');
  const url = errorCommit.frame.url;
  assert(
    row.why.endsWith(
      `not live: error commit not seen after ${errorCommit.elapsedMs}ms (budget 500ms): frame ${url} unreachableUrl none, target ${url}`
    ),
    row.why
  );
  assert.equal(execution.summary().results[0].evidence.guarded.errorPage.errorCommit.seen, false);
});
