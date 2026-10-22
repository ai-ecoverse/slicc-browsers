import { load, outcome, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';
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
  /session with given id not found|no session with given id|\bsession (?:has been |is |was )?(?:closed|detached)|\btarget closed|target page, context or browser has been closed|\b(?:cdp|connection|transport|websocket|socket) (?:has been |is |was )?closed|websocket is not open/i.test(
    out.error?.message ?? ''
  );
const connectionGone = (out) =>
  !out.ok &&
  /\b(?:cdp|connection|transport|websocket|socket) (?:has been |is |was )?closed|websocket is not open/i.test(
    out.error?.message ?? ''
  );
const bodyRead = (method) => /^(?:Network|Fetch)\.getResponseBody$/.test(method);
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
    this.sessions = new Map([[this.session, undefined]]);
    this.observers = new Set();
    this.closedSessions = new Set();
    this.targets = new Set();
    this.missing = [];
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
      if (
        event.method === 'Target.detachedFromTarget' &&
        this.sessions.has(event.params?.sessionId)
      ) {
        const session = event.params.sessionId;
        if (session === this.session && !this.closedSessions.has(session))
          this.end = 'Target.detachedFromTarget';
        else this.closedSessions.add(session);
      }
    }
    return Boolean(this.end);
  }

  cut() {
    return Boolean(this.end || this.halted) && !this.complete;
  }

  async lost() {
    if (!this.ended()) await this.send('Runtime.evaluate', { expression: 'void 0' });
    return this.ended();
  }

  answers(method) {
    const all = this.attempts.filter((entry) => entry.method === method);
    const missing = (entry) =>
      entry.incomplete ||
      (entry.pending && this.closedSessions.has(entry.session)) ||
      (this.end && (entry.pending || entry.ended));
    const answered = all.filter((entry) => !missing(entry));
    const short =
      all.some(missing) ||
      (Boolean(this.end || this.halted) &&
        (!this.complete || !answered.length || answered.length < all.length));
    return { answered, short };
  }

  async send(method, params = {}, session = this.session) {
    if (this.ended())
      return { ok: false, ended: true, error: { message: `session ended (${this.end})` } };
    const out = this.closedSessions.has(session)
      ? { ok: false, incomplete: true, error: { message: 'owning tab closed' } }
      : await outcome(this.client.send(method, params, session));
    if (gone(out)) {
      if (!connectionGone(out) && (bodyRead(method) || session !== this.session)) {
        this.closedSessions.add(session);
        out.incomplete = true;
      } else {
        this.end ??= out.error.message;
        return { ...out, ended: true };
      }
    }
    if (bodyRead(method) && out.incomplete)
      this.missing.push(`redirect-secret: ${method} ${params.requestId} owning tab closed`);
    this.responses.push({ method, ...out });
    return out;
  }

  track(job) {
    this.jobs.add(job);
    job.finally(() => this.jobs.delete(job));
  }

  async fetchPause(event) {
    if (redirects.includes(event.params.responseStatusCode)) {
      const entry = {
        method: 'Fetch.getResponseBody',
        session: event.sessionId,
        pending: true,
      };
      this.attempts.push(entry);
      const out = await this.send(
        'Fetch.getResponseBody',
        { requestId: event.params.requestId },
        event.sessionId
      );
      delete entry.pending;
      Object.assign(entry, out);
      if (event.params.networkId)
        this.track(this.networkBody(event.params.networkId, 'fetch', event.sessionId));
    }
    if (
      event.sessionId === this.session &&
      this.holdURL &&
      event.params.request.url === this.holdURL &&
      !event.params.responseStatusCode
    ) {
      this.held = event;
      return;
    }
    await this.send(
      'Fetch.continueRequest',
      { requestId: event.params.requestId },
      event.sessionId
    );
  }

  async watch() {
    while (!this.stopped) {
      for (const event of this.client.events.slice(this.cursor)) {
        this.cursor++;
        if (!this.sessions.has(event.sessionId)) continue;
        if (event.method === 'Fetch.requestPaused') this.track(this.fetchPause(event));
        const response = event.params?.redirectResponse ?? event.params?.response;
        if (!response || !redirects.includes(response.status)) continue;
        this.track(this.networkBody(event.params.requestId, 'network', event.sessionId));
      }
      await pause(5);
    }
  }

  async networkBody(requestId, source, session) {
    const key = `${session}:${requestId}`;
    this.learned[source].add(key);
    if (this.networkBodies.has(key) || this.ended()) return;
    this.networkBodies.add(key);
    const entry = { method: 'Network.getResponseBody', source, session, pending: true };
    this.attempts.push(entry);
    const out = await this.send('Network.getResponseBody', { requestId }, session);
    delete entry.pending;
    Object.assign(entry, out);
  }

  async settle() {
    for (let i = 0; i < 500 && this.jobs.size; i++) await pause(10);
  }

  tap() {
    for (const event of this.reader.events ?? []) {
      const session = [...this.sessions].find(([, observer]) => observer === event.sessionId)?.[0];
      if (!session) continue;
      const response = event.params?.redirectResponse ?? event.params?.response;
      if (response?.url?.startsWith(this.prefix) && redirects.includes(response.status))
        this.track(this.networkBody(event.params.requestId, 'tap', session));
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
    const { answered: attempts, short } = this.answers('Network.getResponseBody');
    const refusedAll = attempts.length > 0 && attempts.every(refused);
    const proven = path === 'network' || this.side !== 'guarded' || this.controls?.networkEvents;
    const reason =
      path === 'none'
        ? 'no network id for the redirect'
        : !proven
          ? 'control did not prove the redirect Network events'
          : short
            ? 'not every network body read was answered on a live owner'
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
    const own = events.filter((event) => this.sessions.has(event.sessionId));
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
    const missing = (open.length > 0 && (this.side === 'control' || this.end)) || this.cut();
    const who = this.end ? `session ended (${this.end}) with requests` : 'control requests';
    const detail = open.length
      ? `${who} ${open.join(', ')} unterminated`
      : 'probe ended before every request was issued';
    return {
      hops,
      requestsTerminated: missing ? 'incomplete' : !open.length,
      ...(missing ? { incomplete: `redirect-secret: ${detail}` } : {}),
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
    if (this.ended() || this.halted) return false;
    const recovered = await outcome(
      (async () => {
        const { targetId } = await createObserverTarget(this.reader, { url: 'about:blank' });
        this.targets.add(targetId);
        const { sessionId: observer } = await this.reader.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        if (!observer) throw new Error('ordinary observer session missing');
        this.observers.add(observer);
        await this.reader.send('Page.enable', {}, observer);
        if (this.side === 'guarded') await this.reader.send('Network.enable', {}, observer);
        await load(this.reader, observer, `${this.ordinary}/doc?n=${this.tag}-${suffix}`);
        const { sessionId } = await this.client.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        if (!sessionId) throw new Error('ordinary client session missing');
        this.sessions.set(sessionId, observer);
        this.internalSessions?.add(sessionId);
        this.session = sessionId;
        await this.enable();
      })()
    );
    if (!recovered.ok) {
      this.halted = true;
      this.missing.push(`redirect-secret: ordinary tab recovery ${recovered.error.message}`);
    }
    return recovered.ok;
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
    this.sessions.set(this.session, this.observer);
    this.observers.add(this.observer);
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

  async enable() {
    for (const domain of ['Page', 'Network', 'Runtime', 'Log', 'Audits'])
      await this.send(`${domain}.enable`);
    await this.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' },
      ],
    });
  }

  async setup() {
    await this.enable();
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
        if (this.ended() || this.halted) return;
        const code = this.mode === 'mix' ? [301, 303, 307, 308][index] : 302;
        const url = await this.register(`${index}-${kind}`, to, code);
        const start = this.client.events.length;
        if (kind === 'navigate') await this.send('Page.navigate', { url });
        else {
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
      resourceContentAttempted: !resource.ended,
      snapshotAttempted: !snapshot.ended,
      domSnapshotAttempted: !dom.ended,
      ordinaryResource: this.contains(resource),
      ordinarySnapshot: this.contains(snapshot),
      ordinaryDOM: this.contains(dom),
    });
  }

  async override(url) {
    if (!(await this.reset('override'))) return;
    this.holdURL = `${this.ordinary}/data?n=${this.tag}-override`;
    this.held = undefined;
    await this.send('Runtime.evaluate', {
      expression: `fetch(${JSON.stringify(this.holdURL)}).catch(()=>{});void 0`,
    });
    await waitFor(() => Boolean(this.held) || this.ended(), 5000, 10);
    if (!this.held) {
      this.holdURL = undefined;
      if (await this.lost()) return;
      this.overrideIncomplete = true;
      this.missing.push('redirect-secret: override pause not observed');
      return;
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
    const replay = await this.send('Network.replayXHR', { requestId: xhr.params.requestId });
    this.responses.push({ replayAttempted: !replay.ended });
    await pause(500);
    for (const step of [
      () => this.snapshots(url, to, frameId),
      () => this.iframe(),
      () => this.override(url),
    ]) {
      if (this.ended() || this.halted) return;
      await step();
    }
  }

  async iframe() {
    if (!(await this.reset('iframe'))) return;
    const url = await this.register('iframe', this.destinations[1]);
    await this.send('Runtime.evaluate', {
      expression: `(()=>{const f=document.createElement('iframe');f.src=${JSON.stringify(url)};document.body.append(f)})();void 0`,
    });
    const control = this.side === 'control';
    const ms = Math.round(5000 * this.scale);
    let snapshot;
    let dom;
    let ordinaryIframeSnapshot = false;
    let ordinaryIframeDOM = false;
    const read = async () => {
      await this.send('Page.getFrameTree');
      snapshot = await this.send('Page.captureSnapshot', { format: 'mhtml' });
      dom = await this.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
      ordinaryIframeSnapshot ||= snapshot.ok && this.contains(snapshot);
      ordinaryIframeDOM ||= dom.ok && this.contains(dom);
      return this.ended() || (ordinaryIframeSnapshot && ordinaryIframeDOM);
    };
    if (control) {
      if (!(await waitFor(read, ms, 50))) {
        const missing = [
          !ordinaryIframeSnapshot && 'ordinaryIframeSnapshot',
          !ordinaryIframeDOM && 'ordinaryIframeDOM',
        ].filter(Boolean);
        this.missing.push(
          `redirect-secret: control iframe ${missing.join(', ')} not observed within ${ms}ms`
        );
      }
    } else {
      await pause(500);
      await read();
    }
    this.responses.push({
      iframeSnapshotAttempted: !snapshot.ended && !dom.ended,
      ordinaryIframeSnapshot: ordinaryIframeSnapshot || (control ? 'incomplete' : false),
      ordinaryIframeDOM: ordinaryIframeDOM || (control ? 'incomplete' : false),
    });
  }

  observerTraffic(value) {
    return (
      this.client === this.reader &&
      this.observers.has(value?.sessionId) &&
      !this.sessions.has(value?.sessionId)
    );
  }

  observerMessage(message) {
    try {
      return this.observerTraffic(JSON.parse(message));
    } catch {
      return false;
    }
  }

  overrideCheck(key, unseen) {
    const overrides = this.responses.filter((entry) => entry.overrideMethod);
    if (!overrides.length) return this.overrideIncomplete ? 'incomplete' : unseen;
    return overrides.every((entry) => entry[key]);
  }

  async survival() {
    for (const session of this.sessions.keys()) await this.send('Fetch.disable', {}, session);
    if (!(await this.reset('survive'))) return { ok: false };
    return this.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
  }

  async evidence() {
    if (!this.ended()) await pause(8000);
    if (!this.ended()) this.tap();
    if (this.side === 'control' && this.controls)
      this.controls.networkEvents = this.learned.network.size > 0;
    const survives = await this.survival();
    await this.settle();
    await this.terminated();
    const events = this.client.events
      .slice(this.eventsStart)
      .filter((event) => !this.observerTraffic(event));
    const messages = (this.client.messages?.slice(this.messagesStart) ?? []).filter(
      (message) => !this.observerMessage(message)
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
        this.sessions.has(event.sessionId) &&
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
      (extra.length >= this.destinations.length * 4 || (this.cut() ? 'incomplete' : false));
    const unseen = this.end || this.halted ? 'incomplete' : false;
    const found = (key) => {
      const values = this.responses.map((entry) => entry[key]);
      return values.includes(true) || (values.includes('incomplete') ? 'incomplete' : false);
    };
    const fetchReads = this.answers('Fetch.getResponseBody');
    const fetchLeaked = fetchReads.answered.some((entry) => !refused(entry));
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
      sessionSurvives: this.halted
        ? 'incomplete'
        : survives.ok && survives.result?.result?.value === 'doc',
      sessionEnded: this.ended(),
      fetchBodyAttempted: fetchReads.short ? 'incomplete' : fetchReads.answered.length > 0,
      fetchBodyRefused: fetchLeaked
        ? false
        : fetchReads.short
          ? 'incomplete'
          : fetchReads.answered.length > 0,
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
      overridesRefused: this.overrideCheck('overrideRefused', unseen),
      overridesWorked: this.overrideCheck('overrideWorked', unseen),
    };
    const incomplete = [evidence.incomplete, ...this.missing];
    if (this.end && Object.values(evidence).includes('incomplete'))
      incomplete.push(`redirect-secret: session ended (${this.end})`);
    return incomplete.some(Boolean)
      ? { ...evidence, incomplete: incomplete.filter(Boolean).join('; ') }
      : evidence;
  }

  async close() {
    this.stopped = true;
    await this.watching;
    await this.settle();
    for (const session of this.sessions.keys()) {
      if (!this.ended()) await outcome(this.client.send('Fetch.disable', {}, session));
      if (session !== this.sessions.keys().next().value) this.internalSessions?.delete(session);
    }
    for (const observer of this.observers)
      await outcome(this.reader.send('Target.detachFromTarget', { sessionId: observer }));
    if (this.observer) {
      await outcome(
        this.reader.send('Network.deleteCookies', {
          name: this.cookie,
          domain: 'seven.sliccy.ai',
          path: '/',
        })
      );
    }
    for (const targetId of this.targets)
      await outcome(this.reader.send('Target.closeTarget', { targetId }));
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
    probe.complete = !probe.ended() && !probe.halted;
    const evidence = await probe.evidence();
    if (probe.end && options.side !== 'guarded')
      throw new Error(`redirect-secret: ${options.side} session ended (${probe.end})`);
    return evidence;
  } finally {
    await probe.close();
  }
}
