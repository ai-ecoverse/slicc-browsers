import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';

const data = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);
const navigation = () => ({
  id: 'C1.live',
  kind: 'cdp',
  scope: 'any',
  targets: ['seven'],
  setup: [{ page: 'tab', url: '{ordinary}/doc?n={tag}' }],
  trigger: [
    { page: 'href', url: '{target}/doc?n={tag}' },
    { settle: { ms: 200 } },
    { page: 'eval', expression: 'location.href', as: 'href' },
  ],
  observe: {
    reached: {
      check: {
        result: 'href',
        path: 'result.result.value',
        equals: '{target}/doc?n={tag}',
        observer: 'client',
      },
    },
  },
  control: { origin: 'ordinary', via: 'unguarded', expected: { reached: true } },
  expected: { reached: false },
  liveCheck: {
    any: [
      { loaded: '{target}/doc?n={tag}', observer: 'fixture' },
      {
        all: [
          { pre: '{target}/doc?n={tag}', observer: 'fixture' },
          { blocked: { url: '{target}/doc?n={tag}' }, observer: 'client' },
        ],
        observer: 'client',
      },
    ],
    observer: 'client',
  },
});

test('successful transport replies cannot certify a silently discarded navigation', async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    const targets = origins(fixture);
    const client = {
      ...browser.client,
      send: (method, params, session) =>
        browser.client.send(
          method,
          method === 'Runtime.evaluate' &&
            params.expression.includes('location.href=') &&
            params.expression.includes(targets.seven)
            ? { ...params, expression: 'true' }
            : params,
          session
        ),
    };
    const execution = await run(
      { ...data, vectors: [navigation()], variants: { prompt: 0 } },
      { client, unguarded: browser.unguarded, targets, fixture }
    );
    assert.equal(execution.results[0].control, 'pass');
    assert.equal(execution.results[0].live, 'fail');
    assert.equal(execution.summary().pass, false);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('an exact blocked navigation is evidenced by a pre-action request and real browser error', async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const targets = origins(fixture);
  const raw = browser.client;
  let stopped = false;
  let cursor = 0;
  const answering = (async () => {
    while (!stopped) {
      for (const event of raw.events.slice(cursor)) {
        cursor++;
        if (event.method === 'Fetch.requestPaused')
          await raw
            .send(
              'Fetch.failRequest',
              { requestId: event.params.requestId, errorReason: 'BlockedByClient' },
              event.sessionId
            )
            .catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  try {
    const client = {
      ...raw,
      send: async (method, params, session) => {
        if (
          method === 'Runtime.evaluate' &&
          params.expression.includes('location.href=') &&
          params.expression.includes(targets.seven)
        )
          await raw.send(
            'Fetch.enable',
            { patterns: [{ urlPattern: `${targets.seven}/*` }] },
            session
          );
        return raw.send(method, params, session);
      },
    };
    const vector = navigation();
    vector.liveCheck = {
      all: [
        { pre: '{target}/doc?n={tag}', observer: 'fixture' },
        { blocked: { url: '{target}/doc?n={tag}' }, observer: 'client' },
      ],
      observer: 'client',
    };
    const execution = await run(
      { ...data, vectors: [vector], variants: { prompt: 0 } },
      { client, unguarded: browser.unguarded, targets, fixture }
    );
    assert.equal(execution.results[0].control, 'pass');
    assert.equal(execution.results[0].live, 'pass');
    assert.equal(execution.results[0].guarded, 'pass');
    const logs = fixture.log();
    assert(logs.some((entry) => new URL(entry.url).searchParams.get('step') === 'pre'));
    assert(
      !logs.some(
        (entry) =>
          new URL(entry.url).origin === targets.seven && new URL(entry.url).pathname === '/doc'
      )
    );
  } finally {
    stopped = true;
    await answering;
    await browser.close();
    await fixture.close();
  }
});

test('refused writes are checked against independently seeded stand-in state', async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    const vector = data.vectors.find((v) => v.id === 'C6.setCookie');
    const targets = origins(fixture);
    const client = {
      ...browser.client,
      send: async (method, params, session) => {
        if (method === 'Network.setCookie' && params.url === `${targets.seven}/`) {
          await browser.client.send('Network.clearBrowserCookies', {}, session);
          throw new Error('slicc: refused');
        }
        return browser.client.send(method, params, session);
      },
    };
    const execution = await run(
      { ...data, vectors: [{ ...vector, targets: ['seven'] }], variants: { prompt: 0 } },
      {
        client,
        unguarded: browser.unguarded,
        targets,
        fixture,
        capabilities: { browserContexts: true, browserSession: true },
      }
    );
    assert.equal(execution.results[0].control, 'pass');
    assert.equal(execution.results[0].live, 'fail');
    assert.equal(execution.summary().pass, false);
  } finally {
    await browser.close();
    await fixture.close();
  }
});
