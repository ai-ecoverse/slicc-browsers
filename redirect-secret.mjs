import { load, outcome } from './guard-driver.mjs';
import { redirectFragments } from './redirect-fragments.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decodeBase64 = (text) =>
  new TextDecoder().decode(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));
const decodedBase64 = (value) =>
  [...value.matchAll(/[A-Za-z0-9+/]{12,}={0,2}/g)].flatMap(([text]) => {
    try {
      return [decodeBase64(text)];
    } catch {
      return [];
    }
  });
const refused = (out) => !out.ok && /^slicc: refused:/.test(out.error?.message ?? '');
const redirects = [301, 302, 303, 307, 308];
const redirectHeaders = (to) => ({
  location: to,
  'content-location': to,
  refresh: `0;url=${to}`,
  link: `<${to}>; rel=preconnect`,
});
const headersMatch = (headers, to) => {
  const map = Object.fromEntries(
    (Array.isArray(headers)
      ? headers.map(({ name, value }) => [name, value])
      : Object.entries(headers ?? {})
    ).map(([name, value]) => [name.toLowerCase(), value])
  );
  return Object.entries(redirectHeaders(to)).every(([name, value]) => map[name] === value);
};
const headersTextMatch = (text, to) =>
  Object.entries(redirectHeaders(to)).every(([name, value]) =>
    text
      ?.split('\r\n')
      .some(
        (line) =>
          line.slice(0, name.length + 2).toLowerCase() === `${name}: ` &&
          line.slice(name.length + 2) === value
      )
  );

export function containsSecret(value, marker) {
  const visit = (value, depth = 0) => {
    if (typeof value === 'string') {
      if (value.includes(marker)) return true;
      if (depth >= 8) return false;
      const decoded = [];
      try {
        decoded.push(decodeURIComponent(value));
      } catch {}
      try {
        decoded.push(JSON.parse(value));
      } catch {}
      try {
        decoded.push(JSON.parse(`"${value}"`));
      } catch {}
      decoded.push(...decodedBase64(value));
      return decoded.some((text) => text !== value && visit(text, depth + 1));
    }
    if (value && typeof value === 'object')
      return Object.values(value).some((v) => visit(v, depth));
    return false;
  };
  return visit(value);
}

class RedirectProbe {
  constructor(options) {
    Object.assign(this, options);
    this.marker = `${this.tag}-secret/+"token`;
    this.cookie = `redirect-secret-${this.tag}`;
    this.messagesStart = this.client.messages?.length;
    this.eventsStart = this.client.events.length;
    this.cursor = this.eventsStart;
    this.responses = [];
    this.attempts = [];
    this.jobs = new Set();
    this.networkBodies = new Set();
    this.registrations = [];
    this.protectedURLs = [
      `https://seven.sliccy.ai/auth/callback?code=${encodeURIComponent(this.marker)}&state=${encodeURIComponent(this.marker)}`,
      `https://vault.sliccy.ai/oauth/mcp-callback?code=${encodeURIComponent(this.marker)}`,
      `https://seven.sliccy.ai/auth/callback#access_token=${encodeURIComponent(this.marker)}&state=${encodeURIComponent(this.marker)}`,
      `https://vault.sliccy.ai/oauth/mcp-callback#access_token=${encodeURIComponent(this.marker)}`,
    ];
    this.plainURL = `${this.ordinary}/redirect-secret-body/${this.tag}-plain?code=${encodeURIComponent(this.marker)}`;
    this.destinations =
      this.side === 'control'
        ? this.protectedURLs.map((url) => `${this.plainURL}${new URL(url).hash}`)
        : this.protectedURLs;
  }

  async send(method, params = {}) {
    const out = await outcome(this.client.send(method, params, this.session));
    this.responses.push({ method, ...out });
    return out;
  }

  track(job) {
    this.jobs.add(job);
    job.finally(() => this.jobs.delete(job));
  }

  async fetchPause(event) {
    if (redirects.includes(event.params.responseStatusCode)) {
      const out = await this.send('Fetch.getResponseBody', { requestId: event.params.requestId });
      this.attempts.push({ method: 'Fetch.getResponseBody', ...out });
    }
    if (
      this.holdURL &&
      event.params.request.url === this.holdURL &&
      !event.params.responseStatusCode
    ) {
      this.held = event;
      return;
    }
    await this.send('Fetch.continueRequest', { requestId: event.params.requestId });
  }

  async watch() {
    while (!this.stopped) {
      for (const event of this.client.events.slice(this.cursor)) {
        this.cursor++;
        if (event.sessionId !== this.session) continue;
        if (event.method === 'Fetch.requestPaused') this.track(this.fetchPause(event));
        const response = event.params?.redirectResponse ?? event.params?.response;
        if (!response || !redirects.includes(response.status)) continue;
        const requestId = event.params.requestId;
        if (this.networkBodies.has(requestId)) continue;
        this.networkBodies.add(requestId);
        this.track(
          this.send('Network.getResponseBody', { requestId }).then((out) => {
            this.attempts.push({ method: 'Network.getResponseBody', ...out });
          })
        );
      }
      await pause(5);
    }
  }

  async register(key, to, code = 302) {
    const url = `${this.ordinary}/redirect-secret/${this.tag}-${key}`;
    const path = new URL(url).pathname;
    await this.fixture.redirectSecret({ path, to, code, body: this.marker });
    this.registrations.push({ path });
    return url;
  }

  async reset(suffix = 'reset') {
    await load(this.reader, this.observer, `${this.ordinary}/doc?n=${this.tag}-${suffix}`);
  }

  async setup() {
    this.observer = (
      await this.reader.send('Target.attachToTarget', { targetId: this.targetId, flatten: true })
    ).sessionId;
    this.watching = this.watch();
    await this.reader.send('Page.enable', {}, this.observer);
    await this.reader.send('Storage.setCookies', {
      cookies: [
        {
          name: this.cookie,
          value: 'secret-cookie',
          domain: 'seven.sliccy.ai',
          path: '/',
          secure: true,
          sameSite: 'None',
        },
      ],
    });
    for (const domain of ['Page', 'Network', 'Runtime', 'Log', 'Audits'])
      await this.send(`${domain}.enable`);
    await this.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' },
      ],
    });
    for (const to of [...this.protectedURLs, this.plainURL]) {
      const url = new URL(to);
      if (url.hash) continue;
      const registration = { path: url.pathname, host: url.hostname, search: url.search };
      await this.fixture.redirectSecret({ ...registration, body: `protected-body-${this.marker}` });
      this.registrations.push(registration);
    }
  }

  async headers() {
    for (const [index, to] of this.destinations.entries()) {
      for (const kind of ['navigate', 'href', 'fetch', 'xhr']) {
        const code = this.mode === 'mix' ? [301, 303, 307, 308][index] : 302;
        const url = await this.register(`${index}-${kind}`, to, code);
        if (kind === 'navigate') await this.send('Page.navigate', { url });
        else {
          await this.reset();
          const expression =
            kind === 'href'
              ? `location.href=${JSON.stringify(url)};void 0`
              : kind === 'fetch'
                ? `fetch(${JSON.stringify(url)}).catch(()=>{});void 0`
                : this.xhrExpression(url);
          await this.send('Runtime.evaluate', { expression });
        }
        await pause(250);
        await this.send('Page.getFrameTree');
        await this.send('Page.getResourceTree');
        await this.send('Page.getNavigationHistory');
        await this.reset();
      }
    }
  }

  xhrExpression(url) {
    return `(()=>{const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(url)});x.send()})();void 0`;
  }

  async stream(handle) {
    let text = '';
    if (!handle) return text;
    for (let i = 0; i < 32; i++) {
      const read = await this.send('IO.read', { handle });
      text += read.result?.base64Encoded
        ? decodeBase64(read.result.data)
        : (read.result?.data ?? '');
      if (!read.ok || read.result.eof) break;
    }
    await this.send('IO.close', { handle });
    return text;
  }

  async snapshots(url, to, frameId) {
    const navigate = await this.send('Page.navigate', { url });
    await pause(500);
    const resource = await this.send('Page.getResourceContent', {
      frameId: navigate.result?.frameId ?? frameId,
      url: to,
    });
    const snapshot = await this.send('Page.captureSnapshot', { format: 'mhtml' });
    const dom = await this.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    this.responses.push({
      resourceContentAttempted: true,
      snapshotAttempted: true,
      domSnapshotAttempted: true,
      ordinaryResource: containsSecret(resource, this.marker),
      ordinarySnapshot: containsSecret(snapshot, this.marker),
      ordinaryDOM: containsSecret(dom, this.marker),
    });
  }

  async override(url) {
    await this.reset('override');
    this.holdURL = `${this.ordinary}/data?n=${this.tag}-override`;
    this.held = undefined;
    await this.send('Runtime.evaluate', {
      expression: `fetch(${JSON.stringify(this.holdURL)}).catch(()=>{});void 0`,
    });
    const deadline = Date.now() + 5000;
    while (!this.held && Date.now() < deadline) await pause(10);
    if (!this.held) throw new Error('redirect body: Fetch override pause missing');
    const requestId = this.held.params.requestId;
    const out = await this.send('Fetch.continueRequest', { requestId, url });
    this.responses.push({
      overrideMethod: 'Fetch.continueRequest',
      overrideRefused: refused(out),
      overrideWorked: out.ok,
    });
    this.holdURL = undefined;
    if (!out.ok) await this.send('Fetch.continueRequest', { requestId });
    await pause(500);
  }

  async body() {
    const to = this.destinations[0];
    const url = await this.register('body', to);
    const tree = await this.send('Page.getFrameTree');
    const frameId = tree.result?.frameTree.frame.id;
    const start = (await this.fixture.log()).length;
    const resource = await this.send('Network.loadNetworkResource', {
      frameId,
      url,
      options: { disableCache: true, includeCredentials: true },
    });
    const text = await this.stream(resource.result?.resource?.stream);
    this.responses.push({
      protectedBody: this.side !== 'control' && text.includes(this.marker),
      ordinaryBody: this.side === 'control' && text.includes(this.marker),
    });
    const before = this.client.events.length;
    await this.send('Runtime.evaluate', { expression: this.xhrExpression(url) });
    await pause(500);
    const xhr = this.client.events
      .slice(before)
      .find(
        (event) =>
          event.method === 'Network.requestWillBeSent' &&
          event.params.type === 'XHR' &&
          event.params.request.url === url
      );
    if (!xhr) throw new Error('redirect body: XHR request was not observed');
    await this.send('Network.replayXHR', { requestId: xhr.params.requestId });
    this.responses.push({ replayAttempted: true });
    await pause(500);
    await this.snapshots(url, to, frameId);
    await this.iframe();
    await this.override(url);
    this.responses.push({
      cookieSent: (await this.fixture.log())
        .slice(start)
        .some((entry) => entry.headers.cookie?.includes(`${this.cookie}=`)),
    });
  }

  async iframe() {
    await this.reset('iframe');
    const url = await this.register('iframe', this.destinations[1]);
    await this.send('Runtime.evaluate', {
      expression: `(()=>{const f=document.createElement('iframe');f.src=${JSON.stringify(url)};document.body.append(f)})();void 0`,
    });
    await pause(500);
    await this.send('Page.getFrameTree');
    const snapshot = await this.send('Page.captureSnapshot', { format: 'mhtml' });
    const dom = await this.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    this.responses.push({
      iframeSnapshotAttempted: true,
      ordinaryIframeSnapshot: containsSecret(snapshot, this.marker),
      ordinaryIframeDOM: containsSecret(dom, this.marker),
    });
  }

  async evidence() {
    await pause(8000);
    await this.send('Fetch.disable');
    await this.reset('survive');
    const survives = await this.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    const events = this.client.events.slice(this.eventsStart);
    const messages = this.client.messages?.slice(this.messagesStart) ?? [];
    const ordinaryEvents = events.filter(
      (event) =>
        containsSecret(event, this.marker) &&
        JSON.stringify(event).includes(new URL(this.plainURL).host)
    );
    const extra = events.filter(
      (event) =>
        event.sessionId === this.session &&
        event.method === 'Network.responseReceivedExtraInfo' &&
        redirects.includes(event.params.statusCode)
    );
    const extraInPlace =
      extra.length >= this.destinations.length * 4 &&
      extra.every((event) => {
        const headers = event.params.headers;
        const origin = headers.location ?? headers.Location;
        return (
          this.protectedURLs.some((url) => new URL(url).origin === origin) &&
          headersMatch(headers, origin) &&
          headersTextMatch(event.params.headersText, origin)
        );
      });
    const found = (key) => this.responses.some((entry) => entry[key]);
    const attempted = (method) => this.attempts.some((entry) => entry.method === method);
    const bodyRefused = (method) =>
      this.attempts.filter((entry) => entry.method === method).length > 0 &&
      this.attempts.filter((entry) => entry.method === method).every(refused);
    return {
      live: (await this.fixture.log()).some((entry) =>
        entry.url.includes(`/redirect-secret/${this.tag}`)
      ),
      rawRecorded: this.messagesStart !== undefined && messages.length > events.length,
      leakChannels: [...messages, ...this.responses]
        .filter((message) => containsSecret(message, this.marker))
        .map((message) =>
          typeof message === 'string'
            ? (JSON.parse(message).method ?? 'reply')
            : (message.method ?? 'reply')
        ),
      secretHidden: !containsSecret([...messages, ...this.responses], this.marker),
      sessionSurvives: survives.ok && survives.result?.result?.value === 'doc',
      fetchBodyAttempted: attempted('Fetch.getResponseBody'),
      networkBodyAttempted: attempted('Network.getResponseBody'),
      fetchBodyRefused: bodyRefused('Fetch.getResponseBody'),
      networkBodyRefused: bodyRefused('Network.getResponseBody'),
      extraInPlace,
      ...redirectFragments({
        messages,
        events,
        replies: this.responses,
        protectedOrigins: this.protectedURLs.map((url) => new URL(url).origin),
        contains: (value) => containsSecret(value, this.marker),
      }),
      redirectLocation: ordinaryEvents.some(
        (event) =>
          event.method === 'Network.requestWillBeSent' &&
          headersMatch(event.params.redirectResponse?.headers, this.plainURL)
      ),
      extraLocation:
        this.side === 'guarded'
          ? extraInPlace
          : ordinaryEvents.some(
              (event) =>
                event.method === 'Network.responseReceivedExtraInfo' &&
                headersMatch(event.params.headers, this.plainURL) &&
                headersTextMatch(event.params.headersText, this.plainURL)
            ),
      fetchLocation: ordinaryEvents.some(
        (event) =>
          event.method === 'Fetch.requestPaused' &&
          headersMatch(event.params.responseHeaders, this.plainURL)
      ),
      protectedBodyHidden: !found('protectedBody'),
      cookieHidden: !found('cookieSent'),
      ...Object.fromEntries(
        [
          'ordinaryBody',
          'replayAttempted',
          'resourceContentAttempted',
          'snapshotAttempted',
          'domSnapshotAttempted',
          'ordinaryResource',
          'ordinarySnapshot',
          'ordinaryDOM',
          'iframeSnapshotAttempted',
          'ordinaryIframeSnapshot',
          'ordinaryIframeDOM',
        ].map((key) => [key, found(key)])
      ),
      overridesRefused:
        this.responses.some((entry) => entry.overrideMethod) &&
        this.responses
          .filter((entry) => entry.overrideMethod)
          .every((entry) => entry.overrideRefused),
      overridesWorked:
        this.responses.some((entry) => entry.overrideMethod) &&
        this.responses
          .filter((entry) => entry.overrideMethod)
          .every((entry) => entry.overrideWorked),
    };
  }

  async close() {
    this.stopped = true;
    await this.watching;
    await Promise.allSettled([...this.jobs]);
    await outcome(this.client.send('Fetch.disable', {}, this.session));
    if (this.observer) {
      await outcome(
        this.reader.send(
          'Network.deleteCookies',
          { name: this.cookie, domain: 'seven.sliccy.ai', path: '/' },
          this.observer
        )
      );
      await outcome(this.reader.send('Target.detachFromTarget', { sessionId: this.observer }));
    }
    for (const registration of this.registrations)
      await this.fixture.redirectSecret({ ...registration, remove: true });
  }
}

export async function redirectSecret(options) {
  if (!options.fixture?.redirectSecret)
    throw new Error('redirectSecret fixture registration required');
  const probe = new RedirectProbe(options);
  try {
    await probe.setup();
    if (options.mode === 'body') await probe.body();
    else await probe.headers();
    return await probe.evidence();
  } finally {
    await probe.close();
  }
}
