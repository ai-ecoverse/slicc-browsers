import assert from 'node:assert/strict';

export const ordinary = 'http://ordinary.example.test:4180';

export function redirectHistoryFixture({
  leak = false,
  missingPause = false,
  late = false,
  closedBody = false,
  observerLeak = false,
} = {}) {
  const routes = new Map();
  const tabs = new Map();
  const sessions = new Map();
  const requests = new Map();
  const pauses = new Map();
  const calls = [];
  const log = [];
  let next = 0;
  let marker;
  let closedReadTab;
  const make = (guarded) => ({ guarded, events: [], messages: [] });
  const client = make(true);
  const reader = make(false);
  const emit = (transport, sessionId, method, params) => {
    const event = { method, params, sessionId };
    transport.events.push(event);
    transport.messages.push(JSON.stringify(event));
  };
  const headers = (to) => ({
    Location: to,
    'Content-Location': to,
    Refresh: `0;url=${to}`,
    Link: `<${to}>; rel=preconnect`,
  });
  const frame = (tab, transport) => {
    const url = new URL(tab.url);
    const protectedURL = url.hostname.endsWith('.sliccy.ai');
    return {
      id: `frame-${tab.id}`,
      url:
        transport.guarded && protectedURL
          ? url.origin
          : `${url.origin}${url.pathname}${url.search}`,
      ...(url.hash && !(transport.guarded && protectedURL) ? { urlFragment: url.hash } : {}),
    };
  };
  const request = (tab, url, type = 'Document') => {
    const route = routes.get(new URL(url).pathname);
    log.push({ url, headers: {} });
    const id = `N${++next}`;
    requests.set(id, tab);
    const destination = route?.to;
    const protectedURL = destination && new URL(destination).hostname.endsWith('.sliccy.ai');
    if (destination && type === 'Document') tab.protectedHistory ||= protectedURL;
    if (type === 'Document') tab.url = destination ?? url;
    for (const [sessionId, entry] of sessions) {
      if (entry.tab !== tab) continue;
      const { transport } = entry;
      const hidden = transport.guarded && protectedURL;
      const to = hidden ? new URL(destination).origin : destination;
      emit(transport, sessionId, 'Network.requestWillBeSent', {
        requestId: id,
        type,
        request: { url },
      });
      if (destination) {
        emit(transport, sessionId, 'Network.requestWillBeSent', {
          requestId: id,
          type,
          request: {
            url: to,
            ...(!hidden && new URL(destination).hash
              ? { urlFragment: new URL(destination).hash }
              : {}),
          },
          redirectResponse: { url, status: route.code, headers: headers(to) },
        });
        emit(transport, sessionId, 'Network.responseReceivedExtraInfo', {
          requestId: id,
          statusCode: route.code,
          headers: headers(to),
          headersText: `HTTP/1.1 ${route.code} Redirect\r\n${Object.entries(headers(to))
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join('')}`,
        });
        if (entry.fetch) {
          const pauseId = `P${++next}`;
          pauses.set(pauseId, { tab, protectedURL });
          emit(transport, sessionId, 'Fetch.requestPaused', {
            requestId: pauseId,
            networkId: id,
            request: { url },
            responseStatusCode: route.code,
            responseHeaders: Object.entries(headers(to)).map(([name, value]) => ({ name, value })),
          });
        }
        if (hidden && observerLeak) {
          const observer = [...sessions].find(
            ([, candidate]) => candidate.tab === tab && candidate.transport === reader
          )?.[0];
          transport.messages.push(
            JSON.stringify({
              id: ++next,
              sessionId,
              result: {
                sessionId: observer,
                body: marker,
                frame: { url: new URL(destination).origin, urlFragment: '#opaque-fragment' },
              },
            })
          );
        }
        if (hidden && leak) {
          const deliver = () => emit(transport, sessionId, 'Log.entryAdded', { text: marker });
          if (late) setTimeout(deliver, 7000);
          else deliver();
        }
      }
      emit(transport, sessionId, 'Network.loadingFinished', { requestId: id });
      if (type === 'Document')
        emit(transport, sessionId, 'Page.frameNavigated', { frame: frame(tab, transport) });
    }
    return id;
  };
  const handle = (transport, method, params, sessionId) => {
    const entry = sessions.get(sessionId);
    const tab = entry?.tab;
    if (method === 'Target.createTarget') {
      const id = `T${++next}`;
      tabs.set(id, { id, url: params.url, protectedHistory: false, closed: false });
      return { targetId: id };
    }
    if (method === 'Target.getTargetInfo') {
      const target = tabs.get(params.targetId);
      return { targetInfo: { targetId: target.id, type: 'page', url: target.url } };
    }
    if (method === 'Target.attachToTarget') {
      const id = `S${++next}`;
      sessions.set(id, { tab: tabs.get(params.targetId), transport, fetch: false });
      return { sessionId: id };
    }
    if (method === 'Target.closeTarget') {
      tabs.get(params.targetId).closed = true;
      return { success: true };
    }
    if (method === 'Target.detachFromTarget') return {};
    if (transport.guarded && closedBody && /^(Network|Fetch)\.getResponseBody$/.test(method)) {
      closedReadTab ??= tab;
      if (tab === closedReadTab)
        return new Promise((resolve, reject) =>
          setTimeout(() => {
            tab.closed = true;
            reject(new Error('Session with given id not found.'));
          }, 3000)
        );
    }
    if (tab?.closed) throw new Error('Session with given id not found.');
    if (transport.guarded && tab?.protectedHistory && /^(Runtime.evaluate|DOM)/.test(method))
      throw new Error('slicc: refused: protected history content');
    if (method === 'Fetch.enable') entry.fetch = true;
    if (method === 'Fetch.disable') entry.fetch = false;
    if (method === 'Page.navigate') {
      request(tab, params.url);
      return { frameId: `frame-${tab.id}` };
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: frame(tab, transport) } };
    if (method === 'Page.getResourceTree') return { frameTree: { frame: frame(tab, transport) } };
    if (method === 'Runtime.evaluate') {
      const url = params.expression.match(/"(http[^" ]+)"/)?.[1];
      if (url?.includes('-override')) {
        if (!missingPause) {
          const id = `P${++next}`;
          pauses.set(id, { tab });
          emit(transport, sessionId, 'Fetch.requestPaused', { requestId: id, request: { url } });
        }
      } else if (url)
        request(
          tab,
          url,
          params.expression.includes('XMLHttpRequest')
            ? 'XHR'
            : params.expression.includes('location.href')
              ? 'Document'
              : 'Fetch'
        );
      return { result: { type: 'string', value: 'doc' } };
    }
    if (method === 'Fetch.continueRequest' && params.url) {
      if (transport.guarded) throw new Error('slicc: refused: protected redirect override');
      request(tab, params.url, 'Fetch');
    }
    if (method === 'Network.getResponseBody' || method === 'Fetch.getResponseBody') {
      const owner =
        method === 'Network.getResponseBody'
          ? requests.get(params.requestId)
          : pauses.get(params.requestId)?.tab;
      assert.equal(tab, owner, `body read on wrong tab: ${params.requestId}`);
      if (transport.guarded) throw new Error('slicc: refused: protected redirect body');
      return { body: marker, base64Encoded: false };
    }
    if (method === 'Network.loadNetworkResource') {
      request(tab, params.url, 'Fetch');
      return { resource: { stream: 'stream' } };
    }
    if (method === 'IO.read') return { data: transport.guarded ? 'hidden' : marker, eof: true };
    if (/^(Page.getResourceContent|Page.captureSnapshot|DOMSnapshot.captureSnapshot)$/.test(method))
      return { data: transport.guarded ? 'hidden' : marker };
    return {};
  };
  for (const transport of [client, reader]) {
    transport.send = async (method, params = {}, sessionId) => {
      calls.push({ transport, method, params, sessionId, time: Date.now() });
      try {
        const result = await handle(transport, method, params, sessionId);
        transport.messages.push(
          JSON.stringify({ id: ++next, result, ...(sessionId ? { sessionId } : {}) })
        );
        return result;
      } catch (error) {
        transport.messages.push(
          JSON.stringify({
            id: ++next,
            error: { message: error.message },
            ...(sessionId ? { sessionId } : {}),
          })
        );
        throw error;
      }
    };
    transport.waitEvent = async (predicate) => transport.events.find(predicate);
  }
  const fixture = {
    async redirectSecret(entry) {
      if (entry.remove) routes.delete(entry.path);
      else routes.set(entry.path, entry);
      if (!entry.to && entry.body) marker = entry.body.replace('protected-body-', '');
    },
    log: async () => log,
  };
  return { client, reader, fixture, calls, tabs, sessions, routes };
}
