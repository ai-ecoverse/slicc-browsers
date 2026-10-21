import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { redirectSecret } from '../../redirect-secret.mjs';

const ordinary = 'http://ordinary.example.test:4180';
const refusal = () => new Error('slicc: refused: protected redirect body');

function fake({ network, fetch = true, leak = false, raw = false, tap = true, late = false }) {
  const routes = new Map();
  const log = [];
  let next = 0;
  let count = 0;
  const held = [];
  const make = () => ({ events: [], messages: [] });
  const client = make();
  const reader = make();
  const emit = (target, sessionId, method, params) => {
    const event = { method, params, sessionId };
    if (target === reader && !tap) return;
    target.events.push(event);
    target.messages.push(JSON.stringify(event));
  };
  const request = (url) => {
    const route = routes.get(new URL(url).pathname);
    if (!route?.to) return;
    const id = `N${++count}`;
    log.push({ url, headers: {} });
    const to = new URL(route.to);
    const hop = {
      requestId: id,
      request: { url: raw === 'ordinary' ? `${ordinary}/plain` : raw ? route.to : to.origin },
      redirectResponse: { url, status: route.code ?? 302, headers: { location: to.origin } },
    };
    emit(reader, 'O1', 'Network.requestWillBeSent', { requestId: id, request: { url } });
    emit(reader, 'O1', 'Network.requestWillBeSent', {
      ...hop,
      request: { url: route.to },
      redirectResponse: { ...hop.redirectResponse, headers: { location: route.to } },
    });
    if (!['none', 'hop-only'].includes(network))
      emit(client, 'S1', 'Network.requestWillBeSent', { requestId: id, request: { url } });
    if (fetch === true || (fetch === 'odd' && count % 2))
      emit(client, 'S1', 'Fetch.requestPaused', {
        requestId: `F${count}`,
        networkId: id,
        request: { url },
        responseStatusCode: route.code ?? 302,
        responseHeaders: [{ name: 'location', value: to.origin }],
      });
    if (['redact', 'hop-only'].includes(network)) {
      const end = () => {
        emit(client, 'S1', 'Network.requestWillBeSent', hop);
        emit(client, 'S1', 'Network.loadingFinished', { requestId: id });
      };
      if (late && count === 16) held.push(end);
      else end();
    }
    if (network === 'failed')
      emit(client, 'S1', 'Network.loadingFailed', {
        requestId: id,
        errorText: 'net::ERR_BLOCKED_BY_CLIENT',
        blockedReason: 'inspector',
      });
  };
  const continued = new Set();
  const waiting = new Map();
  const handle = (method, params) => {
    if (method === 'Fetch.continueRequest') {
      const n = params.requestId.slice(1);
      continued.add(n);
      waiting.get(n)?.(refusal());
    }
    if (method === 'Page.navigate') request(params.url);
    if (method === 'Fetch.disable') for (const end of held.splice(0)) setTimeout(end, 1500);
    if (method === 'Runtime.evaluate') {
      const url = params.expression.match(/"(http[^"]+)"/)?.[1];
      if (url) request(url);
      return { result: { type: 'string', value: 'doc' } };
    }
    if (method === 'Fetch.getResponseBody') throw refusal();
    if (method === 'Network.getResponseBody') {
      if (leak === 'hang') return new Promise(() => {});
      if (leak === 'slow')
        return new Promise((resolve, reject) => setTimeout(() => reject(refusal()), 300));
      if (leak === 'after-continue' && !continued.has(params.requestId.slice(1)))
        return new Promise((resolve, reject) => waiting.set(params.requestId.slice(1), reject));
      if (leak === 'even' ? Number(params.requestId.slice(1)) % 2 === 0 : leak)
        return { body: `leaked ${marker}`, base64Encoded: false };
      throw refusal();
    }
    return {};
  };
  let marker;
  client.send = async (method, params = {}) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      const result = await handle(method, params);
      client.messages.push(JSON.stringify({ id: ++next, result }));
      return result;
    } catch (error) {
      client.messages.push(JSON.stringify({ id: ++next, error: { message: error.message } }));
      throw error;
    }
  };
  reader.send = async (method) => {
    if (method === 'Target.attachToTarget') return { sessionId: 'O1' };
    return {};
  };
  const fixture = {
    async redirectSecret(entry) {
      if (entry.remove) routes.delete(entry.path);
      else routes.set(entry.path, entry);
      if (entry.body && !entry.to) marker ??= entry.body.replace('protected-body-', '');
    },
    log: async () => log,
  };
  return { client, reader, fixture };
}

const probe = (options, controls = { networkEvents: true }, leg = {}) => {
  const browser = fake(options);
  return redirectSecret({
    ...leg,
    ...browser,
    session: 'S1',
    targetId: 'T1',
    ordinary,
    tag: `t${Math.random().toString(36).slice(2, 8)}`,
    mode: 'headers',
    side: leg.side ?? 'guarded',
    controls,
    settleScale: leg.settleScale,
  });
};

const deliveries = (out) => [...new Set(Object.values(out.hops).map((hop) => hop.delivery))];
const terminals = (out) => [...new Set(Object.values(out.hops).map((hop) => hop.terminal))];

test.describe('C2 redirect network-body carrier and request termination', {
  concurrency: true,
  timeout: 120000,
}, () => {
  test('withheld Network events: the Fetch networkId carries the refused network body read', async () => {
    const out = await probe({ network: 'none' });
    assert.equal(out.networkBodyPath, 'fetch-networkId');
    assert.equal(out.networkBodyAttempted, true);
    assert.equal(out.networkBodyRefused, true);
    assert.equal(out.secretHidden, true);
    assert.equal(out.requestsTerminated, true);
    assert.equal(out.incomplete, undefined);
  });

  test('a body leaked over Network with only the Fetch networkId known fails', async () => {
    const out = await probe({ network: 'none', leak: true });
    assert.equal(out.networkBodyPath, 'fetch-networkId');
    assert.equal(out.networkBodyAttempted, true);
    assert.equal(out.networkBodyRefused, false);
    assert.equal(out.secretHidden, false);
    assert.ok(out.leakChannels.includes('Network.getResponseBody'));
  });

  test('withheld Network and Fetch: the raw tap supplies the real id and the read is refused', async () => {
    const out = await probe({ network: 'none', fetch: false });
    assert.equal(out.networkBodyPath, 'withheld+tap');
    assert.equal(out.networkBodyAttempted, true);
    assert.equal(out.networkBodyRefused, true);
    assert.equal(out.fetchBodyAttempted, false);
  });

  test('a hop without a guarded carrier is still read with the tap id and its leak fails', async () => {
    const out = await probe({ network: 'none', fetch: 'odd', leak: 'even' });
    assert.equal(out.networkBodyPath, 'withheld+tap');
    assert.ok(out.networkBodyCarriers['fetch-networkId'] > 0);
    assert.ok(out.networkBodyCarriers['withheld+tap'] > 0);
    assert.equal(out.networkBodyAttempted, true);
    assert.equal(out.networkBodyRefused, false);
  });

  test('a network body read the guard never answers is not a refusal', async () => {
    const out = await probe({ network: 'none', leak: 'hang' });
    assert.equal(out.networkBodyAttempted, true);
    assert.equal(out.networkBodyRefused, false);
  });

  test('a network body read answered only after its Fetch pause continues does not stall the probe', {
    timeout: 60000,
  }, async () => {
    const out = await probe({ network: 'none', leak: 'after-continue' });
    assert.equal(out.networkBodyPath, 'fetch-networkId');
    assert.equal(out.networkBodyAttempted, true);
    assert.equal(out.networkBodyRefused, true);
    assert.equal(out.sessionSurvives, true);
  });

  test('no network id from events, Fetch or tap is incomplete, never a pass', async () => {
    const out = await probe({ network: 'none', fetch: false, tap: false });
    assert.equal(out.networkBodyPath, 'none');
    assert.equal(out.networkBodyAttempted, 'incomplete');
    assert.equal(out.networkBodyRefused, 'incomplete');
    assert.match(out.incomplete, /network body leg no network id/);
  });

  test('a withheld leg without the control proving the Network events is incomplete', async () => {
    const out = await probe({ network: 'none' }, {});
    assert.equal(out.networkBodyAttempted, 'incomplete');
    assert.match(out.incomplete, /control did not prove/);
  });

  test('a withholding transport that sends loadingFailed terminates every seen request', async () => {
    const out = await probe({ network: 'failed' });
    assert.equal(out.requestsTerminated, true);
    assert.deepEqual(deliveries(out), ['withheld']);
    assert.deepEqual(terminals(out), ['Network.loadingFailed']);
    assert.equal(Object.keys(out.hops).length, 16);
    assert.equal(out.networkBodyPath, 'fetch-networkId');
  });

  test('the same withholding transport without a terminal event fails as unterminated', async () => {
    const out = await probe({ network: 'silent' });
    assert.equal(out.requestsTerminated, false);
    assert.deepEqual(deliveries(out), ['unterminated']);
    assert.deepEqual(terminals(out), [null]);
  });

  test('a control request whose terminal event lands after the tail is awaited, not failed', async () => {
    const out = await probe({ network: 'redact', late: true }, {}, { side: 'control' });
    assert.equal(out.requestsTerminated, true);
    assert.equal(Object.keys(out.hops).length, 16);
    assert.deepEqual(terminals(out), ['Network.requestWillBeSent']);
    assert.equal(out.incomplete, undefined);
  });

  test('a guarded request whose terminal event lands after the tail is awaited too', async () => {
    const out = await probe({ network: 'redact', late: true });
    assert.equal(out.requestsTerminated, true);
    assert.deepEqual(deliveries(out), ['redacted']);
  });

  test('a body read started by a late terminal event is drained before the evidence', async () => {
    const out = await probe({
      network: 'redact',
      late: true,
      fetch: false,
      tap: false,
      leak: 'slow',
    });
    assert.equal(out.requestsTerminated, true);
    assert.equal(out.networkBodyPath, 'network');
    assert.equal(out.networkBodyCarriers.network, 16);
    assert.equal(out.networkBodyRefused, true);
  });

  test('a control request that never terminates is missing evidence, not a control failure', async () => {
    const out = await probe({ network: 'silent' }, {}, { side: 'control', settleScale: 0.25 });
    assert.equal(out.requestsTerminated, 'incomplete');
    assert.deepEqual(deliveries(out), ['unterminated']);
    assert.match(out.incomplete, /^redirect-secret: control requests N1, .*N16 unterminated$/);
  });

  test('a guarded request that never terminates still fails, waiting the bound for one hop only', async () => {
    const start = Date.now();
    const out = await probe({ network: 'silent' });
    assert.ok(Date.now() - start < 30000, `took ${Date.now() - start} ms`);
    assert.equal(out.requestsTerminated, false);
    assert.deepEqual(deliveries(out), ['unterminated']);
    assert.equal(out.incomplete, undefined);
  });

  test('a redact-in-place transport terminates with an origin-only redirect', async () => {
    const out = await probe({ network: 'redact' });
    assert.equal(out.requestsTerminated, true);
    assert.equal(out.hopsRedacted, true);
    assert.deepEqual(deliveries(out), ['redacted']);
    assert.deepEqual(terminals(out), ['Network.requestWillBeSent']);
    assert.equal(out.networkBodyPath, 'network');
    assert.equal(out.networkBodyRefused, true);
  });

  test('an in-place protected redirect substituted with an ordinary URL is not redacted', async () => {
    const out = await probe({ network: 'redact', raw: 'ordinary' });
    assert.equal(out.hopsRedacted, false);
    assert.deepEqual(deliveries(out), ['ordinary']);
  });

  test('a substituted hop delivered without its initial request event is still classified', async () => {
    const out = await probe({ network: 'hop-only', raw: 'ordinary' });
    assert.equal(Object.keys(out.hops).length, 16);
    assert.equal(out.hopsRedacted, false);
    assert.deepEqual(deliveries(out), ['ordinary']);
  });

  test('an in-place redirect carrying the raw protected URL is never accepted', async () => {
    const out = await probe({ network: 'redact', raw: true });
    assert.equal(out.hopsRedacted, false);
    assert.deepEqual(deliveries(out), ['raw']);
  });
});

test('every C2 redirect row holds the network-body leg, request termination and hop redaction', async () => {
  const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
  const rows = set.vectors.filter((vector) => vector.id.startsWith('C2.redirect'));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    for (const key of [
      'networkBodyAttempted',
      'networkBodyRefused',
      'requestsTerminated',
      'hopsRedacted',
    ])
      assert.equal(row.expected[key], true, `${row.id} ${key}`);
    for (const key of ['networkBodyAttempted', 'requestsTerminated'])
      assert.equal(row.control.expected[key], true, `${row.id} control ${key}`);
  }
});
