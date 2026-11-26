import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { fakeBrowser } from './frame-read-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));

async function rows(ids, browser, capabilities) {
  const fixture = await fixtureServer();
  try {
    const origin = (host) => `http://${host}:${fixture.port}`;
    const execution = await run(
      { ...set, vectors: set.vectors.filter((v) => ids.includes(v.id)), variants: { prompt: 0 } },
      {
        ...browser,
        fixture,
        settleScale: 0.05,
        ...(capabilities ? { capabilities } : {}),
        targets: {
          ordinary: origin('ordinary.example.test'),
          'ordinary-same-site': origin('ordinary.sliccy.ai'),
          plain: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          'vault-x': origin('vault-x.sliccy.ai'),
          apex: origin('sliccy.ai'),
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

const same = ['C4.iframe-preattach.blank', 'C4.iframe-preattach.srcdoc'];
const shared = ['C4.iframe-preattach.blank.shared', 'C4.iframe-preattach.srcdoc.shared'];

for (const [guard, verdict, shown] of [
  [
    'none',
    'fail',
    [
      'frameTreeShown',
      'axFullShown',
      'axPartialShown',
      'documentShown',
      'nodeShown',
      'snapshotShown',
    ],
  ],
  ['show-ax', 'fail', ['axFullShown', 'axPartialShown']],
  ['show-dom', 'fail', ['documentShown']],
  ['refuse', 'pass', []],
  ['origin', 'pass', []],
  ['attach', 'pass', []],
])
  test(`pre-attached same-process child frames: a guard that answers ${guard} is ${verdict}`, async () => {
    const execution = await rows(same, fakeBrowser({ guard }));
    assert.equal(execution.results.length, 2);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, verdict, JSON.stringify(row));
      assert.deepEqual(
        Object.entries(row.observations.guarded)
          .filter(([, value]) => value === true)
          .map(([name]) => name)
          .filter((name) => name !== 'live'),
        shown
      );
    }
  });

test('the shared-process rows skip without siteIsolationOff and run with it', async () => {
  const without = await rows(shared, fakeBrowser({ guard: 'refuse' }), {
    autoAttach: true,
    browserSession: true,
  });
  assert.equal(without.results.length, 8);
  for (const row of without.results) {
    assert.equal(row.guarded, 'skip');
    assert.equal(row.reason, 'not-supported:siteIsolationOff');
  }
  assert.deepEqual(without.summary().forged, []);
  const showing = await rows(
    ['C4.iframe-preattach.srcdoc.shared'],
    fakeBrowser({ guard: 'show-ax' }),
    {
      siteIsolationOff: true,
    }
  );
  assert.deepEqual(
    showing.results.map((row) => [row.target, row.control, row.guarded]),
    ['seven', 'vault', 'vault-x', 'apex'].map((target) => [target, 'pass', 'fail'])
  );
  const refusing = await rows(
    ['C4.iframe-preattach.blank.shared'],
    fakeBrowser({ guard: 'origin' }),
    {
      siteIsolationOff: true,
    }
  );
  for (const row of refusing.results) assert.equal(row.guarded, 'pass', JSON.stringify(row));
});

test('a protected frame in another process is incomplete, never a pass', async () => {
  const execution = await rows(
    ['C4.iframe-preattach.blank'],
    fakeBrowser({ guard: 'refuse', oopif: true })
  );
  const [row] = execution.results;
  assert.equal(row.control, 'incomplete', JSON.stringify(row));
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.live, 'incomplete', JSON.stringify(row));
  assert.match(row.incomplete[0], /^control frameRead: frame-read: no about:blank child of /);
  assert.equal(execution.summary().pass, false);
});

test('a read the observer cannot show, or the guard never answers, is incomplete', async () => {
  const blind = (
    await rows(['C4.iframe-preattach.srcdoc'], fakeBrowser({ guard: 'refuse', blindAX: true }))
  ).results[0];
  assert.equal(blind.control, 'incomplete', JSON.stringify(blind));
  assert.equal(blind.guarded, 'incomplete', JSON.stringify(blind));
  assert.equal(blind.observations.guarded.axFullShown, 'incomplete');
  assert.match(blind.incomplete[0], /observer axFull did not show the frame's content/);
  const hung = (await rows(['C4.iframe-preattach.srcdoc'], fakeBrowser({ guard: 'hang' })))
    .results[0];
  assert.equal(hung.control, 'pass', JSON.stringify(hung));
  assert.equal(hung.guarded, 'incomplete', JSON.stringify(hung));
  assert.equal(hung.observations.guarded.documentShown, 'incomplete');
  assert.match(hung.incomplete[0], /^guarded frameRead: frame-read: frameTree unanswered/);
});

test('a grouped read that shows the marker before an unanswered call fails', async () => {
  const [row] = (await rows(['C4.iframe-preattach.blank'], fakeBrowser({ guard: 'half' }))).results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.axFullShown, true);
});

test('a read the observer could not prove still fails when the guarded client sees the marker', async () => {
  const [row] = (
    await rows(['C4.iframe-preattach.srcdoc'], fakeBrowser({ guard: 'show-ax', blindAX: true }))
  ).results;
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.axFullShown, true);
});
