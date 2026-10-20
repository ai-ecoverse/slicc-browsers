import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const data = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const { protectedOrigins } = JSON.parse(
  await readFile(new URL('../../catalog.json', import.meta.url))
);
const out = (x) => process.stdout.write(`DIAG ${JSON.stringify(x)}\n`);
const ids = [];
const unused = [
  'E4.event-listener',
  'E6.network-conditions',
  'E6.network-state',
  'E6.network-conditions.iframe',
  'E6.headers.iframe',
];

test('diag', { timeout: 600000 }, async () => {
  const fixture = await fixtureServer();
  const targets = origins(fixture);
  for (const mode of ['raw', 'emulated']) {
    for (const id of ids) {
      const browser = await launch(fixture);
      const guard =
        mode === 'emulated'
          ? emulatedGuard(browser, {
              protectedHosts: [new URL(targets.seven).host],
              protectedOrigins: {
                ...protectedOrigins,
                domains: [],
                hosts: [new URL(targets.seven).hostname],
              },
              exposeExtensionWorlds: true,
            })
          : undefined;
      const client = guard?.client ?? browser.client;
      try {
        const vector = { ...data.vectors.find((v) => v.id === id), targets: ['seven'] };
        const execution = await run(
          { ...data, vectors: [vector], variants: { prompt: 0 } },
          {
            client,
            unguarded: browser.unguarded,
            targets,
            fixture,
            capabilities: { autoAttach: true, browserSession: true, browserContexts: true },
          }
        );
        const r = execution.results[0];
        out({
          mode,
          id,
          control: r.control,
          guarded: r.guarded,
          live: r.live,
          why: r.why,
          errors: r.errors,
          obs: r.observations,
        });
        out({
          mode,
          id,
          events: browser.client.events
            .filter((e) => /^Debugger\.paused|^DOMDebugger/.test(e.method))
            .map((e) => ({
              m: e.method,
              reason: e.params.reason,
              data: e.params.data,
              urls: e.params.callFrames?.map((c) => c.url),
            })),
        });
      } finally {
        await guard?.stop();
        await browser.close();
      }
    }
  }
  const browser = await launch(fixture);
  try {
    const c = browser.client;
    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    const ev = async (expression) =>
      (
        await c.send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId
        )
      ).result.value;
    const nav = async (url) => {
      await c.send('Page.navigate', { url }, sessionId);
      await new Promise((r) => setTimeout(r, 4000));
    };
    await c.send('Page.enable', {}, sessionId);
    await c.send('Network.enable', {}, sessionId);
    out({
      step: 'conditions',
      r: await c
        .send(
          'Network.emulateNetworkConditions',
          { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 },
          sessionId
        )
        .catch((e) => String(e.message)),
    });
    await nav(`${targets.ordinary}/doc?n=diag-1`);
    out({
      step: 'timing',
      v: await ev(
        'JSON.stringify({href: location.href, nav: performance.getEntriesByType("navigation")[0], rtt: navigator.connection && navigator.connection.rtt})'
      ),
    });
    out({
      step: 'state',
      r: await c
        .send(
          'Network.overrideNetworkState',
          { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
          sessionId
        )
        .catch((e) => String(e.message)),
    });
    out({ step: 'online-now', v: await ev('String(navigator.onLine)') });
    await nav(`${targets.ordinary}/doc?n=diag-2`);
    out({ step: 'online-after', v: await ev('String(navigator.onLine)') });
    const side = await browser.unguarded.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.unguarded.send('Page.enable', {}, side.sessionId);
    await browser.unguarded.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] },
      side.sessionId
    );
    const pump = setInterval(() => {
      for (const e of browser.unguarded.events.splice(0))
        if (e.method === 'Fetch.requestPaused')
          browser.unguarded
            .send('Fetch.continueRequest', { requestId: e.params.requestId }, e.sessionId)
            .catch(() => {});
    }, 20);
    out({ step: 'side-online-now', v: await ev('String(navigator.onLine)') });
    await c.send(
      'Network.overrideNetworkState',
      { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      sessionId
    );
    out({ step: 'side-online-reset', v: await ev('String(navigator.onLine)') });
    await nav(`${targets.ordinary}/doc?n=diag-4`);
    out({ step: 'side-online-after-same-site', v: await ev('String(navigator.onLine)') });
    await nav(`${targets.seven}/doc?n=diag-5`);
    out({ step: 'side-online-after-cross-site', v: await ev('String(navigator.onLine)') });
    clearInterval(pump);
    await c.send('Debugger.enable', {}, sessionId);
    out({
      step: 'listener',
      r: await c
        .send('DOMDebugger.setEventListenerBreakpoint', { eventName: 'load' }, sessionId)
        .catch((e) => String(e.message)),
    });
    const start = c.events.length;
    c.send('Page.navigate', { url: `${targets.ordinary}/doc?n=diag-3&listener=1` }, sessionId);
    await new Promise((r) => setTimeout(r, 4000));
    out({
      step: 'paused',
      ev: c.events
        .slice(start)
        .filter((e) => e.method === 'Debugger.paused')
        .map((e) => ({
          reason: e.params.reason,
          data: e.params.data,
          urls: e.params.callFrames?.map((f) => f.url),
        })),
    });
    await c.send('Debugger.disable', {}, sessionId).catch(() => {});
  } finally {
    await browser.close();
    await fixture.close();
  }
});
