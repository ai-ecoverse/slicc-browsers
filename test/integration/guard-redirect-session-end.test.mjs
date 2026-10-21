import assert from 'node:assert/strict';
import test from 'node:test';
import { redirectSecret } from '../../redirect-secret.mjs';

const ordinary = 'http://ordinary.example.test:4180';
const refusal = () => new Error('slicc: refused: protected redirect');

function fake({ end = 'override', how = 'detach', leak = false }) {
  const routes = new Map();
  const log = [];
  let next = 0;
  let marker;
  let cookie;
  let navigations = 0;
  let over = false;
  const client = { events: [], messages: [] };
  const reader = { events: [], messages: [] };
  const emit = (sessionId, method, params) => {
    const event = { method, params, ...(sessionId ? { sessionId } : {}) };
    client.events.push(event);
    client.messages.push(JSON.stringify(event));
  };
  const finish = () => {
    over = true;
    if (how === 'detach') emit(undefined, 'Target.detachedFromTarget', { sessionId: 'S1' });
  };
  const handle = (method, params) => {
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'F1', url: ordinary } } };
    if (method === 'Network.loadNetworkResource') {
      if (leak) log.push({ url: params.url, headers: { cookie: `${cookie}=secret-cookie` } });
      return { resource: { success: true, stream: 'H1' } };
    }
    if (method === 'IO.read')
      return { data: leak ? `body ${marker}` : 'refused', base64Encoded: false, eof: true };
    if (method === 'Page.navigate') {
      if (end === 'navigate' && ++navigations === 3) finish();
      return { frameId: 'F1' };
    }
    if (method === 'Runtime.evaluate') {
      const url = params.expression.match(/"(http[^"]+)"/)?.[1];
      if (url?.includes('-override') && end === 'override') finish();
      else if (url && params.expression.includes('XMLHttpRequest'))
        emit('S1', 'Network.requestWillBeSent', {
          requestId: `X${++next}`,
          type: 'XHR',
          request: { url },
        });
      return { result: { type: 'string', value: 'doc' } };
    }
    if (method === 'Fetch.getResponseBody' || method === 'Network.getResponseBody') throw refusal();
    return {};
  };
  client.send = async (method, params = {}) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (over) throw new Error(how === 'detach' ? 'Session with given id not found.' : 'CDP closed');
    const id = ++next;
    try {
      const result = await handle(method, params);
      if (!over) client.messages.push(JSON.stringify({ id, result }));
      return result;
    } catch (error) {
      client.messages.push(JSON.stringify({ id, error: { message: error.message } }));
      throw error;
    }
  };
  reader.send = async (method, params = {}) => {
    if (method === 'Target.attachToTarget') return { sessionId: 'O1' };
    if (method === 'Storage.setCookies') cookie = params.cookies[0].name;
    return {};
  };
  const fixture = {
    async redirectSecret(entry) {
      if (entry.remove) routes.delete(entry.path);
      else routes.set(entry.path, entry);
      if (entry.path.includes('-body')) log.push({ url: `${ordinary}${entry.path}`, headers: {} });
      if (entry.body && !entry.to) marker ??= entry.body.replace('protected-body-', '');
    },
    log: async () => log,
  };
  return { client, reader, fixture };
}

const probe = (options, leg = {}) =>
  redirectSecret({
    ...fake(options),
    session: 'S1',
    targetId: 'T1',
    ordinary,
    tag: `t${Math.random().toString(36).slice(2, 8)}`,
    mode: leg.mode ?? 'body',
    side: leg.side ?? 'guarded',
    controls: { networkEvents: true },
  });

test.describe('C2 redirect vectors when the guard ends the guarded session', {
  concurrency: true,
  timeout: 120000,
}, () => {
  test('a clean session end before the override pause reports sessionEnded and passes the leak checks', async () => {
    const out = await probe({});
    assert.equal(out.sessionEnded, true);
    assert.equal(out.secretHidden, true);
    assert.equal(out.protectedBodyHidden, true);
    assert.equal(out.cookieHidden, true);
    assert.equal(out.hopsRedacted, true);
    assert.equal(out.fragmentsHidden, true);
    assert.equal(out.replayAttempted, true);
    assert.equal(out.overridesRefused, 'incomplete');
    assert.equal(out.networkBodyRefused, 'incomplete');
    assert.equal(out.sessionSurvives, false);
    assert.match(out.incomplete, /session ended \(Target\.detachedFromTarget\)/);
  });

  test('a closed transport is a session end too', async () => {
    const out = await probe({ how: 'close' });
    assert.equal(out.sessionEnded, true);
    assert.equal(out.secretHidden, true);
    assert.equal(out.protectedBodyHidden, true);
    assert.match(out.incomplete, /session ended \(CDP closed\)/);
  });

  test('a guard that leaks before ending the session still fails the leak checks', async () => {
    const out = await probe({ leak: true });
    assert.equal(out.sessionEnded, true);
    assert.equal(out.secretHidden, false);
    assert.equal(out.protectedBodyHidden, false);
    assert.equal(out.cookieHidden, false);
  });

  test('a session end mid-matrix leaves the missing body and header evidence incomplete', async () => {
    const out = await probe({ end: 'navigate', how: 'close' }, { mode: 'headers' });
    assert.equal(out.sessionEnded, true);
    assert.equal(out.secretHidden, true);
    assert.equal(out.fetchBodyAttempted, 'incomplete');
    assert.equal(out.fetchBodyRefused, 'incomplete');
    assert.equal(out.networkBodyAttempted, 'incomplete');
    assert.equal(out.extraLocation, 'incomplete');
  });

  test('a session end on the control leg is an error, never a pass', async () => {
    await assert.rejects(probe({}, { side: 'control' }), /control session ended/);
  });
});
