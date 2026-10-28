import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { chrome, quarantining } from './error-page-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vectors = set.vectors.filter((v) => v.trigger.some((s) => s.errorPage));
const every = vectors.map((v) => v.id);
const all = 'C8.protected-error-page';
const blank = 'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E';
const legs = [
  'live',
  'attached',
  'infoRedacted',
  'listRedacted',
  'eventsRedacted',
  'attachRedacted',
];

function wiping(browser, conn, page, taint) {
  if (!page) return conn;
  let failedURL;
  const send = conn.send;
  conn.send = async (method, params, sessionId) => {
    if (method === 'Page.reload') {
      failedURL = browser.tabOf(sessionId)?.frame.unreachableUrl;
      await conn.raw('Page.navigate', { url: page }, sessionId);
    }
    return send(method, params, sessionId);
  };
  browser.commits.push((tab) => {
    if (taint && failedURL && tab.url === page) Object.assign(tab, taint(tab, failedURL));
  });
  return conn;
}

async function rows(ids, { page, taint, side = 'guarded' } = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = chrome();
    const client = quarantining(browser);
    const unguarded = browser.connect();
    wiping(browser, side === 'guarded' ? client : unguarded, page, taint);
    const origin = (host) => `http://${host}:${fixture.port}`;
    return await run(
      { ...set, vectors: vectors.filter((v) => ids.includes(v.id)), variants: { prompt: 0 } },
      {
        client,
        unguarded,
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
  } finally {
    await fixture.close();
  }
}

for (const [name, ids, options] of [
  ['recreates the protected error', every, {}],
  ['finds the tab already on the private blank page', every, { page: blank }],
])
  test(`a reload that ${name} passes the error-page rows`, async () => {
    const execution = await rows(ids, options);
    assert.equal(execution.results.length, ids.length);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.deepEqual(row.errors, [], JSON.stringify(row));
      assert.equal(row.incomplete, undefined, JSON.stringify(row));
      assert.equal(row.observations.guarded.reload, true, JSON.stringify(row));
      assert.equal(row.observations.control.reload, true, JSON.stringify(row));
    }
    assert.equal(execution.summary().pass, true);
  });

for (const [name, options] of [
  ['a lookalike data: page', { page: 'data:text/html,%3ctitle%3eblocked%3c%2ftitle%3e' }],
  ['the private blank page with more after it', { page: `${blank}%3Cp%3E` }],
  ['the private blank page with a fragment', { page: `${blank}#blocked` }],
  ['an unescaped private blank page', { page: 'data:text/html,<title>blocked</title>' }],
  [
    'the private blank page with the failed URL in its unreachableUrl',
    {
      page: blank,
      taint: (tab, failedURL) => ({ frame: { ...tab.frame, unreachableUrl: failedURL } }),
    },
  ],
  [
    'the private blank page titled with the failed URL',
    { page: blank, taint: (tab, failedURL) => ({ title: failedURL }) },
  ],
  [
    'the private blank page titled with the protected origin',
    { page: blank, taint: (tab, failedURL) => ({ title: new URL(failedURL).origin }) },
  ],
])
  test(`a reload that finds the tab on ${name} fails only reload`, async () => {
    const execution = await rows([all], options);
    const [row] = execution.results;
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.deepEqual(row.errors, [], JSON.stringify(row));
    assert.equal(row.observations.guarded.reload, false, JSON.stringify(row));
    for (const leg of legs) assert.equal(row.observations.guarded[leg], true, leg);
    assert.equal(row.why, 'reload: got false, want true', JSON.stringify(row));
  });

test('an unguarded control whose tab is on the private blank page when it reloads fails the control', async () => {
  const execution = await rows(every, { page: blank, side: 'control' });
  assert.equal(execution.results.length, every.length);
  for (const row of execution.results) {
    assert.equal(row.control, 'fail', JSON.stringify(row));
    assert.equal(row.observations.control.reload, false, JSON.stringify(row));
    assert.equal(row.observations.guarded.reload, true, JSON.stringify(row));
  }
  assert.equal(execution.summary().pass, false);
});
