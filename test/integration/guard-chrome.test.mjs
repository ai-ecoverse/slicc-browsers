import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const capabilities = {
  autoAttach: true,
  browserSession: true,
  browserContexts: true,
  chromeUrlsAttach: true,
};
test('new tab pages stay attachable and navigable with the catalog, but fail with 1.8.1 rules', {
  timeout: 120000,
}, async () => {
  const { protectedOrigins: rules } = JSON.parse(
    await readFile(new URL('../../catalog.json', import.meta.url))
  );
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    const vectors = data.vectors.filter((v) => v.id === 'C8.newtab');
    assert.equal(vectors.length, 1);
    for (const missing of [
      ['chrome://new-tab-page', 'chrome-untrusted://new-tab-page'],
      ['chrome://new-tab-page'],
      [],
    ]) {
      const fixed = missing.length === 0;
      const guard = emulatedGuard(browser, {
        catalogAttachOnly: !fixed,
        protectedOrigins: {
          ...rules,
          schemeExceptions: rules.schemeExceptions.filter((value) => !missing.includes(value)),
        },
      });
      try {
        const execution = await run(
          { ...data, vectors, variants: { prompt: 0 } },
          {
            client: guard.client,
            unguarded: browser.unguarded,
            targets: origins(fixture),
            fixture,
            capabilities,
          }
        );
        assert.equal(execution.results.length, 2);
        for (const row of execution.results) {
          assert.equal(row.control, 'pass', JSON.stringify(row));
          assert.equal(row.guarded, fixed ? 'pass' : 'fail', JSON.stringify({ missing, row }));
          if (fixed) assert.equal(row.live, 'pass', JSON.stringify(row));
        }
      } finally {
        await guard.stop();
      }
    }
    const plain = await run(
      { ...data, vectors, variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        targets: origins(fixture),
        fixture,
        capabilities,
      }
    );
    assert.equal(plain.results.length, 2);
    for (const row of plain.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('C8.newtab is skipped without chromeUrlsAttach and runs with it', {
  timeout: 120000,
}, async () => {
  const vectors = data.vectors.filter((v) => v.id === 'C8.newtab');
  const lacking = { autoAttach: true, browserSession: true, browserContexts: true };
  const fixture = await fixtureServer();
  const calls = [];
  const stub = {
    events: [],
    send: async (method) => {
      calls.push(method);
      return {};
    },
  };
  for (const declared of [lacking, Object.keys(lacking), { ...lacking, chromeUrlsAttach: false }]) {
    const execution = await run(
      { ...data, vectors, variants: { prompt: 0 } },
      { client: stub, unguarded: stub, targets: origins(fixture), fixture, capabilities: declared }
    );
    assert.equal(execution.results.length, 2);
    for (const row of execution.results) {
      assert.equal(row.control, 'skip', JSON.stringify(row));
      assert.equal(row.guarded, 'skip', JSON.stringify(row));
      assert.equal(row.reason, 'not-supported:chromeUrlsAttach', JSON.stringify(row));
    }
    assert.match(execution.summary().line, /not-supported:chromeUrlsAttach=2/);
  }
  assert.deepEqual(calls, []);
  const { protectedOrigins } = JSON.parse(
    await readFile(new URL('../../catalog.json', import.meta.url))
  );
  const browser = await launch(fixture);
  const guard = emulatedGuard(browser, { protectedOrigins });
  try {
    for (const declared of [capabilities, Object.keys(capabilities)]) {
      const execution = await run(
        { ...data, vectors, variants: { prompt: 0 } },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          targets: origins(fixture),
          fixture,
          capabilities: declared,
        }
      );
      assert.equal(execution.results.length, 2);
      for (const row of execution.results) {
        assert.equal(row.reason, undefined, JSON.stringify(row));
        assert.equal(row.control, 'pass', JSON.stringify(row));
        assert.equal(row.guarded, 'pass', JSON.stringify(row));
      }
    }
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});

test('NTP and ordinary error frames stay reachable while protected search frames refuse the tab', async () => {
  const { protectedOrigins: rules } = JSON.parse(
    await readFile(new URL('../../catalog.json', import.meta.url))
  );
  const { urls } = JSON.parse(await readFile(new URL('../../protected.json', import.meta.url)));
  const ntpFrameUrl = urls.find((row) => row.url.includes('/one-google-bar?')).url;
  for (const outOfProcess of [false, true]) {
    for (const { frameUrl, fixed, allowed } of [
      { frameUrl: ntpFrameUrl, fixed: false, allowed: false },
      { frameUrl: ntpFrameUrl, fixed: true, allowed: true },
      { frameUrl: 'chrome-search://most-visited/', fixed: true, allowed: false },
      { frameUrl: 'chrome-error://chromewebdata/', fixed: true, allowed: true },
    ]) {
      const unguarded = {
        events: [],
        send: async (method, params, sessionId) => {
          if (method === 'Target.getTargetInfo')
            return { targetInfo: { url: 'chrome://newtab/', type: 'page' } };
          if (method === 'Target.attachToTarget') return { sessionId: 'reader' };
          if (method === 'Page.getFrameTree')
            return {
              frameTree: {
                frame: { url: 'chrome://newtab/' },
                childFrames: outOfProcess ? [] : [{ frame: { url: frameUrl } }],
              },
            };
          if (method === 'Target.setAutoAttach' && params.autoAttach && outOfProcess)
            unguarded.events.push({
              method: 'Target.attachedToTarget',
              sessionId,
              params: { sessionId: 'frame', targetInfo: { url: frameUrl, type: 'iframe' } },
            });
          return {};
        },
      };
      const calls = [];
      const guard = emulatedGuard(
        {
          unguarded,
          client: {
            events: [],
            send: async (method, params, sessionId) => {
              calls.push({ method, params, sessionId });
              return { sessionId: 'client' };
            },
          },
        },
        {
          protectedOrigins: {
            ...rules,
            schemeExceptions: rules.schemeExceptions.filter(
              (value) => fixed || value !== 'chrome-untrusted://new-tab-page'
            ),
          },
        }
      );
      try {
        const attach = () =>
          guard.client.send('Target.attachToTarget', { targetId: 'ntp', flatten: true });
        if (allowed) {
          const { sessionId } = await attach();
          await guard.client.send('Page.navigate', { url: 'https://example.test/' }, sessionId);
          assert.deepEqual(
            calls.map((call) => call.method),
            ['Target.attachToTarget', 'Page.navigate']
          );
        } else {
          await assert.rejects(attach, /refused.*protected.*frame/);
          assert.deepEqual(calls, []);
        }
      } finally {
        await guard.stop();
      }
    }
  }
});

test('ordinary network-error documents and iframe parents stay readable and recoverable', {
  timeout: 180000,
}, async () => {
  const { protectedOrigins: rules } = JSON.parse(
    await readFile(new URL('../../catalog.json', import.meta.url))
  );
  assert.ok(!rules.protectedSchemes.includes('chrome-error'));
  const vectors = data.vectors.filter((vector) =>
    ['C8.network-error', 'C8.iframe-error'].includes(vector.id)
  );
  assert.equal(vectors.length, 2);
  const fixture = await fixtureServer();
  try {
    for (const mode of ['scheme-wide-error', 'plain', 'catalog']) {
      const browser = await launch(fixture);
      const guard =
        mode === 'plain'
          ? undefined
          : emulatedGuard(browser, {
              protectedOrigins: {
                ...rules,
                protectedSchemes:
                  mode === 'scheme-wide-error'
                    ? [
                        ...rules.protectedSchemes.filter((scheme) => scheme !== 'chrome-error'),
                        'chrome-error',
                      ]
                    : rules.protectedSchemes,
              },
            });
      try {
        const execution = await run(
          { ...data, vectors, variants: { prompt: 0 } },
          {
            client: guard?.client ?? browser.client,
            unguarded: browser.unguarded,
            targets: origins(fixture),
            fixture,
            capabilities,
          }
        );
        assert.equal(execution.results.length, 2);
        if (mode === 'scheme-wide-error') {
          const main = execution.results.find((row) => row.id === 'C8.network-error');
          assert.equal(main.control, 'fail', JSON.stringify(main));
          assert.equal(main.guarded, 'fail', JSON.stringify(main));
          assert.equal(main.observations.guarded.attached, false, JSON.stringify(main));
          for (const row of execution.results)
            process.stdout.write(`scheme-wide chrome-error: ${JSON.stringify(row)}\n`);
        } else {
          for (const row of execution.results) {
            assert.equal(row.control, 'pass', JSON.stringify(row));
            assert.equal(row.guarded, 'pass', JSON.stringify(row));
            assert.equal(row.live, 'pass', JSON.stringify(row));
          }
        }
      } finally {
        await guard?.stop();
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
});

test('a guard that keeps Chrome privileged UI out passes the C8 rows, and no guard fails them', {
  timeout: 300000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  try {
    const { targetInfos } = await browser.unguarded.send('Target.getTargets');
    assert.ok(
      targetInfos.some((info) => info.type === 'browser_ui'),
      'this Chrome has no browser_ui target'
    );
    const { protectedOrigins } = JSON.parse(
      await readFile(new URL('../../catalog.json', import.meta.url))
    );
    const guard = emulatedGuard(browser, {
      protectedHosts: [new URL(origins(fixture).seven).host],
      protectedOrigins,
    });
    const vectors = data.vectors.filter(
      (v) =>
        v.id.startsWith('C8.') &&
        ![
          'C8.newtab',
          'C8.network-error',
          'C8.iframe-error',
          'C8.unparseable',
          'C8.protected-error-page',
          'C8.protected-document-restore',
          'C8.protected-error-page-sticky',
        ].includes(v.id)
    );
    assert.equal(vectors.length, 6);
    const rows = async (client) =>
      (
        await run(
          { ...data, vectors, variants: { prompt: 0 } },
          { client, unguarded: browser.unguarded, targets: origins(fixture), fixture, capabilities }
        )
      ).results;
    try {
      for (const row of await rows(guard.client)) {
        assert.equal(row.control, 'pass', JSON.stringify(row));
        assert.equal(row.guarded, 'pass', JSON.stringify(row));
        assert.equal(row.live, 'pass', JSON.stringify(row));
      }
    } finally {
      await guard.stop();
    }
    const stale = emulatedGuard(browser, {
      protectedOrigins: {
        ...protectedOrigins,
        protectedSchemes: protectedOrigins.protectedSchemes.filter(
          (scheme) => scheme !== 'chrome-search'
        ),
      },
    });
    try {
      const execution = await run(
        {
          ...data,
          vectors: vectors.filter((vector) => vector.id === 'C8.chrome-search'),
          variants: { prompt: 0 },
        },
        {
          client: stale.client,
          unguarded: browser.unguarded,
          targets: origins(fixture),
          fixture,
          capabilities,
        }
      );
      assert.equal(execution.results.length, 1);
      assert.equal(execution.results[0].control, 'pass', JSON.stringify(execution.results));
      assert.equal(execution.results[0].guarded, 'fail', JSON.stringify(execution.results));
    } finally {
      await stale.stop();
    }
    for (const row of await rows(browser.client)) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'fail', JSON.stringify(row));
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
});
