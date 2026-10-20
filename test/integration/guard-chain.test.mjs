import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { expand, hop, parseURL } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const hops = [
  { origin: '{ordinary}', code: 302 },
  { origin: '{cross}', code: 307 },
];
const to = '{target}/doc?n=chain';
const alternatives = [...hops.map((_, index) => ({ hops, to, index })), to];
const selected = (vectors) => ({ ...data, vectors, variants: { prompt: 0 } });

for (const page of ['href', 'open'])
  for (const observer of ['client', 'unguarded'])
    for (const index of [0, 1, 2])
      test(`${page} redirect liveness accepts ${observer} evidence at chain index ${index}`, async () => {
        const fixture = await fixtureServer();
        try {
          const browser = await launch(fixture);
          try {
            const targets = origins(fixture);
            const candidate = expand(alternatives[index], { ...targets, target: targets.seven });
            const blockedURL =
              typeof candidate === 'string'
                ? candidate
                : hop(candidate.hops.slice(candidate.index), candidate.to);
            const enable = {
              cdp: 'Fetch.enable',
              params: { patterns: [{ urlPattern: '*', resourceType: 'Document' }] },
              on: 'guarded',
            };
            const vector = {
              id: 'C2.evidence',
              kind: 'cdp',
              scope: 'any',
              targets: ['seven'],
              setup: [
                { page: 'tab', url: '{ordinary}/doc?n={tag}' },
                ...(page === 'open'
                  ? [
                      { children: [{ cdp: 'Page.enable' }, { cdp: 'Network.enable' }, enable] },
                      {
                        cdp: 'Target.setAutoAttach',
                        session: 'browser',
                        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
                      },
                    ]
                  : [enable]),
                {
                  answer: {
                    url: blockedURL,
                    cdp: 'Fetch.failRequest',
                    params: { errorReason: 'BlockedByClient' },
                  },
                  on: 'guarded',
                },
              ],
              trigger: [{ page, url: to, hops }, { wait: 300 }],
              observe: { loaded: { check: { served: to, tagged: false, observer: 'fixture' } } },
              liveCheck: {
                all: [
                  { pre: { hops, to }, observer: 'fixture' },
                  {
                    blocked: { anyOf: alternatives, session: page === 'open' ? 'child' : 'page' },
                    observer,
                  },
                ],
                observer: 'client',
              },
              control: { origin: 'ordinary', via: 'unguarded', expected: { loaded: true } },
              expected: { loaded: false },
            };
            const execution = await run(selected([vector]), {
              client: browser.client,
              unguarded: browser.unguarded,
              capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
              targets: origins(fixture),
              fixture,
            });
            const row = execution.results[0];
            assert.equal(row.control, 'pass', JSON.stringify(row));
            assert.equal(row.guarded, 'pass', JSON.stringify(row));
            assert.equal(row.live, 'pass', JSON.stringify(row));
            const pre = fixture
              .log()
              .find((entry) => parseURL(entry.url)?.searchParams.get('step') === 'pre');
            assert(pre, 'the chain still requires the pre-action beacon');
            const frameErrors = browser.client.events.filter(
              (event) => event.method === 'Page.frameNavigated' && event.params.frame.unreachableUrl
            );
            assert(frameErrors.length > 0);
          } finally {
            await browser.close();
          }
        } finally {
          await fixture.close();
        }
      });

test('continue-response observes the real status-prefixed body', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    try {
      const vector = structuredClone(data.vectors.find((v) => v.id === 'C5.continue-response'));
      vector.targets = ['seven'];
      vector.setup.find((step) => step.answer).answer.params.responseCode = 200;
      vector.control.expected = vector.expected = { seen: true, changed: false, answered: true };
      const execution = await run(selected([vector]), {
        client: browser.client,
        unguarded: browser.unguarded,
        targets: origins(fixture),
        fixture,
      });
      const row = execution.results[0];
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
    } finally {
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
});

test('popup detachment observations read the navigated child session', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    let stopped = false;
    let cursor = 0;
    const detached = new Set();
    const watcher = (async () => {
      while (!stopped) {
        for (const event of browser.client.events.slice(cursor)) {
          cursor++;
          if (
            event.method === 'Page.frameNavigated' &&
            event.params.frame.url.includes('/doc?n=') &&
            event.params.frame.url.includes('sliccy.ai') &&
            !detached.has(event.sessionId)
          ) {
            detached.add(event.sessionId);
            await browser.client.send('Target.detachFromTarget', { sessionId: event.sessionId });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    try {
      const vector = {
        id: 'C3.child-evidence',
        kind: 'cdp',
        scope: 'any',
        targets: ['seven'],
        setup: [
          { page: 'tab', url: '{ordinary}/doc?n={tag}' },
          { children: [{ cdp: 'Page.enable' }] },
          {
            cdp: 'Target.setAutoAttach',
            session: 'browser',
            params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          },
          { page: 'open', url: 'about:blank' },
        ],
        trigger: [{ page: 'href', url: to, session: 'child' }, { wait: 300 }],
        observe: {
          detached: {
            check: data.vectors.find((v) => v.id === 'C3.popup-self-nav').observe.detached.check,
          },
        },
        liveCheck: { loaded: to, observer: 'fixture' },
        control: { origin: 'ordinary', via: 'guard', expected: { detached: false } },
        expected: { detached: true },
      };
      const execution = await run(selected([vector]), {
        client: browser.client,
        unguarded: browser.unguarded,
        targets: origins(fixture),
        fixture,
        capabilities: { autoAttach: true, browserContexts: true },
      });
      const row = execution.results[0];
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
      assert.equal(detached.size, 1);
    } finally {
      stopped = true;
      await watcher;
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
});

test('popup auto-attach cleanup is not evidence of guard detachment', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = await launch(fixture);
    try {
      const vector = {
        ...data.vectors.find((v) => v.id === 'C3.popup-self-nav'),
        targets: ['seven'],
      };
      const execution = await run(selected([vector]), {
        client: browser.client,
        unguarded: browser.unguarded,
        targets: origins(fixture),
        fixture,
        capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
      });
      const row = execution.results[0];
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'fail', JSON.stringify(row));
      assert.equal(row.observations.control.detached, false);
      assert.equal(row.observations.guarded.detached, false);
      assert(browser.client.events.some((event) => event.method === 'Target.detachedFromTarget'));
    } finally {
      await browser.close();
    }
  } finally {
    await fixture.close();
  }
});
