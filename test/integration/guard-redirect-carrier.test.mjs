import assert from 'node:assert/strict';
import test from 'node:test';
import { redirectSecret } from '../../redirect-secret.mjs';

const ordinary = 'http://ordinary.example.test:4180';
const refusal = () => new Error('slicc: refused: protected redirect body');

function fake({ network, fetch = true, leak = false, raw = false, tap = true }) {
  const routes = new Map();
  const log = [];
  let next = 0;
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
    const id = `N${++next}`;
    log.push({ url, headers: {} });
    const to = new URL(route.to);
    const hop = {
      requestId: id,
      request: { url: raw ? route.to : to.origin },
      redirectResponse: { url, status: route.code ?? 302, headers: { location: to.origin } },
    };
    emit(reader, 'O1', 'Network.requestWillBeSent', { requestId: id, request: { url } });
    emit(reader, 'O1', 'Network.requestWillBeSent', {
      ...hop,
      request: { url: route.to },
      redirectResponse: { ...hop.redirectResponse, headers: { location: route.to } },
    });
    if (network !== 'none')
      emit(client, 'S1', 'Network.requestWillBeSent', { requestId: id, request: { url } });
    if (fetch)
      emit(client, 'S1', 'Fetch.requestPaused', {
        requestId: `F${next}`,
        networkId: id,
        request: { url },
        responseStatusCode: route.code ?? 302,
        responseHeaders: [{ name: 'location', value: to.origin }],
      });
    if (network === 'redact') {
      emit(client, 'S1', 'Network.requestWillBeSent', hop);
      emit(client, 'S1', 'Network.loadingFinished', { requestId: id });
    }
    if (network === 'failed')
      emit(client, 'S1', 'Network.loadingFailed', {
        requestId: id,
        errorText: 'net::ERR_BLOCKED_BY_CLIENT',
        blockedReason: 'inspector',
      });
  };
  const handle = (method, params) => {
    if (method === 'Page.navigate') request(params.url);
    if (method === 'Runtime.evaluate') {
      const url = params.expression.match(/"(http[^"]+)"/)?.[1];
      if (url) request(url);
      return { result: { type: 'string', value: 'doc' } };
    }
    if (method === 'Fetch.getResponseBody') throw refusal();
    if (method === 'Network.getResponseBody') {
      if (leak) return { body: `leaked ${marker}`, base64Encoded: false };
      throw refusal();
    }
    return {};
  };
  let marker;
  client.send = async (method, params = {}) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      const result = handle(method, params);
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

const probe = (options, controls = { networkEvents: true }) => {
  const browser = fake(options);
  return redirectSecret({
    ...browser,
    session: 'S1',
    targetId: 'T1',
    ordinary,
    tag: `t${Math.random().toString(36).slice(2, 8)}`,
    mode: 'headers',
    side: 'guarded',
    controls,
  });
};

const deliveries = (out) => [...new Set(Object.values(out.hops).map((hop) => hop.delivery))];
const terminals = (out) => [...new Set(Object.values(out.hops).map((hop) => hop.terminal))];

test.describe('C2 redirect network-body carrier and request termination', {
  concurrency: true,
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

  test('a redact-in-place transport terminates with an origin-only redirect', async () => {
    const out = await probe({ network: 'redact' });
    assert.equal(out.requestsTerminated, true);
    assert.equal(out.hopsRedacted, true);
    assert.deepEqual(deliveries(out), ['redacted']);
    assert.deepEqual(terminals(out), ['Network.requestWillBeSent']);
    assert.equal(out.networkBodyPath, 'network');
    assert.equal(out.networkBodyRefused, true);
  });

  test('an in-place redirect carrying the raw protected URL is never accepted', async () => {
    const out = await probe({ network: 'redact', raw: true });
    assert.equal(out.hopsRedacted, false);
    assert.deepEqual(deliveries(out), ['raw']);
  });
});
