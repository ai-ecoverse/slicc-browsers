import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));

function fakeBrowser({ commits = (url) => url, refuse = [] } = {}) {
  const targets = new Map();
  const sessions = new Map();
  let next = 0;
  const make = (refused) => ({
    events: [],
    messages: [],
    async send(method, params = {}, sessionId) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (refused.includes(method)) throw new Error(`${method}: refused by the fake`);
      const target = targets.get(sessions.get(sessionId));
      if (method === 'Target.createTarget') {
        const targetId = `T${++next}`;
        targets.set(targetId, { url: commits(params.url) });
        return { targetId };
      }
      if (method === 'Target.getTargetInfo') {
        const url = targets.get(params.targetId)?.url ?? '';
        return { targetInfo: { targetId: params.targetId, type: 'page', url, title: url } };
      }
      if (method === 'Target.attachToTarget') {
        const sessionId = `S${++next}`;
        sessions.set(sessionId, params.targetId);
        return { sessionId };
      }
      if (method === 'Target.getTargets')
        return {
          targetInfos: [...targets].map(([targetId, t]) => ({
            targetId,
            type: 'page',
            url: t.url,
          })),
        };
      if (method === 'Page.navigate' && target) {
        target.url = commits(params.url);
        return { frameId: 'F' };
      }
      if (method === 'Page.getFrameTree')
        return {
          frameTree: { frame: { id: 'F', loaderId: 'L', url: target?.url ?? 'about:blank' } },
        };
      if (method === 'Page.getNavigationHistory')
        return { currentIndex: 0, entries: [{ url: target?.url }] };
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'complete' } };
      return {};
    },
    waitEvent: () => new Promise(() => {}),
  });
  return { client: make([]), unguarded: make(refuse) };
}

async function row(id, browser) {
  const fixture = await fixtureServer();
  try {
    const origin = (host) => `http://${host}:${fixture.port}`;
    const execution = await run(
      { ...set, vectors: set.vectors.filter((v) => v.id === id), variants: { prompt: 0 } },
      {
        ...browser,
        fixture,
        settleScale: 0.05,
        targets: {
          ordinary: origin('ordinary.example.test'),
          plain: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    return { row: execution.results[0], summary: execution.summary() };
  } finally {
    await fixture.close();
  }
}

test('an error-page history seed that never commits is incomplete on both legs, never a failure or a pass', async () => {
  const { row: result, summary } = await row(
    'C8.protected-error-page-sticky.fragment',
    fakeBrowser({ commits: (url) => (url.endsWith('-history') ? 'about:blank' : url) })
  );
  assert.equal(result.control, 'incomplete', JSON.stringify(result));
  assert.equal(result.guarded, 'incomplete', JSON.stringify(result));
  assert.equal(result.live, 'incomplete', JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.incomplete, [
    'control errorPage: protected-error-page: history seed did not commit',
    'guarded errorPage: protected-error-page: history seed did not commit',
  ]);
  assert.equal(result.observations.guarded.restored, 'incomplete');
  assert.equal(summary.pass, false);
  assert.equal(summary.incomplete, 1);
  assert.equal(summary.counts.control.incomplete, 1);
  assert.match(summary.line, /^GUARD-FAIL .* incomplete 1$/);
});

test('a control without its own error commit is incomplete while a guard that never blocks still fails', async () => {
  const { row: result } = await row('C8.protected-error-page-sticky', fakeBrowser());
  assert.equal(result.control, 'incomplete', JSON.stringify(result));
  assert.equal(result.guarded, 'fail', JSON.stringify(result));
  assert.equal(result.live, 'fail', JSON.stringify(result));
  assert.equal(result.observations.guarded.live, false);
  assert.match(
    result.incomplete[0],
    /^control errorPage: protected-error-page: missing error commit/
  );
  assert.equal(result.incomplete.length, 1);
});

test('a redirect-body observer whose setup fails is incomplete, not a guard failure', async () => {
  const { row: result } = await row(
    'C2.redirect-body',
    fakeBrowser({ refuse: ['Storage.setCookies'] })
  );
  assert.equal(result.control, 'incomplete', JSON.stringify(result));
  assert.equal(result.guarded, 'incomplete', JSON.stringify(result));
  assert.equal(result.live, 'incomplete', JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.match(
    result.incomplete[0],
    /^control redirectSecret: redirect-secret: observer setup failed: Storage\.setCookies: refused by the fake$/
  );
});
