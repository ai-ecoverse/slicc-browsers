import { load, outcome, waitFor } from './guard-driver.mjs';
import { redirectFragments } from './redirect-fragments.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decodeBase64 = (text) =>
  new TextDecoder().decode(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));
const base64Slices = (value) => {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '');
  const candidates = [];
  for (let offset = 0; offset < 4; offset++) {
    const part = normalized.slice(offset);
    const usable = part.slice(0, part.length - (part.length % 4 === 1 ? 1 : 0));
    candidates.push(usable.padEnd(Math.ceil(usable.length / 4) * 4, '='));
    candidates.push(part.slice(0, Math.floor(part.length / 4) * 4));
  }
  return [...new Set(candidates)].filter(Boolean);
};
const decodedBase64 = (value) =>
  [...value.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)].flatMap(([text]) =>
    base64Slices(text).map(decodeBase64)
  );
const refused = (out) => !out.ok && /^slicc: refused:/.test(out.error?.message ?? '');
const gone = (out) =>
  !out.ok &&
  !refused(out) &&
  /session with given id not found|no session with given id|session (?:has been |is |was )?(?:closed|detached|not found)|target (?:[\w ,]+ )?(?:has been |is |was )?closed|\b(?:cdp|connection|transport|websocket|socket) (?:has been |is |was )?closed|websocket is not open/i.test(
    out.error?.message ?? ''
  );
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

export function containsSecret(value, marker, seen = new Map()) {
  const visit = (value, depth = 0) => {
    if (typeof value === 'string') {
      const key = `${depth}:${value}`;
      if (!seen.has(key)) seen.set(key, text(value, depth));
      return seen.get(key);
    }
    if (value && typeof value === 'object')
      return Object.values(value).some((v) => visit(v, depth));
    return false;
  };
  const text = (value, depth) => {
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
    this.detachScan = this.eventsStart;
    this.responses = [];
    this.attempts = [];
    this.jobs = new Set();
    this.networkBodies = new Set();
    this.learned = { network: new Set(), fetch: new Set(), tap: new Set() };
    this.registrations = [];
    this.seen = new Map();
    this.scale = this.settleScale ?? 1;
    this.protectedURLs = [
      `https://seven.sliccy.ai/auth/callback?code=${encodeURIComponent(this.marker)}&state=${encodeURIComponent(this.marker)}`,
      `https://vault.sliccy.ai/oauth/mcp-callback?code=${encodeURIComponent(this.marker)}`,
      `https://seven.sliccy.ai/auth/callback#access_token=${encodeURIComponent(this.marker)}&state=${encodeURIComponent(this.marker)}`,
      `https://vault.sliccy.ai/oauth/mcp-callback#access_token=${encodeURIComponent(this.marker)}`,
    ];
    this.prefix = new URL(`${this.ordinary}/redirect-secret/${this.tag}-`).href;
    this.plainURL = `${this.ordinary}/redirect-secret-body/${this.tag}-plain?code=${encodeURIComponent(this.marker)}`;
    this.destinations =
      this.side === 'control'
        ? this.protectedURLs.map((url) => `${this.plainURL}${new URL(url).hash}`)
        : this.protectedURLs;
  }

  ended() {
    const events = this.client.events;
    for (; !this.end && this.detachScan < events.length; this.detachScan++) {
      const event = events[this.detachScan];
      if (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === this.session)
        this.end = 'Target.detachedFromTarget';
    }
    return Boolean(this.end);
  }

  async lost() {
    if (!this.ended()) await this.send('Runtime.evaluate', { expression: 'void 0' });
    return this.ended();
  }

  answered(method) {
    return this.attempts.filter(
      (entry) => entry.method === method && !(this.end && (entry.pending || entry.ended))
    );
  }

  async send(method, params = {}) {
    if (this.ended())
      return { ok: false, ended: true, error: { message: `session ended (${this.end})` } };
    const out = await outcome(this.client.send(method, params, this.session));
    if (gone(out)) {
      this.end ??= out.error.message;
      return { ...out, ended: true };
    }
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
      if (event.params.networkId) this.track(this.networkBody(event.params.networkId, 'fetch'));
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
        this.track(this.networkBody(event.params.requestId, 'network'));
      }
      await pause(5);
    }
  }

  async networkBody(requestId, source) {
    this.learned[source].add(requestId);
    if (this.networkBodies.has(requestId) || this.ended()) return;
    this.networkBodies.add(requestId);
    const entry = { method: 'Network.getResponseBody', source, pending: true };
    this.attempts.push(entry);
    const out = await this.send('Network.getResponseBody', { requestId });
    delete entry.pending;
    Object.assign(entry, out);
  }

  async settle() {
    for (let i = 0; i < 500 && this.jobs.size; i++) await pause(10);
  }

  tap() {
    for (const event of this.reader.events ?? []) {
      if (event.sessionId !== this.observer) continue;
      const response = event.params?.redirectResponse ?? event.params?.response;
      if (response?.url?.startsWith(this.prefix) && redirects.includes(response.status))
        this.track(this.networkBody(event.params.requestId, 'tap'));
    }
  }

  networkLeg() {
    const carriers = [...this.networkBodies].map((id) =>
      this.learned.network.has(id)
        ? 'network'
        : this.learned.fetch.has(id)
          ? 'fetch-networkId'
          : 'withheld+tap'
    );
    const path =
      ['withheld+tap', 'fetch-networkId', 'network'].find((carrier) =>
        carriers.includes(carrier)
      ) ?? 'none';
    const networkBodyCarriers = Object.fromEntries(
      [...new Set(carriers)].map((carrier) => [
        carrier,
        carriers.filter((entry) => entry === carrier).length,
      ])
    );
    const attempts = this.answered('Network.getResponseBody');
    const refusedAll = attempts.length > 0 && attempts.every(refused);
    const proven = path === 'network' || this.side !== 'guarded' || this.controls?.networkEvents;
    const reason =
      path === 'none'
        ? 'no network id for the redirect'
        : !proven
          ? 'control did not prove the redirect Network events'
          : this.end && !attempts.length
            ? `session ended (${this.end}) before a network body read was answered`
            : undefined;
    if (reason && (!attempts.length || refusedAll))
      return {
        networkBodyPath: path,
        networkBodyCarriers,
        networkBodyAttempted: 'incomplete',
        networkBodyRefused: 'incomplete',
        incomplete: `redirect-secret: network body leg ${reason}`,
      };
    return {
      networkBodyPath: path,
      networkBodyCarriers,
      networkBodyAttempted: attempts.length > 0,
      networkBodyRefused: refusedAll,
    };
  }

  requests(events, match = (url) => url?.startsWith(this.prefix)) {
    const own = events.filter((event) => event.sessionId === this.session);
    const seen = new Set(
      own
        .filter(
          (event) =>
            event.method === 'Network.requestWillBeSent' &&
            match(
              event.params.redirectResponse
                ? event.params.redirectResponse.url
                : event.params.request?.url
            )
        )
        .map((event) => event.params.requestId)
    );
    return [...seen].map((requestId) => {
      const mine = own.filter((event) => event.params?.requestId === requestId);
      return {
        requestId,
        hop: mine.find(
          (event) =>
            event.method === 'Network.requestWillBeSent' &&
            match(event.params.redirectResponse?.url)
        ),
        end: mine.find((event) =>
          ['Network.loadingFinished', 'Network.loadingFailed'].includes(event.method)
        ),
      };
    });
  }

  open(events, match) {
    return this.requests(events, match).filter(({ hop, end }) => !hop && !end);
  }

  async land(url, start) {
    const path = new URL(url).pathname;
    await pause(250);
    if (this.stalled || this.ended()) return;
    const landed = await waitFor(
      async () =>
        this.ended() ||
        ((await this.fixture.log()).some((entry) => entry.url.includes(path)) &&
          !this.open(this.client.events.slice(start), (seen) => seen === url).length),
      Math.round(2000 * this.scale),
      50
    );
    this.stalled = !landed && this.side === 'guarded';
  }

  async terminated() {
    await waitFor(
      () => this.ended() || !this.open(this.client.events.slice(this.eventsStart)).length,
      Math.round(5000 * this.scale),
      50
    );
    await waitFor(() => this.cursor >= this.client.events.length, 1000, 5);
    await this.settle();
  }

  hops(events) {
    const protectedOrigins = this.protectedURLs.map((url) => new URL(url).origin);
    const hops = Object.fromEntries(
      this.requests(events).map(({ requestId, hop, end }) => {
        const url = hop?.params.request?.url ?? '';
        const origin = protectedOrigins.find((value) => url.startsWith(value));
        return [
          requestId,
          {
            delivery: !hop
              ? end
                ? 'withheld'
                : 'unterminated'
              : !origin
                ? 'ordinary'
                : [origin, `${origin}/`].includes(url)
                  ? 'redacted'
                  : 'raw',
            terminal: (hop ?? end)?.method ?? null,
          },
        ];
      })
    );
    const deliveries = Object.values(hops).map((entry) => entry.delivery);
    const open = Object.keys(hops).filter((id) => hops[id].delivery === 'unterminated');
    const missing = open.length > 0 && (this.side === 'control' || this.end);
    const who = this.end ? `session ended (${this.end}) with requests` : 'control requests';
    return {
      hops,
      requestsTerminated: missing ? 'incomplete' : !open.length,
      ...(missing ? { incomplete: `redirect-secret: ${who} ${open.join(', ')} unterminated` } : {}),
      hopsRedacted: !deliveries.some((delivery) => ['raw', 'ordinary'].includes(delivery)),
    };
  }

  legs(events) {
    const network = this.networkLeg();
    const hops = this.hops(events);
    const incomplete = [network.incomplete, hops.incomplete].filter(Boolean).join('; ');
    return { ...network, ...hops, ...(incomplete ? { incomplete } : {}) };
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

  contains(value) {
    return containsSecret(value, this.marker, this.seen);
  }

  async scan(items) {
    const flags = [];
    let slice = Date.now();
    for (const item of items) {
      flags.push(this.contains(item));
      if (Date.now() - slice < 10) continue;
      await pause(0);
      slice = Date.now();
    }
    return flags;
  }

  async observe() {
    this.observer = (
      await this.reader.send('Target.attachToTarget', { targetId: this.targetId, flatten: true })
    ).sessionId;
    this.watching = this.watch();
    await this.reader.send('Page.enable', {}, this.observer);
    if (this.side === 'guarded') await this.reader.send('Network.enable', {}, this.observer);
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
  }

  async setup() {
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
        if (this.ended()) return;
        const code = this.mode === 'mix' ? [301, 303, 307, 308][index] : 302;
        const url = await this.register(`${index}-${kind}`, to, code);
        const start = this.client.events.length;
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
        await this.land(url, start);
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
      ordinaryResource: this.contains(resource),
      ordinarySnapshot: this.contains(snapshot),
      ordinaryDOM: this.contains(dom),
    });
  }

  async override(url) {
    await this.reset('override');
    this.holdURL = `${this.ordinary}/data?n=${this.tag}-override`;
    this.held = undefined;
    await this.send('Runtime.evaluate', {
      expression: `fetch(${JSON.stringify(this.holdURL)}).catch(()=>{});void 0`,
    });
    await waitFor(() => Boolean(this.held) || this.ended(), 5000, 10);
    if (!this.held) {
      this.holdURL = undefined;
      if (await this.lost()) return;
      throw new Error('redirect body: Fetch override pause missing');
    }
    const requestId = this.held.params.requestId;
    const out = await this.send('Fetch.continueRequest', { requestId, url });
    this.holdURL = undefined;
    if (out.ended) return;
    this.responses.push({
      overrideMethod: 'Fetch.continueRequest',
      overrideRefused: refused(out),
      overrideWorked: out.ok,
    });
    if (!out.ok) await this.send('Fetch.continueRequest', { requestId });
    await pause(500);
  }

  async body() {
    const to = this.destinations[0];
    const url = await this.register('body', to);
    const tree = await this.send('Page.getFrameTree');
    const frameId = tree.result?.frameTree.frame.id;
    const start = (await this.fixture.log()).length;
    await this.reads(url, to, frameId);
    this.responses.push({
      cookieSent: (await this.fixture.log())
        .slice(start)
        .some((entry) => entry.headers.cookie?.includes(`${this.cookie}=`)),
    });
  }

  async reads(url, to, frameId) {
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
    if (!xhr) {
      if (await this.lost()) return;
      throw new Error('redirect body: XHR request was not observed');
    }
    await this.send('Network.replayXHR', { requestId: xhr.params.requestId });
    this.responses.push({ replayAttempted: true });
    await pause(500);
    for (const step of [
      () => this.snapshots(url, to, frameId),
      () => this.iframe(),
      () => this.override(url),
    ]) {
      if (this.ended()) return;
      await step();
    }
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
      ordinaryIframeSnapshot: this.contains(snapshot),
      ordinaryIframeDOM: this.contains(dom),
    });
  }

  async evidence() {
    if (!this.ended()) await pause(8000);
    if (!this.ended()) this.tap();
    if (this.side === 'control' && this.controls)
      this.controls.networkEvents = this.learned.network.size > 0;
    await this.send('Fetch.disable');
    await this.reset('survive');
    const survives = await this.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    await this.settle();
    await this.terminated();
    const tapped = `"sessionId":"${this.observer}"`;
    const events = this.client.events
      .slice(this.eventsStart)
      .filter((event) => event.sessionId !== this.observer);
    const messages = (this.client.messages?.slice(this.messagesStart) ?? []).filter(
      (message) => !message.includes(tapped)
    );
    const eventLeaks = await this.scan(events);
    const ordinaryEvents = events.filter(
      (event, index) =>
        eventLeaks[index] && JSON.stringify(event).includes(new URL(this.plainURL).host)
    );
    const replies = [...messages, ...this.responses];
    const replyLeaks = await this.scan(replies);
    const extra = events.filter(
      (event) =>
        event.sessionId === this.session &&
        event.method === 'Network.responseReceivedExtraInfo' &&
        redirects.includes(event.params.statusCode)
    );
    const extraHeld = extra.every((event) => {
      const headers = event.params.headers;
      const origin = headers.location ?? headers.Location;
      return (
        this.protectedURLs.some((url) => new URL(url).origin === origin) &&
        headersMatch(headers, origin) &&
        headersTextMatch(event.params.headersText, origin)
      );
    });
    const extraInPlace =
      extraHeld &&
      (extra.length >= this.destinations.length * 4 || (this.end ? 'incomplete' : false));
    const unseen = this.end ? 'incomplete' : false;
    const found = (key) => this.responses.some((entry) => entry[key]);
    const fetchAttempts = this.answered('Fetch.getResponseBody');
    const overrides = this.responses.filter((entry) => entry.overrideMethod);
    const evidence = {
      live: (await this.fixture.log()).some((entry) =>
        entry.url.includes(`/redirect-secret/${this.tag}`)
      ),
      rawRecorded: this.messagesStart !== undefined && messages.length > events.length,
      leakChannels: replies
        .filter((_, index) => replyLeaks[index])
        .map((message) =>
          typeof message === 'string'
            ? (JSON.parse(message).method ?? 'reply')
            : (message.method ?? 'reply')
        ),
      secretHidden: !replyLeaks.includes(true),
      sessionSurvives: survives.ok && survives.result?.result?.value === 'doc',
      sessionEnded: this.ended(),
      fetchBodyAttempted: fetchAttempts.length > 0 || unseen,
      fetchBodyRefused: fetchAttempts.length ? fetchAttempts.every(refused) : unseen,
      ...this.legs(events),
      extraInPlace,
      ...redirectFragments({
        messages,
        events,
        replies: this.responses,
        protectedOrigins: this.protectedURLs.map((url) => new URL(url).origin),
        contains: (value) => this.contains(value),
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
        ].map((key) => [key, found(key) || unseen])
      ),
      overridesRefused: overrides.length
        ? overrides.every((entry) => entry.overrideRefused)
        : unseen,
      overridesWorked: overrides.length ? overrides.every((entry) => entry.overrideWorked) : unseen,
    };
    if (!this.end || !Object.values(evidence).includes('incomplete')) return evidence;
    const incomplete = [evidence.incomplete, `redirect-secret: session ended (${this.end})`];
    return { ...evidence, incomplete: incomplete.filter(Boolean).join('; ') };
  }

  async close() {
    this.stopped = true;
    await this.watching;
    await this.settle();
    if (!this.ended()) await outcome(this.client.send('Fetch.disable', {}, this.session));
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
    const observed = await outcome(probe.observe());
    if (!observed.ok)
      return {
        incomplete: `redirect-secret: observer setup failed: ${observed.error.message}`,
      };
    await probe.setup();
    if (options.mode === 'body') await probe.body();
    else await probe.headers();
    const evidence = await probe.evidence();
    if (probe.end && options.side !== 'guarded')
      throw new Error(`redirect-secret: ${options.side} session ended (${probe.end})`);
    return evidence;
  } finally {
    await probe.close();
  }
}
