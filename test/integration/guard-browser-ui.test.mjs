import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vector = set.vectors.find((item) => item.id === 'C8.browser-ui-attach');
const capabilities = { browserSession: true, browserContexts: true, chromeUrlsAttach: true };
const gone = 'attach failed without a refusal: No target with given id found';

function cdpError(message) {
  return Object.assign(new Error(message), { cdp: { code: -32602, message } });
}

function chrome({ closing = () => false, broken = false } = {}) {
  let latest = 1;
  let live = 1;
  const attaches = [];
  const client = {
    events: [],
    messages: [],
    async send(method, params = {}) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (method === 'Target.getTargets')
        return {
          targetInfos: [
            { targetId: 'PAGE', type: 'page', url: 'about:blank', attached: false },
            ...(live
              ? [
                  {
                    targetId: `UI-${live}`,
                    type: 'browser_ui',
                    url: 'chrome://tab-search.top-chrome/',
                    attached: false,
                  },
                ]
              : []),
          ],
        };
      if (method === 'Target.createBrowserContext') return { browserContextId: 'CONTEXT' };
      if (method === 'Target.attachToTarget') {
        attaches.push(params.targetId);
        if (params.targetId === `UI-${live}` && closing(attaches.length)) {
          live = 0;
          setTimeout(() => {
            live = ++latest;
          }, 30);
        }
        if (params.targetId !== `UI-${live}`) throw cdpError('No target with given id found');
        if (broken) throw cdpError('the fake cannot attach to a browser_ui target');
        return { sessionId: `SESSION-${attaches.length}` };
      }
      return {};
    },
    waitEvent: () => new Promise(() => {}),
  };
  return { client, attaches };
}

function refusing(browser) {
  const asked = [];
  const client = {
    events: browser.client.events,
    messages: [],
    send: async (method, params, sessionId) => {
      if (method !== 'Target.attachToTarget') return browser.client.send(method, params, sessionId);
      asked.push(params.targetId);
      throw new Error("slicc: refused: target is on seven's origin");
    },
    waitEvent: browser.client.waitEvent,
  };
  return { client, asked };
}

async function row(client, unguarded) {
  const fixture = await fixtureServer();
  try {
    const origin = (host) => `http://${host}:${fixture.port}`;
    const { results } = await run(
      { ...set, vectors: [vector], variants: { prompt: 0 } },
      {
        client,
        unguarded,
        fixture,
        capabilities,
        targets: {
          ordinary: origin('ordinary.example.test'),
          plain: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    assert.equal(results.length, 1);
    return results[0];
  } finally {
    await fixture.close();
  }
}

test('a browser_ui target that closes as each leg attaches is replaced, so the unguarded control passes and the protection fails', async () => {
  const browser = chrome({ closing: (attach) => attach === 1 || attach === 3 });
  const result = await row(browser.client, browser.client);
  assert.equal(result.control, 'pass', JSON.stringify(result));
  assert.equal(result.guarded, 'fail', JSON.stringify(result));
  assert.equal(result.live, 'pass', JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.observations.control, { attach: false, attached: true, refused: false });
  assert.deepEqual(browser.attaches, ['UI-1', 'UI-2', 'UI-2', 'UI-3']);
  assert.deepEqual(result.notes, [
    'control {browserUi} UI-1 was gone when Target.attachToTarget reached it; retried with UI-2',
    'guarded {browserUi} UI-2 was gone when Target.attachToTarget reached it; retried with UI-3',
  ]);
});

test('a guard refuses the replacement browser_ui target after the control lost its first one', async () => {
  const browser = chrome({ closing: (attach) => attach === 1 });
  const guard = refusing(browser);
  const result = await row(guard.client, browser.client);
  assert.equal(result.control, 'pass', JSON.stringify(result));
  assert.equal(result.guarded, 'pass', JSON.stringify(result));
  assert.equal(result.live, 'pass', JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(browser.attaches, ['UI-1', 'UI-2']);
  assert.deepEqual(guard.asked, ['UI-2']);
});

test('a control whose browser_ui targets all close before it attaches stays a failure after three attempts', async () => {
  const browser = chrome({ closing: () => true });
  const result = await row(browser.client, browser.client);
  assert.equal(result.control, 'fail', JSON.stringify(result));
  assert.equal(result.guarded, 'fail', JSON.stringify(result));
  assert.equal(result.observations.control.attached, false);
  assert.deepEqual(result.errors, [gone, gone]);
  assert.deepEqual(browser.attaches, ['UI-1', 'UI-2', 'UI-3', 'UI-4', 'UI-5', 'UI-6']);
  assert.equal(result.notes.length, 4);
});

test('an attach that fails while its browser_ui target is still listed is not retried', async () => {
  const browser = chrome({ broken: true });
  const result = await row(browser.client, browser.client);
  assert.equal(result.control, 'fail', JSON.stringify(result));
  assert.equal(result.observations.control.attached, false);
  assert.deepEqual(browser.attaches, ['UI-1', 'UI-1']);
  assert.equal(result.notes, undefined);
  assert.match(result.errors[0], /the fake cannot attach to a browser_ui target/);
});
