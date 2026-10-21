import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { chrome, quarantining } from './error-page-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vectors = set.vectors.filter((v) => v.trigger.some((s) => s.errorPage));

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
    refuseNavigation: (tab, quarantined) => quarantined(tab) && tab.frame.url === 'about:blank',
  });
  const [row] = execution.results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.live, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.close, 'incomplete');
  assert.equal(row.observations.guarded.blank, true);
  assert.equal(row.observations.guarded.infoRedacted, true);
});
