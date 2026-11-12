import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { keptDocument, keptSecurityOrigin, unclosableShape } from '../../close-protected-shape.mjs';
import { fixtureServer } from '../../fixture-server.mjs';
import { judge } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { chrome, quarantining } from './error-page-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const ids = [
  'C8.close-protected.view-source',
  'C8.close-protected.blob',
  'C8.close-protected.userinfo',
  'C8.close-protected.navigating',
  'C8.close-protected.blank-inherited',
];
const vectors = set.vectors.filter((v) => ids.includes(v.id));

test('closeProtected disguise rows require closeProtected and refuse close when declared', () => {
  assert.equal(vectors.length, 5);
  for (const vector of vectors) {
    assert.deepEqual(vector.requires, ['closeProtected'], vector.id);
    assert.equal(vector.expected.closed, false, vector.id);
    assert.equal(vector.expected.closeRefused, true, vector.id);
    assert.equal(vector.control.expected.closed, true, vector.id);
    assert.equal(vector.control.expected.closeRefused, false, vector.id);
    assert.equal(vector.observe.closed.requires, undefined, vector.id);
    assert.equal(vector.observe.closeRefused.unless, undefined, vector.id);
  }
  for (const vector of vectors) {
    assert.equal(vector.expected.evaluateRefused, undefined, vector.id);
    assert.equal(vector.observe.evaluateRefused, undefined, vector.id);
    assert.equal(vector.control.expected.evaluateRefused, undefined, vector.id);
  }
  const navigating = vectors.find((v) => v.id === 'C8.close-protected.navigating');
  assert.equal(navigating.expected.attachRefused, undefined);
  assert.equal(navigating.observe.attachRefused, undefined);
  const blank = vectors.find((v) => v.id === 'C8.close-protected.blank-inherited');
  assert.equal(blank.expected.attachRefused, true);
  for (const id of [
    'C8.close-protected.view-source',
    'C8.close-protected.blob',
    'C8.close-protected.userinfo',
  ]) {
    const vector = vectors.find((v) => v.id === id);
    assert.equal(vector.expected.attachRefused, true, id);
  }
  assert.deepEqual(vectors.find((v) => v.id === 'C8.close-protected.userinfo').targets, ['seven']);
  for (const id of [
    'C8.close-protected.view-source',
    'C8.close-protected.blob',
    'C8.close-protected.navigating',
    'C8.close-protected.blank-inherited',
  ])
    assert.deepEqual(vectors.find((v) => v.id === id).targets, ['vault']);
});

test('existing C8 sticky and restore closed expectations stay closable', () => {
  for (const id of [
    'C8.protected-document-restore',
    'C8.protected-error-page-sticky',
    'C8.protected-error-page-sticky.query',
    'C8.protected-error-page-sticky.fragment',
  ]) {
    const vector = set.vectors.find((v) => v.id === id);
    assert.equal(vector.expected.closed, true, id);
    assert.deepEqual(vector.observe.closed.requires, ['closeProtected'], id);
    assert.deepEqual(vector.observe.closeRefused.unless, ['closeProtected'], id);
  }
});

test('keptDocument covers vault wrappers, seven UI userinfo, and not callback', () => {
  assert.equal(keptDocument('https://vault.sliccy.ai/secret'), true);
  assert.equal(keptDocument('view-source:https://vault.sliccy.ai/secret'), true);
  assert.equal(
    keptDocument('blob:https://vault.sliccy.ai/11111111-1111-1111-1111-111111111111'),
    true
  );
  assert.equal(keptDocument('https://user:pass@seven.sliccy.ai/os/index.html'), true);
  assert.equal(keptDocument('https://seven.sliccy.ai/os/callback.html'), false);
  assert.equal(keptDocument('https://seven.sliccy.ai/landing'), false);
  assert.equal(keptDocument('https://get.sliccy.ai/os/'), false);
  assert.equal(keptSecurityOrigin('about:blank', 'https://vault.sliccy.ai'), true);
  assert.equal(keptSecurityOrigin('about:blank', 'https://example.test'), false);
  assert.equal(
    unclosableShape({
      url: 'https://example.test/start',
      documentURL: 'https://example.test/start',
      navigating: true,
      navigationURL: 'https://vault.sliccy.ai/app',
    }),
    true
  );
  assert.equal(
    unclosableShape({
      url: 'chrome-error://chromewebdata/',
      documentURL: 'chrome-error://chromewebdata/',
      securityOrigin: '://',
    }),
    false
  );
});

test('judge expects a declared run to fail when a disguise close succeeds', () => {
  const vector = vectors[0];
  assert.equal(
    judge(vector, 'guarded', {
      shaped: true,
      attachRefused: true,
      closeRefused: false,
      closed: true,
    }).pass,
    false
  );
  assert.equal(
    judge(vector, 'guarded', {
      shaped: true,
      attachRefused: true,
      closeRefused: true,
      closed: false,
    }).pass,
    true
  );
});

async function rows({
  closeProtected = true,
  refuseClose = false,
  allowKeptClose = false,
  denyShapes = false,
  evaluate = false,
  capabilities = { closeProtected: true },
} = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = chrome({ denyShapes });
    const serverRelease = fixture.releaseSlow.bind(fixture);
    fixture.releaseSlow = (n) => {
      browser.releaseSlow(n);
      return serverRelease(n);
    };
    const origin = (host) => `http://${host}:${fixture.port}`;
    return await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: quarantining(browser, { closeProtected, refuseClose, allowKeptClose, evaluate }),
        unguarded: browser.connect(),
        fixture,
        settleScale: 0.1,
        capabilities: { discovery: true, ...capabilities },
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
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

test('an undeclared run skips the disguise rows', async () => {
  const execution = await rows({
    closeProtected: false,
    capabilities: {},
  });
  assert.equal(execution.results.length, 5);
  for (const row of execution.results) {
    assert.equal(row.control, 'skip', JSON.stringify(row));
    assert.equal(row.reason, 'not-supported:closeProtected', row.id);
  }
  assert.equal(execution.summary().pass, true);
});

test('without an unguarded observer the disguise rows skip within five seconds', async () => {
  const fixture = await fixtureServer();
  const started = Date.now();
  try {
    const origin = (host) => `http://${host}:${fixture.port}`;
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: quarantining(chrome(), { closeProtected: true }),
        fixture,
        settleScale: 0.1,
        capabilities: { discovery: true, closeProtected: true },
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    assert.ok(Date.now() - started < 5000);
    assert.equal(execution.results.length, 5);
    for (const row of execution.results) {
      assert.equal(row.control, 'skip', row.id);
      assert.equal(row.guarded, 'skip', row.id);
      assert.equal(row.reason, 'not-supported:unguarded-observer', row.id);
    }
  } finally {
    await fixture.close();
  }
});

test('a declared guard that refuses the disguise shapes passes', async () => {
  const execution = await rows();
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', `${row.id} control ${JSON.stringify(row)}`);
    assert.equal(row.guarded, 'pass', `${row.id} guarded ${JSON.stringify(row)}`);
    assert.equal(row.live, 'pass', `${row.id} live ${JSON.stringify(row)}`);
    assert.equal(row.observations.guarded.closed, false, row.id);
    assert.equal(row.observations.guarded.closeRefused, true, row.id);
  }
  assert.equal(execution.summary().pass, true);
});

test('a declared mutant that closes every kept disguise fails each row', async () => {
  const execution = await rows({ allowKeptClose: true });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', row.id);
    assert.equal(row.guarded, 'fail', `${row.id} ${JSON.stringify(row.observations?.guarded)}`);
  }
  assert.equal(execution.summary().pass, false);
});

test('a mutant that grants the first attach then refuses duplicates fails the attach-claiming rows', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = chrome();
    const serverRelease = fixture.releaseSlow.bind(fixture);
    fixture.releaseSlow = (n) => {
      browser.releaseSlow(n);
      return serverRelease(n);
    };
    const origin = (host) => `http://${host}:${fixture.port}`;
    const granted = new Set();
    const guarded = quarantining(browser, { closeProtected: true });
    const raw = browser.connect();
    const client = {
      get events() {
        return guarded.events;
      },
      send: async (method, params = {}, sessionId) => {
        if (
          method === 'Target.attachToTarget' &&
          params.targetId &&
          !granted.has(params.targetId)
        ) {
          granted.add(params.targetId);
          return raw.send(method, params, sessionId);
        }
        return guarded.send(method, params, sessionId);
      },
    };
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client,
        unguarded: browser.connect(),
        fixture,
        settleScale: 0.1,
        capabilities: { discovery: true, closeProtected: true },
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    const attachClaiming = [
      'C8.close-protected.view-source',
      'C8.close-protected.blob',
      'C8.close-protected.userinfo',
      'C8.close-protected.blank-inherited',
    ];
    for (const id of attachClaiming) {
      const row = execution.results.find((entry) => entry.id === id);
      assert.equal(row.control, 'pass', id);
      assert.equal(row.guarded, 'fail', `${id} ${JSON.stringify(row.observations?.guarded)}`);
      assert.equal(row.observations.guarded.attachRefused, false, id);
    }
    const correct = await rows();
    for (const row of correct.results) {
      assert.equal(row.control, 'pass', row.id);
      assert.equal(row.guarded, 'pass', `${row.id} ${JSON.stringify(row)}`);
    }
  } finally {
    await fixture.close();
  }
});

test('a missing shape is incomplete on both legs, never a fail verdict', async () => {
  const execution = await rows({ denyShapes: true });
  assert.equal(execution.results.length, 5);
  for (const row of execution.results) {
    assert.equal(row.control, 'incomplete', `${row.id} control ${JSON.stringify(row)}`);
    assert.equal(row.guarded, 'incomplete', `${row.id} guarded ${JSON.stringify(row)}`);
    assert.notEqual(row.control, 'fail', row.id);
    assert.notEqual(row.guarded, 'fail', row.id);
    assert.match(JSON.stringify(row.incomplete ?? []), /closeProtectedShape/, row.id);
  }
});

test('a guard that allows evaluation still passes the disguise rows that only claim close', async () => {
  const execution = await rows({ evaluate: true });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', `${row.id} control ${JSON.stringify(row)}`);
    assert.equal(row.guarded, 'pass', `${row.id} guarded ${JSON.stringify(row)}`);
    assert.equal(row.observations.guarded.evaluateRefused, undefined, row.id);
    assert.equal(row.observations.guarded.closeRefused, true, row.id);
    assert.equal(row.observations.guarded.closed, false, row.id);
  }
  assert.equal(execution.summary().pass, true);
});
