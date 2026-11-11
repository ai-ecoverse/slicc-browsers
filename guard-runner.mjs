import { fixtureClient, prepareFixture } from './fixture-client.mjs';

export { fixtureClient };

import { bfcacheRestore } from './bfcache-restore.mjs';
import { extensionFrame } from './extension-frame.mjs';
import { DEFAULT_EXTENSION_WORLD_ID, extensionWorld } from './extension-world.mjs';
import { frameRead } from './frame-read.mjs';
import {
  beacon,
  canary,
  debuggerCleanup,
  debuggerPaused,
  expand,
  hop,
  inapplicable,
  isRefusal,
  knownOrigins,
  loadedAfter,
  originDefaults,
  outcome,
  owned,
  parseURL,
  refusalError,
  summary as report,
  result,
  skipReason,
  steps,
  trustedClientOnly,
  waitFor,
} from './guard-driver.mjs';
import { createObserverTarget, discoveryViolation } from './observer-target.mjs';
import { protectedErrorPage } from './protected-error-page.mjs';
import {
  leftoverPersistentWorker,
  persistentWorkerTypes,
  probeWorkerSessions,
  protectedWorker,
  releasePersistentWorkerSessions,
  workerTypeForKind,
} from './protected-worker.mjs';
import { redirectSecret } from './redirect-secret.mjs';
import { canonicalURL, unparseableURLs } from './unparseable-url.mjs';

export { leftoverPersistentWorker, releasePersistentWorkerSessions, workerTypeForKind };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const namedResultMs = 10000;
const observeMs = 5000;

function autoAttachSession(events, start, targetId) {
  return events
    .slice(start)
    .filter(
      (event) =>
        event.method === 'Target.attachedToTarget' &&
        event.params?.targetInfo?.targetId === targetId &&
        event.params?.sessionId
    )
    .at(-1)?.params?.sessionId;
}

export function reusableAttachSession(step, out, params, events, start) {
  if (!step?.reuseSession || step.cdp !== 'Target.attachToTarget' || !params?.targetId)
    return undefined;
  if (out?.ok && out.result?.sessionId) return undefined;
  const message = String(out?.error?.message ?? '');
  if (/refused|not allowed/i.test(message)) return undefined;
  const already =
    (out?.ok === true && !out.result?.sessionId) ||
    /already attached|attached already|Target is attaching or attached/i.test(message);
  if (!already) return undefined;
  return autoAttachSession(events, start, params.targetId);
}
const browserUiAttempts = 3;
const browserUiMs = 5000;
const q = JSON.stringify;

const at = (value, path = '') =>
  path
    .split('.')
    .filter(Boolean)
    .reduce((v, k) => v?.[k], value);
const supported = (requires, capabilities) =>
  (requires ?? []).every((c) =>
    Array.isArray(capabilities) ? capabilities.includes(c) : capabilities[c] === true
  );
const declared = (capability, capabilities) =>
  Array.isArray(capabilities)
    ? capabilities.includes(capability)
    : capabilities[capability] === true;
const gatedOut = (observation, capabilities) =>
  !supported(observation?.requires, capabilities) ||
  (observation?.unless ?? []).some((capability) => declared(capability, capabilities));
const matches = (value, predicate) => {
  if (predicate === null || typeof predicate !== 'object') return value === predicate;
  return Object.entries(predicate).every(([key, want]) => {
    if (key === '$encoded') return value === `${want.prefix ?? ''}${btoa(want.value)}`;
    if (key === '$contains') return typeof value === 'string' && value.includes(want);
    if (key === '$regex')
      return new RegExp(want).test(typeof value === 'object' ? q(value) : String(value ?? ''));
    if (key === '$some') return Array.isArray(value) && value.some((item) => matches(item, want));
    if (key === '$every')
      return Array.isArray(value) && value.length > 0 && value.every((item) => matches(item, want));
    if (key === '$absentOr') return value === undefined || value === want;
    return matches(value?.[key], want);
  });
};

const observedValue = (out, path) => {
  const value = at(out, path);
  if (
    /timeout|timed out/i.test(String(out?.error?.message ?? out?.error ?? '')) ||
    out?.result?.exceptionDetails ||
    value === 'timeout'
  )
    throw new Error('Observation did not complete');
  return value;
};

const address = (value) =>
  typeof value === 'string' ? value : hop(value.hops.slice(value.index ?? 0), value.to);
const resultNames = (check) =>
  [
    check?.result,
    ...[...(check?.all ?? []), ...(check?.any ?? []), ...(check?.not ? [check.not] : [])].flatMap(
      resultNames
    ),
  ].filter(Boolean);
const stateCheck = (check) =>
  check?.state ||
  [...(check?.all ?? []), ...(check?.any ?? []), ...(check?.not ? [check.not] : [])]
    .map(stateCheck)
    .find(Boolean);
const refusedOut = (step, out) =>
  step.refusable ? isRefusal(out, step) : /refused/.test(String(out.error?.message ?? out.error));

function pageExpression(step, url) {
  let expression;
  switch (step.page) {
    case 'eval':
      expression = step.expression;
      break;
    case 'href':
      expression = `location.href=${q(url)}`;
      break;
    case 'replace':
      expression = `location.replace(${q(url)})`;
      break;
    case 'open':
      expression = `(() => { window.open(${q(url)}); return 'opened'; })()`;
      break;
    case 'iframe':
      expression = `(() => { const f=document.createElement('iframe'); f.src=${q(url)}; document.body.append(f); return true; })()`;
      break;
    case 'form':
    case 'post':
      expression = `(() => { const u=new URL(${q(url)}); const f=document.createElement('form'); f.method=${q(step.page === 'post' ? 'POST' : 'GET')}; f.action=u.origin+u.pathname${step.page === 'post' ? '+u.search' : ''}; for (const [name,value] of u.searchParams) { const i=document.createElement('input'); i.type='hidden'; i.name=name; i.value=value; f.append(i); } document.body.append(f); f.submit(); return true; })()`;
      break;
    case 'fetch':
      expression = `fetch(${q(url)},${q({ credentials: step.credentials ?? 'same-origin' })}).then(async r=>${step.status ? "r.status+' '+" : ''}(await r.text()),()=> 'error')`;
      break;
    case 'xhr':
      expression = `new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET',${q(url)});x.onload=()=>resolve(${step.status ? "x.status+' '+" : ''}x.responseText);x.onerror=()=>resolve('error');x.send();})`;
      break;
    case 'image':
      expression = `new Promise(resolve=>{const i=new Image();i.onload=()=>resolve('width '+i.naturalWidth);i.onerror=()=>resolve('error');i.src=${q(url)};})`;
      break;
    case 'script':
      expression = `new Promise(resolve=>{const s=document.createElement('script');s.onload=()=>resolve(String(globalThis.vectorScript));s.onerror=()=>resolve('error');s.src=${q(url)};document.head.append(s);})`;
      break;
    default:
      throw new Error(`Unknown page kind: ${step.page}`);
  }
  return expression;
}

class Execution {
  constructor(vector, side, options, clients, vars, delay) {
    Object.assign(this, { vector, side, options, clients, vars, delay });
    this.client =
      side === 'control' && vector.control.via === 'unguarded' ? clients.unguarded : clients.client;
    this.reader = clients.unguarded;
    this.calls = {};
    this.refused = {};
    this.sessions = {};
    this.cleanupEventStart = undefined;
    this.targets = [];
    this.contexts = [];
    this.pending = [];
    this.errors = [];
    this.incomplete = [];
    this.unsupported = undefined;
    this.preSent = [];
    this.notes = [];
    this.answers = [];
    this.internalSessions = new Set();
    this.attachSettings = new Map();
    this.tabSessions = new Set();
    this.childSteps = [];
    this.deferred = [];
    this.expectWhere = [...(vector.setup ?? []), ...(vector.trigger ?? [])].some(
      (step) => step.children && step.where
    );
    this.scale = options.settleScale ?? 1;
    this.refusalScale = options.refusalScale ?? 1;
    this.childRuns = new Map();
    this.named = new Map();
    this.eventMarks = new Map();
    this.processed = new Set();
    this.eventStart = this.client.events.length;
    this.actionEventStart = this.eventStart;
    this.requestStart = undefined;
    this.trace = [];
    this.stopped = false;
  }

  actor() {
    return this.exitedTo ?? this.client;
  }

  async exit() {
    const gone = this.client;
    this.exitRequestStart = (await this.options.fixture.log()).length;
    this.clients.exited = true;
    if (gone === this.reader)
      await gone.send('Target.detachFromTarget', { sessionId: this.sessions.page });
    else {
      if (typeof gone.close !== 'function') throw new Error('the guarded client has no close()');
      await gone.close();
    }
    const released = await this.poll(async () => {
      const read = await outcome(
        this.reader.send('Target.getTargetInfo', { targetId: this.pageTarget })
      );
      return read.ok && read.result.targetInfo?.attached === false;
    }, 5000);
    if (!released)
      this.notes.push(`client exit: the page stayed attached for ${this.bound(5000)}ms`);
    const { sessionId } = await this.reader.send('Target.attachToTarget', {
      targetId: this.pageTarget,
      flatten: true,
    });
    await this.reader.send('Page.enable', {}, sessionId);
    this.exitedTo = this.reader;
    this.sessions.page = sessionId;
    return { sessionId, released };
  }

  session(kind) {
    if (kind === 'browser') return undefined;
    return this.sessions[kind === 'child' ? 'child' : 'page'];
  }

  async evaluate(expression, session = this.sessions.page, client = this.client) {
    return outcome(
      client.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        session
      )
    );
  }

  async create(url, context = this.vars.context, client = this.client, background = true) {
    const params = {
      url: 'about:blank',
      background,
      ...(context ? { browserContextId: context } : {}),
    };
    const { targetId } =
      client === this.reader
        ? await createObserverTarget(this.reader, params, this.notes)
        : await client.send('Target.createTarget', params);
    this.targets.push(targetId);
    this.pageTarget = targetId;
    this.vars.pageTarget = targetId;
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    await outcome(client.send('Network.enable', {}, sessionId));
    if (url !== 'about:blank') await this.navigate(client, sessionId, url);
    return { targetId, sessionId };
  }

  async navigate(client, session, url) {
    const start = client.events.length;
    const out = await outcome(client.send('Page.navigate', { url }, session));
    if (out.ok && !out.result.errorText && out.result.loaderId)
      await this.poll(
        () => loadedAfter(client.events.slice(start), session, out.result.loaderId),
        3000
      );
    return out;
  }

  bound(ms, absent = false) {
    return Math.round(ms * (absent ? this.refusalScale : this.scale));
  }

  async poll(predicate, ms = 1500, absent = false, bounded = false) {
    return waitFor(predicate, this.bound(ms, absent), 25, bounded);
  }

  async prepareState(spec) {
    if (!spec || !this.reader) return;
    const state = expand(spec, this.vars);
    await this.reader.send('Storage.setCookies', {
      cookies: [{ name: state.cookie, value: state.value, url: state.origin }],
      ...(this.vars.context ? { browserContextId: this.vars.context } : {}),
    });
    if (!state.storage) return;
    const { targetId } = await createObserverTarget(
      this.reader,
      {
        url: 'about:blank',
        ...(this.vars.context ? { browserContextId: this.vars.context } : {}),
      },
      this.notes
    );
    this.canaryTarget = targetId;
    this.targets.push(targetId);
    const { sessionId } = await this.reader.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    this.canarySession = sessionId;
    await this.reader.send('Page.enable', {}, sessionId);
    await this.navigate(
      this.reader,
      sessionId,
      `${state.origin}/canary/${this.vars.tag}?value=${encodeURIComponent(state.value)}`
    );
    const planted = await this.evaluate(canary.plant(state.value), sessionId, this.reader);
    if (!planted.ok || planted.result?.result?.value !== true)
      throw new Error('Canary seeding failed');
  }

  async readState(state) {
    const { cookies } = await this.reader.send(
      'Storage.getCookies',
      this.vars.context ? { browserContextId: this.vars.context } : {}
    );
    const cookie = cookies.find(
      (entry) =>
        entry.name === state.cookie &&
        entry.domain.replace(/^\./, '') === new URL(state.origin).hostname
    );
    if (cookie?.value !== state.value) return false;
    if (!state.storage) return true;
    const read = await this.evaluate(canary.read(), this.canarySession, this.reader);
    return read.ok && canary.untouched(state.value, read.result?.result?.value);
  }

  async awaitPre() {
    const sent = [...new Set(this.preSent)];
    if (!sent.length || !usesPre(this.vector)) return [];
    const missing = async () => {
      const seen = await Promise.all(sent.map((url) => this.attemptCheck({ pre: url })));
      return sent.filter((_, index) => !seen[index]);
    };
    await this.poll(async () => (await missing()).length === 0, 5000);
    return missing();
  }

  async attemptCheck(c) {
    const logs = owned((await this.options.fixture.log()).slice(this.requestStart), this.vars.tag);
    if (c.pre) {
      const url = address(c.pre);
      return logs.some((entry) => {
        const request = parseURL(entry.url);
        return (
          request?.pathname === '/live' &&
          request.searchParams.get('tag') === this.vars.tag &&
          request.searchParams.get('step') === 'pre' &&
          request.searchParams.get('to') === url
        );
      });
    }
    const url = address(c.loaded);
    const origin = parseURL(url)?.origin;
    return logs.some((entry) => {
      if (entry.url === url || canonicalURL(entry.url) === canonicalURL(url)) return true;
      const request = parseURL(entry.url);
      return (
        request?.pathname === '/live' &&
        request.origin === origin &&
        request.searchParams.get('tag') === this.vars.tag &&
        request.searchParams.get('to') === url &&
        request.searchParams.get('step') !== 'pre'
      );
    });
  }

  clientBlocked(spec, urls) {
    const session = spec.session === 'child' ? this.sessions.child : this.sessions.page;
    if (!session) return false;
    const events = this.client.events.slice(this.eventStart);
    const requests = new Map();
    const mainFrames = new Set();
    const mainLoaders = new Set();
    for (const event of events) {
      if (event.sessionId !== session) continue;
      if (event.method === 'Network.requestWillBeSent')
        requests.set(event.params.requestId, {
          url: event.params.request.url,
          type: event.params.type,
          frameId: event.params.frameId,
          loaderId: event.params.loaderId,
        });
      if (event.method === 'Page.frameNavigated' && !event.params.frame.parentId) {
        mainFrames.add(event.params.frame.id);
        if (event.params.frame.loaderId) mainLoaders.add(event.params.frame.loaderId);
      }
    }
    const navigated = (event) => {
      const child = event.params.frame.parentId || event.sessionId === this.sessions.child;
      const frameOk = spec.frame ? child : !event.params.frame.parentId;
      return (
        frameOk &&
        urls.includes(event.params.frame.unreachableUrl) &&
        event.params.frame.url.startsWith('chrome-error://')
      );
    };
    const failed = (event) => {
      const request = requests.get(event.params.requestId);
      if (
        request?.type !== 'Document' ||
        !urls.includes(request.url) ||
        !(event.params.blockedReason || event.params.errorText === 'net::ERR_BLOCKED_BY_CLIENT')
      )
        return false;
      if (spec.frame) return Boolean(request.frameId && !mainFrames.has(request.frameId));
      return (
        (request.frameId && mainFrames.has(request.frameId)) ||
        (request.loaderId && mainLoaders.has(request.loaderId))
      );
    };
    return events.some(
      (event) =>
        event.sessionId === session &&
        ((event.method === 'Page.frameNavigated' && navigated(event)) ||
          (event.method === 'Network.loadingFailed' && failed(event)))
    );
  }

  async readerFrameTree(targetId, label) {
    const attached = await outcome(
      this.reader.send('Target.attachToTarget', { targetId, flatten: true })
    );
    if (!attached.ok) return { ok: false, sessionId: undefined, frameTree: undefined };
    const sessionId = attached.result.sessionId;
    await outcome(this.reader.send('Runtime.runIfWaitingForDebugger', {}, sessionId));
    const read = await outcome(this.reader.send('Page.getFrameTree', {}, sessionId));
    if (!read.ok) {
      await outcome(this.reader.send('Target.detachFromTarget', { sessionId }));
      throw new Error(
        `Page.getFrameTree timed out on ${label} target ${targetId} session ${sessionId}: ${read.error?.message ?? 'unknown'}`
      );
    }
    return { ok: true, sessionId, frameTree: read.result.frameTree };
  }

  async blocked(spec, observer) {
    const urls = (spec.anyOf ?? [spec.url]).map(address);
    if (observer === 'client') return this.clientBlocked(spec, urls);
    const targetId = spec.session === 'child' ? this.targets.at(-1) : this.pageTarget;
    if (!targetId) return false;
    const attached = await this.readerFrameTree(targetId, 'blocked page');
    if (!attached.ok) return false;
    try {
      const blockedFrame = (frame) =>
        Boolean(
          frame && urls.includes(frame.unreachableUrl) && frame.url.startsWith('chrome-error://')
        );
      const visit = (tree) =>
        Boolean(tree && (blockedFrame(tree.frame) || (tree.childFrames ?? []).some(visit)));
      if (spec.frame) {
        if ((attached.frameTree.childFrames ?? []).some(visit)) return true;
        return Boolean(await this.blockedFrameTarget(urls, targetId));
      }
      return blockedFrame(attached.frameTree.frame);
    } finally {
      await outcome(this.reader.send('Target.detachFromTarget', { sessionId: attached.sessionId }));
    }
  }

  async frameIds(targetId) {
    const attached = await this.readerFrameTree(targetId, 'frameIds page');
    if (!attached.ok) return [];
    try {
      const ids = (tree) => [tree.frame.id, ...(tree.childFrames ?? []).flatMap(ids)];
      return ids(attached.frameTree);
    } finally {
      await outcome(this.reader.send('Target.detachFromTarget', { sessionId: attached.sessionId }));
    }
  }

  async blockedFrameTarget(urls, parentTarget) {
    const parents = await this.frameIds(parentTarget);
    const listed = await outcome(this.reader.send('Target.getTargets', {}));
    if (!listed.ok) return undefined;
    for (const info of listed.result.targetInfos) {
      if (info.type !== 'iframe' || !parents.includes(info.parentFrameId)) continue;
      let sessionId;
      try {
        const attached = await this.readerFrameTree(info.targetId, `iframe ${info.type}`);
        if (!attached.ok) continue;
        sessionId = attached.sessionId;
        const frame = attached.frameTree?.frame;
        if (frame?.url.startsWith('chrome-error://') && urls.includes(frame.unreachableUrl))
          return info.targetId;
      } finally {
        if (sessionId) await outcome(this.reader.send('Target.detachFromTarget', { sessionId }));
      }
    }
    return undefined;
  }

  async frameBlocked(spec) {
    const urls = (spec.anyOf ?? [spec.url]).map(address);
    const targetId = spec.session === 'child' ? this.targets.at(-1) : this.pageTarget;
    if (!targetId) return false;
    const frame = await this.blockedFrameTarget(urls, targetId);
    if (!frame) return false;
    const attached = await outcome(
      this.client.send('Target.attachToTarget', { targetId: frame, flatten: true })
    );
    if (attached.ok)
      await outcome(
        this.client.send('Target.detachFromTarget', { sessionId: attached.result.sessionId })
      );
    return !attached.ok;
  }

  async history(spec) {
    const urls = (spec.anyOf ?? [spec.url]).map(address);
    const targetId = spec.session === 'child' ? this.targets.at(-1) : this.pageTarget;
    if (!targetId) return false;
    const pre = await Promise.all(urls.map((url) => this.attemptCheck({ pre: url })));
    if (!pre.some(Boolean)) return false;
    const loaded = await Promise.all(urls.map((url) => this.attemptCheck({ loaded: url })));
    const unloaded = urls.filter((_, index) => !loaded[index]);
    if (!unloaded.length) return false;
    const attached = await outcome(
      this.reader.send('Target.attachToTarget', { targetId, flatten: true })
    );
    if (!attached.ok) return false;
    try {
      const read = await outcome(
        this.reader.send('Page.getNavigationHistory', {}, attached.result.sessionId)
      );
      return read.ok && read.result.entries.some((entry) => unloaded.includes(entry.url));
    } finally {
      await outcome(
        this.reader.send('Target.detachFromTarget', { sessionId: attached.result.sessionId })
      );
    }
  }

  async createContext() {
    const client = this.reader ?? this.client;
    try {
      return (await client.send('Target.createBrowserContext', {})).browserContextId;
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/timed? ?out/i.test(message)) throw error;
      this.notes.push(`Target.createBrowserContext retried once after: ${message}`);
      return (await client.send('Target.createBrowserContext', {})).browserContextId;
    }
  }

  async seed() {
    if (JSON.stringify([this.vector.setup, this.vector.trigger]).includes('{browserUi}')) {
      const listed = await (this.reader ?? this.client).send('Target.getTargets', {});
      const ui = listed.targetInfos?.find((info) => info.type === 'browser_ui');
      if (!ui) throw new Error('no browser_ui target to use as {browserUi}');
      this.vars.browserUi = ui.targetId;
    }
    if (supported(['browserContexts'], this.options.capabilities) && !this.vector.defaultContext) {
      const browserContextId = await this.createContext();
      this.vars.context = browserContextId;
      this.contexts.push(browserContextId);
    }
    const all = [...this.vector.setup, ...this.vector.trigger];
    const cookieCalls = all.some(
      (s) => /Cookies?$/.test(s.cdp ?? '') || s.params?.storageTypes?.includes('cookies')
    );
    if (cookieCalls && this.reader) {
      const cookies = [
        ...new Set([this.vars.target, this.vars.plain, this.vars.seven, this.vars.vault]),
      ].flatMap((url) => [
        { name: this.vars.cookie, value: this.vars.tag, url },
        { name: 'del', value: this.vars.tag, url },
      ]);
      await this.reader.send('Storage.setCookies', {
        cookies,
        ...(this.vars.context ? { browserContextId: this.vars.context } : {}),
      });
    }
    await this.prepareState(stateCheck(this.vector.liveCheck));
  }

  async pump() {
    while (!this.stopped && !this.clients.flight?.abandoned) {
      this.failWatched();
      for (const event of this.client.events.slice(this.eventStart)) {
        if (this.processed.has(event)) continue;
        this.processed.add(event);
        if (
          (event.method === 'Fetch.requestPaused' || event.method === 'Fetch.authRequired') &&
          !this.internalSessions.has(event.sessionId)
        ) {
          this.pending.push(
            this.answer(event).catch((error) => this.errors.push(String(error.message ?? error)))
          );
        }
        if (
          event.method === 'Target.attachedToTarget' &&
          event.params.targetInfo?.targetId !== this.pageTarget &&
          event.params.targetInfo?.targetId !== this.canaryTarget &&
          event.params.sessionId !== this.sessions.page
        )
          this.adopt(event);
      }
      await sleep(10);
    }
  }

  async resumeWaiting(from = this.eventStart) {
    for (const event of this.client.events.slice(from)) {
      if (
        event.method === 'Target.attachedToTarget' &&
        event.params?.waitingForDebugger &&
        event.params?.sessionId
      )
        await outcome(
          this.client.send('Runtime.runIfWaitingForDebugger', {}, event.params.sessionId)
        );
    }
  }

  adopt(event) {
    const info = event.params.targetInfo;
    const child = event.params.sessionId;
    if (info?.type === 'browser_ui') return;
    const paused = event.params.waitingForDebugger || this.tabSessions.has(event.sessionId);
    if (this.expectWhere && !this.childWhere) {
      this.deferred.push(event);
      return;
    }
    if (
      info?.browserContextId &&
      this.vars.context &&
      info.browserContextId !== this.vars.context
    ) {
      if (paused)
        this.pending.push(outcome(this.client.send('Runtime.runIfWaitingForDebugger', {}, child)));
      return;
    }
    const matched = !this.childWhere || this.childMatches(info);
    const isTab = info?.type === 'tab';
    if (!matched && !isTab) {
      if (paused)
        this.pending.push(outcome(this.client.send('Runtime.runIfWaitingForDebugger', {}, child)));
      return;
    }
    if (isTab) this.tabSessions.add(child);
    if (matched) {
      this.sessions.child = child;
      if (info?.targetId) this.targets.push(info.targetId);
    }
    const nested = matched
      ? this.childSteps
      : this.childSteps.filter((step) => step.cdp === 'Target.setAutoAttach');
    const started = (async () => {
      if (paused) await outcome(this.client.send('Runtime.runIfWaitingForDebugger', {}, child));
      const reload = nested.findIndex((step) => step.cdp === 'Page.reload');
      if (reload < 0) await this.execute(nested, child);
      else {
        await this.execute(nested.slice(0, reload), child);
        const start = this.client.events.length;
        await this.poll(
          () =>
            this.client.events
              .slice(start)
              .some((e) => e.method === 'Page.loadEventFired' && e.sessionId === child),
          1500
        );
        await this.execute(nested.slice(reload), child);
      }
      const resumed = this.client.events.length;
      if (nested.some((step) => step.cdp === 'Page.enable'))
        await this.poll(() => this.firstLoad(child, resumed), 5000);
    })().catch((error) =>
      this.errors.push(
        `adopt ${info?.type ?? 'target'} ${child}: ${String(error.message ?? error)}`
      )
    );
    this.childRuns.set(child, started);
    this.pending.push(started);
  }

  rule(event) {
    const p = event.params;
    return this.answers.find(
      (a) =>
        a.url === p.request.url &&
        (!a.stage || (a.stage === 'Response') === Boolean(p.responseStatusCode)) &&
        (a.cdp === 'Fetch.continueWithAuth') === (event.method === 'Fetch.authRequired')
    );
  }

  async paused({ url, ms }) {
    const seen = () =>
      this.client.events
        .slice(this.eventStart)
        .some(
          (event) =>
            (event.method === 'Fetch.requestPaused' || event.method === 'Fetch.authRequired') &&
            event.params?.request?.url === url &&
            this.rule(event)?.url === url
        );
    if (!(await this.poll(seen, ms, this.side === 'guarded')) && this.side === 'control')
      this.errors.push(`paused: no pause for ${url} within ${this.bound(ms)}ms`);
  }

  async answer(event) {
    const p = event.params;
    const rule = this.rule(event);
    if (rule?.hold) return;
    const method =
      rule?.cdp ??
      (event.method === 'Fetch.authRequired'
        ? 'Fetch.continueWithAuth'
        : p.responseStatusCode
          ? 'Fetch.continueResponse'
          : 'Fetch.continueRequest');
    const params =
      rule?.params ??
      (event.method === 'Fetch.authRequired'
        ? { authChallengeResponse: { response: 'CancelAuth' } }
        : {});
    const out = await outcome(
      this.client.send(method, { ...params, requestId: p.requestId }, event.sessionId)
    );
    this.calls[`answer.${p.requestId}.${event.method}`] = out;
  }

  firstLoad(session, from) {
    const events = this.client.events.slice(from);
    return events.some(
      (event, index) =>
        event.method === 'Page.frameNavigated' &&
        event.sessionId === session &&
        !event.params?.frame?.parentId &&
        events
          .slice(index + 1)
          .some((e) => e.method === 'Page.loadEventFired' && e.sessionId === session)
    );
  }

  childMatches(info) {
    if (this.childWhere.types !== undefined) {
      if (!this.childWhere.types.includes(info?.type)) return false;
    } else if (this.childWhere.type !== undefined) {
      if (this.childWhere.type !== info?.type) return false;
    }
    if (this.childWhere.openerId === 'page') return info?.openerId === this.pageTarget;
    if (this.childWhere.urlPrefix !== undefined)
      return String(info?.url ?? '').startsWith(this.childWhere.urlPrefix);
    return true;
  }

  async childrenSettled() {
    await Promise.all([...this.childRuns.values()]);
  }

  detached(session) {
    return this.client.events
      .slice(this.eventStart)
      .some((e) => e.method === 'Target.detachedFromTarget' && e.params?.sessionId === session);
  }

  record(step, out, session, phase, gone) {
    const refused = !gone && refusedOut(step, out);
    this.trace.push({
      phase,
      declared: Boolean(step.refusable),
      session,
      out,
      refused,
      ...(gone ? { detached: true } : {}),
    });
    const unanswered =
      step.refusable &&
      exitsClient(this.vector) &&
      !out.ok &&
      !refused &&
      /timeout|timed out|no answer/i.test(String(out.error?.message ?? out.error));
    if (step.refusable) this.refused[step.refusal.name] = unanswered ? 'incomplete' : refused;
    const trusted = this.side === 'control' && trustedClientOnly(step, out);
    if (trusted) this.unsupported = 'trustedEmulation';
    else if (unanswered) this.incomplete.push(`${step.refusal.name}: no answer`);
    else if (refusalError(step, out, refused, gone, phase, this.vector))
      this.errors.push(
        `${step.refusal.name} failed without a refusal: ${String(out.error?.message ?? out.error)}`
      );
    if (step.extensionWorld && out.result?.incomplete)
      this.errors.push(`extensionWorld ${step.extensionWorld}: ${out.result.incomplete}`);
    const probe = [
      'redirectSecret',
      'unparseable',
      'errorPage',
      'spawnWorker',
      'probeSessions',
      'extensionWorld',
      'extensionFrame',
      'frameRead',
      'bfcacheRestore',
    ].find((key) => step[key]);
    if (probe && !out.ok) this.errors.push(`${probe}: ${out.error?.message ?? 'probe failed'}`);
    if (step.client && !out.ok) this.errors.push(`client exit: ${out.error.message}`);
    if (
      [
        'errorPage',
        'redirectSecret',
        'extensionFrame',
        'frameRead',
        'bfcacheRestore',
        'spawnWorker',
        'probeSessions',
      ].includes(probe) &&
      out.ok &&
      out.result?.incomplete
    )
      this.incomplete.push(`${probe}: ${out.result.incomplete}`);
    if (step.as && !out.result?.pending) this.calls[step.as] = out;
    if (step.cdp) (this.calls.$cdp ??= []).push({ method: step.cdp, ...out });
  }

  async execute(list, childSession, phase = 'child') {
    if (phase === 'trigger') await this.childrenSettled();
    for (const [index, raw] of list.entries()) {
      if (phase === 'observation' && this.clients.flight?.abandoned) return;
      if (this.clients.flight)
        Object.assign(this.clients.flight, { leg: this.side, phase, step: index });
      const step = expand(raw, this.vars);
      if (!supported(step.requires, this.options.capabilities) || step.text) continue;
      if (!childSession && step.session === 'child') await this.childrenSettled();
      const session = childSession ?? this.session(step.session);
      const first = await this.operation(step, session, phase);
      if (!first) continue;
      const out = await this.browserUiRetry(step, first, session, phase);
      this.record(
        step,
        out,
        session,
        phase,
        Boolean(childSession) && !out.ok && this.detached(childSession)
      );
      if ((step.isolatedWorld || step.observer) && !out.ok)
        this.notes.push(
          `${step.isolatedWorld ? `isolatedWorld ${step.isolatedWorld}` : `observer ${step.observer}`}: ${out.error?.message ?? 'failed'}`
        );
      this.options.debug?.({ step, out, side: this.side });
    }
  }

  async browserUiRetry(step, out, session, phase) {
    const tried = new Set();
    let current = step;
    let last = out;
    for (let attempt = 1; attempt < browserUiAttempts; attempt++) {
      const next = await this.replacementUi(current, last, tried);
      if (!next) break;
      current = { ...current, params: { ...current.params, targetId: next } };
      last = await this.operation(current, session, phase);
    }
    return last;
  }

  async replacementUi(step, out, tried) {
    const vanished = step.params?.targetId;
    if (out.ok || !vanished || vanished !== this.vars.browserUi || refusedOut(step, out))
      return undefined;
    tried.add(vanished);
    const reader = this.reader ?? this.client;
    let next;
    await this.poll(async () => {
      const listed = await outcome(reader.send('Target.getTargets', {}));
      const infos = listed.ok ? (listed.result?.targetInfos ?? []) : [];
      if (!listed.ok || infos.some((info) => info.targetId === vanished)) return true;
      next = infos.find((info) => info.type === 'browser_ui' && !tried.has(info.targetId));
      return Boolean(next);
    }, browserUiMs);
    if (!next) return undefined;
    this.notes.push(
      `{browserUi} ${vanished} was gone when ${step.cdp} reached it; retried with ${next.targetId}`
    );
    this.vars.browserUi = next.targetId;
    return next.targetId;
  }

  async operation(step, session, phase) {
    if (step.children) {
      this.childSteps = step.children;
      this.childWhere = step.where;
      for (const event of this.deferred.splice(0)) this.adopt(event);
      return;
    }
    if (step.answer) {
      this.answers.push(step.answer);
      return;
    }
    if (step.wait !== undefined) {
      await sleep(step.wait);
      return;
    }
    if (step.paused) {
      await this.paused(step.paused);
      return;
    }
    if (step.settle) {
      await this.settle(step.settle);
      return;
    }
    if (step.client) return outcome(this.exit());
    if (step.redirectSecret || step.errorPage) return this.originProbe(step, session);
    if (step.spawnWorker) return this.spawnWorker(step);
    if (step.probeSessions) return this.probeSessions(step);
    if (step.bfcacheRestore)
      return outcome(
        bfcacheRestore({
          client: this.client,
          reader: this.reader,
          delayClient: this.clients.client,
          ordinary: this.vars.ordinary,
          protectedOrigin: step.origin,
          tag: this.vars.tag,
          mode: step.bfcacheRestore,
          forwardAudit: supported(['forwardAudit'], this.options.capabilities),
          side: this.side,
          notes: this.notes,
          budget: this.bound(5000),
        })
      );
    if (step.frameRead)
      return outcome(
        frameRead({
          client: this.client,
          reader: this.reader,
          top: step.from,
          framed: this.vars.target,
          tag: this.vars.tag,
          mode: step.frameRead,
          side: this.side,
          notes: this.notes,
          budget: this.bound(5000),
        })
      );
    if (step.unparseable)
      return outcome(
        unparseableURLs({
          client: this.client,
          reader: this.reader,
          session,
          targetId: this.pageTarget,
          origin: this.vars.ordinary,
          tag: this.vars.tag,
          fixture: this.options.fixture,
          browserSession: supported(['browserSession'], this.options.capabilities),
          notes: this.notes,
        })
      );
    if (step.extensionWorld)
      return outcome(
        extensionWorld({
          client: this.client,
          reader: this.reader,
          session,
          targetId: this.pageTarget,
          mode: step.extensionWorld,
          origin: this.vars.ordinary,
          side: this.side,
          controls: (this.clients.extensionWorldControls ??= {}),
          pauseMs: this.bound(this.side === 'control' ? 5000 : 1500, this.side !== 'control'),
          frameMs: this.bound(1000),
          extensionId: this.options.extensionWorldId,
        })
      );
    if (step.extensionFrame)
      return outcome(
        extensionFrame({
          client: this.client,
          reader: this.reader,
          session,
          targetId: this.pageTarget,
          mode: step.extensionFrame,
          origin: this.vars.ordinary,
          frameMs: this.bound(1000),
          extensionId: this.options.extensionFrameId ?? DEFAULT_EXTENSION_WORLD_ID,
          side: this.side,
          capabilities: this.options.capabilities,
        })
      );
    if (step.guess) return this.guess(step.guess, session);
    if (step.isolatedWorld) return outcome(this.isolatedWorld(step));
    if (step.observer) return outcome(this.watchPage(step));
    if (step.cdp) return this.cdp(step, session, phase);
    if (step.page) return this.page(step, session, phase);
    throw new Error('Unknown step kind');
  }

  referenced(value, session) {
    if (Array.isArray(value)) return value.map((item) => this.referenced(item, session));
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, '$result') || Object.hasOwn(value, '$event')) {
      const source = Object.hasOwn(value, '$result')
        ? this.calls[value.$result]
        : this.actor()
            .events.slice(this.eventStart)
            .filter(
              (event) =>
                event.method === value.$event &&
                (session === undefined || event.sessionId === session) &&
                matches(event, value.where ?? {})
            )
            .at(-1);
      const found = at(source, value.path);
      if (found === undefined)
        throw new Error(`unresolved reference ${value.$result ?? value.$event} ${value.path}`);
      return found;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, this.referenced(item, session)])
    );
  }

  async isolatedWorld(step) {
    const targetId = step.session === 'child' ? this.targets.at(-1) : this.pageTarget;
    const attached = await this.readerFrameTree(targetId, 'isolatedWorld page');
    if (!attached.ok) throw new Error('isolatedWorld attach failed');
    const { sessionId, frameTree } = attached;
    try {
      const { executionContextId } = await this.reader.send(
        'Page.createIsolatedWorld',
        { frameId: frameTree.frame.id, worldName: step.isolatedWorld },
        sessionId
      );
      const read = await this.reader.send(
        'Runtime.evaluate',
        {
          expression: step.expression,
          contextId: executionContextId,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId
      );
      return {
        contextId: executionContextId,
        value: read.result?.value,
        url: frameTree.frame.url,
        ...(read.exceptionDetails ? { exception: true } : {}),
      };
    } finally {
      await outcome(this.reader.send('Target.detachFromTarget', { sessionId }));
    }
  }

  async originProbe(step, session) {
    if (step.redirectSecret) {
      this.internalSessions.add(session);
      try {
        return await outcome(
          redirectSecret({
            client: this.client,
            reader: this.reader,
            session,
            targetId: this.pageTarget,
            ordinary: this.vars.ordinary,
            tag: this.vars.tag,
            fixture: this.options.fixture,
            mode: step.redirectSecret,
            side: this.side,
            settleScale: this.scale,
            controls: (this.clients.redirectSecretControls ??= {}),
            internalSessions: this.internalSessions,
          })
        );
      } finally {
        this.internalSessions.delete(session);
      }
    }
    return outcome(
      protectedErrorPage({
        client: this.client,
        reader: this.reader,
        session,
        targetId: this.pageTarget,
        ordinary: this.vars.ordinary,
        protectedOrigin: this.vars.seven,
        tag: this.vars.tag,
        internalSessions: this.internalSessions,
        mode: step.errorPage,
        side: this.side,
        secret: step.secret,
        discovery: supported(['discovery'], this.options.capabilities),
        notes: this.notes,
        budget: this.bound(5000),
      })
    );
  }

  spawnWorkerKind() {
    return allSteps([...(this.vector.setup ?? []), ...(this.vector.trigger ?? [])]).find(
      (step) => step.spawnWorker
    )?.spawnWorker;
  }

  async ensurePriorWorkersGone(kind) {
    if (this.side !== 'guarded') return;
    const type = workerTypeForKind(kind);
    if (!persistentWorkerTypes.has(type)) return;
    const prior = this.clients.priorWorker;
    const leftover = await leftoverPersistentWorker(this.reader ?? this.client, {
      type,
      ...(prior?.url || prior?.targetId ? { url: prior?.url, targetId: prior?.targetId } : {}),
    });
    if (leftover)
      throw new Error(
        `leftover ${type} still present before guarded spawn: ${leftover.url ?? leftover.targetId}`
      );
  }

  async spawnWorker(step) {
    if (step.as) this.eventMarks.set(step.as, this.client.events.length);
    const pageUrl = expand(step.url ?? '{target}/doc?n=host-{tag}', this.vars);
    const hostUrl = step.frame ? expand(step.frame, this.vars) : undefined;
    await this.ensurePriorWorkersGone(step.spawnWorker);
    const out = await outcome(
      protectedWorker({
        reader: this.reader,
        kind: step.spawnWorker,
        pageUrl,
        hostUrl,
        tag: this.vars.tag,
        context: this.vars.context,
        notes: this.notes,
        budget: this.bound(5000),
      })
    );
    if (out.ok && out.result?.browserContextId) {
      this.contexts.push(out.result.browserContextId);
      this.vars.context = out.result.browserContextId;
    }
    if (out.ok && out.result?.pageTargetId) this.targets.push(out.result.pageTargetId);
    if (out.ok && out.result?.workerTargetId) {
      this.vars.workerTarget = out.result.workerTargetId;
      this.targets.push(out.result.workerTargetId);
    }
    if (out.ok && out.result?.workerUrl && this.side === 'control')
      this.clients.priorWorker = {
        type: out.result.type,
        url: out.result.workerUrl,
        targetId: out.result.workerTargetId,
      };
    return out;
  }

  probeSessionIds(step) {
    const mark = this.eventMarks.get(step.probeSessions.since) ?? this.eventStart;
    const sessions = [];
    for (const event of this.client.events.slice(mark)) {
      if (event.method === 'Target.attachedToTarget' && event.params?.sessionId)
        sessions.push(event.params.sessionId);
    }
    for (const name of step.probeSessions.attach ?? ['attach']) {
      const sessionId = this.calls[name]?.result?.sessionId;
      if (sessionId) sessions.push(sessionId);
    }
    return sessions;
  }

  async probeSessions(step) {
    const out = await outcome(
      probeWorkerSessions({
        client: this.client,
        sessions: this.probeSessionIds(step),
        path: expand(step.probeSessions.path, this.vars),
        tag: this.vars.tag,
        detached: (sessionId) => this.detached(sessionId),
      })
    );
    this.probedSessionIds ??= new Set();
    for (const sessionId of out.result?.probedIds ?? []) this.probedSessionIds.add(sessionId);
    return out;
  }

  probeStep() {
    return [...(this.vector.setup ?? []), ...(this.vector.trigger ?? [])].find(
      (entry) => entry.probeSessions
    );
  }

  async probeFreshSessions() {
    const step = this.probeStep();
    if (!step?.probeSessions) return false;
    const expanded = expand(step, this.vars);
    this.probedSessionIds ??= new Set();
    const fresh = this.probeSessionIds(expanded).filter(
      (sessionId) => sessionId && !this.probedSessionIds.has(sessionId)
    );
    if (!fresh.length) return this.calls.probe?.result?.reachable === true;
    const out = await probeWorkerSessions({
      client: this.client,
      sessions: fresh,
      path: expand(expanded.probeSessions.path, this.vars),
      tag: this.vars.tag,
      detached: (sessionId) => this.detached(sessionId),
    });
    for (const sessionId of out.probedIds ?? []) this.probedSessionIds.add(sessionId);
    const sessions = [
      ...new Set([...(this.calls.probe?.result?.sessions ?? []), ...(out.probedIds ?? fresh)]),
    ];
    if (out.incomplete) {
      this.calls.probe = {
        ok: true,
        result: { ...(this.calls.probe?.result ?? {}), ...out, sessions },
      };
      this.incomplete.push(`probeSessions: ${out.incomplete}`);
      return 'incomplete';
    }
    const reachable = out.reachable || this.calls.probe?.result?.reachable === true;
    this.calls.probe = {
      ok: true,
      result: {
        ...(this.calls.probe?.result ?? {}),
        reachable,
        probed: (this.calls.probe?.result?.probed ?? 0) + out.probed,
        sessions,
      },
    };
    return reachable;
  }

  async observeProbeReachable(want, check) {
    if (want !== true && want !== false) return this.check(check);
    let seen = await this.probeFreshSessions();
    if (seen === 'incomplete') return 'incomplete';
    if (seen === true) return true;
    const met = await this.poll(
      async () => {
        if (this.clients.flight?.abandoned) return true;
        seen = await this.probeFreshSessions();
        if (seen === 'incomplete') return true;
        return seen === true;
      },
      observeMs,
      false
    );
    if (seen === 'incomplete') return 'incomplete';
    if (want === true && !met && !this.clients.flight?.abandoned) {
      this.incomplete.push(
        `workerReachable: probe evidence not observed within ${this.bound(observeMs)}ms`
      );
      return 'incomplete';
    }
    return seen === true;
  }

  async watchPage(step) {
    if (!this.watch) {
      const start = this.reader.events.length;
      const { sessionId } = await this.reader.send('Target.attachToTarget', {
        targetId: this.pageTarget,
        flatten: true,
      });
      this.watch = { sessionId, start, failed: new Set() };
      await this.reader.send('Page.enable', {}, sessionId);
      await this.reader.send('Runtime.enable', {}, sessionId);
      await this.reader.send('Debugger.enable', {}, sessionId);
    } else if (step.observer === 'watch') {
      this.watch.cleared = this.reader.events.length;
    }
    if (step.observer === 'fail') {
      await this.reader.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: step.url, requestStage: 'Request' }] },
        this.watch.sessionId
      );
      this.watch.failing = true;
    }
    return { watching: true };
  }

  failWatched() {
    if (!this.watch?.failing) return;
    for (const event of this.reader.events.slice(this.watch.start)) {
      if (
        event.method !== 'Fetch.requestPaused' ||
        event.sessionId !== this.watch.sessionId ||
        this.watch.failed.has(event.params.requestId)
      )
        continue;
      this.watch.failed.add(event.params.requestId);
      this.pending.push(
        outcome(
          this.reader.send(
            'Fetch.failRequest',
            { requestId: event.params.requestId, errorReason: 'BlockedByClient' },
            this.watch.sessionId
          )
        )
      );
    }
  }

  watched(c) {
    if (!this.watch) return 'unwatched';
    const from = c.afterClear ? (this.watch.cleared ?? this.watch.start) : this.watch.start;
    const until = c.afterClear ? undefined : this.watch.cleared;
    return this.reader.events
      .slice(from, until)
      .some(
        (event) =>
          event.sessionId === this.watch.sessionId &&
          (c.world !== undefined
            ? event.method === 'Runtime.executionContextCreated' &&
              event.params.context.name === c.world &&
              (c.origin === undefined || event.params.context.origin === c.origin)
            : event.method === 'Debugger.scriptParsed' && event.params.url === c.script)
      );
  }

  async settle(settle) {
    const refused = () => (settle.dependsOn ?? []).some((name) => this.refused[name]);
    const skipped = () => {
      this.notes.push(
        `settle:skipped-refused ${settle.beacon ? `beacon ${settle.beacon}` : settle.served ? `request ${settle.served}` : settle.title ? `title ${settle.title}` : 'load'}`
      );
    };
    const alt = settle.or;
    const absent = this.side === 'guarded' && !settle.required;
    if (refused() && !alt) return skipped();
    if (settle.variant) await sleep(this.delay);
    if (settle.title && !this.reader) {
      await sleep(this.bound(settle.ms ?? 1500, absent));
      return;
    }
    const arrived = async () => {
      if (refused()) return !alt || (await this.check(alt));
      if (settle.served) return this.requestCheck({ served: settle.served, tagged: false });
      if (settle.beacon)
        return (
          (await this.requestCheck({ beacon: settle.beacon }, this.actionRequestStart)) &&
          (!this.actionDestination ||
            (await this.requestCheck({ served: this.actionDestination }, this.actionRequestStart)))
        );
      if (settle.title) return this.check({ title: settle.title, session: settle.session });
      const events = this.actor().events.slice(this.actionEventStart);
      return events.some(
        (event, index) =>
          event.method === 'Page.frameNavigated' &&
          !event.params?.frame?.parentId &&
          events
            .slice(index + 1)
            .some((e) => e.method === 'Page.loadEventFired' && e.sessionId === event.sessionId)
      );
    };
    const met = await this.poll(arrived, settle.ms ?? 1500, absent);
    if (refused() && !alt) return skipped();
    if (settle.required && !met) {
      const missing = `settle: no ${settle.beacon ? `beacon from ${settle.beacon}` : settle.served ? `request for ${settle.served}` : settle.title ? `title ${settle.title}` : 'load'} within ${this.bound(settle.ms ?? 1500)}ms`;
      if (exitsClient(this.vector)) this.incomplete.push(missing);
      else this.errors.push(missing);
    }
  }

  async guess(guess, session) {
    const pauses = this.client.events
      .slice(this.eventStart)
      .filter((e) => e.method === 'Fetch.requestPaused');
    const ids = guess.between.map(
      (url) => pauses.find((e) => e.params.request.url === url)?.params.requestId
    );
    const parts = ids.map((id) => /^(.*?)(\d+)(\.\d+)$/.exec(id ?? ''));
    const attempts = [];
    if (parts.every(Boolean) && parts[0][1] === parts[1][1] && parts[0][3] === parts[1][3]) {
      for (let n = Number(parts[0][2]) + 1; n < Number(parts[1][2]) && attempts.length < 256; n++) {
        const requestId = `${parts[0][1]}${n}${parts[0][3]}`;
        attempts.push(
          await outcome(this.client.send(guess.cdp, { ...guess.params, requestId }, session))
        );
      }
    }
    await sleep(100);
    return { ok: true, result: attempts };
  }

  async cdp(step, sessionId, phase) {
    if (
      debuggerCleanup(this.vector, step, phase) &&
      !debuggerPaused(this.client.events.slice(this.eventStart), sessionId)
    )
      return { ok: true, result: { cleanup: 'never paused' } };
    if (step.cdp === 'Target.detachFromTarget') await sleep(this.delay);
    if (step.cdp === 'Target.setAutoAttach' && step.params?.autoAttach === false)
      this.cleanupEventStart = this.client.events.length;
    let params;
    try {
      params = this.referenced({ ...step.params }, sessionId);
    } catch (error) {
      return { ok: false, error: { message: error.message } };
    }
    const session =
      step.session === 'page-or-browser' &&
      supported(['browserSession'], this.options.capabilities) &&
      /^Storage\.(getCookies|setCookies|clearCookies)$/.test(step.cdp)
        ? undefined
        : sessionId;
    if (
      /^Storage\.(getCookies|setCookies|clearCookies)$/.test(step.cdp) &&
      this.vars.context &&
      !params.browserContextId &&
      session === undefined
    )
      params.browserContextId = this.vars.context;
    const pending = outcome(this.actor().send(step.cdp, params, session));
    let timer;
    const out =
      step.refusable && exitsClient(this.vector)
        ? await Promise.race([
            pending,
            new Promise((resolve) => {
              timer = setTimeout(
                () => resolve({ ok: false, error: { message: 'no answer' } }),
                this.bound(this.options.namedResultMs ?? namedResultMs)
              );
            }),
          ])
        : await pending;
    clearTimeout(timer);
    if (step.cdp === 'Target.setAutoAttach' && out.ok) {
      if (params.autoAttach) this.attachSettings.set(session, true);
      else this.attachSettings.delete(session);
    }
    if (step.cdp === 'Target.createTarget' && out.ok && out.result?.targetId)
      this.targets.push(out.result.targetId);
    if (step.cdp === 'Target.createBrowserContext' && out.ok) {
      this.vars.context = out.result.browserContextId;
      this.contexts.push(this.vars.context);
      await this.seedContext(this.vars.context);
    }
    if (step.reuseSession) {
      const reused = reusableAttachSession(step, out, params, this.client.events, this.eventStart);
      if (reused) {
        await outcome(this.client.send('Runtime.runIfWaitingForDebugger', {}, reused));
        this.notes.push(`Target.attachToTarget reused auto-attach session for ${params.targetId}`);
        return { ok: true, result: { sessionId: reused, reused: true } };
      }
    }
    return out;
  }

  async seedContext(context) {
    await this.reader.send('Storage.setCookies', {
      cookies: [{ name: this.vars.cookie, value: this.vars.tag, url: this.vars.target }],
      browserContextId: context,
    });
  }

  namedCallSummaries() {
    return Object.fromEntries(
      ['attach', 'spawn', 'targets', 'probe', 'tabs']
        .filter((name) => this.calls[name])
        .map((name) => {
          const out = this.calls[name];
          return [
            name,
            {
              ok: out.ok,
              ...(out.result?.sessionId ? { sessionId: true } : {}),
              ...(out.result?.exists !== undefined ? { exists: out.result.exists } : {}),
              ...(out.result?.reachable !== undefined ? { reachable: out.result.reachable } : {}),
              ...(out.result?.incomplete ? { incomplete: out.result.incomplete } : {}),
              ...(out.error ? { error: String(out.error?.message ?? out.error) } : {}),
            },
          ];
        })
    );
  }

  async page(step, session, phase) {
    const client = this.actor();
    this.actionEventStart = client.events.length;
    this.actionRequestStart = (await this.options.fixture.log()).length;
    this.actionDestination = step.hops ? step.url : undefined;
    const url = step.hops ? hop(step.hops, step.url) : step.url;
    const pre =
      phase === 'trigger' && url
        ? `try { navigator.sendBeacon(${q(`${this.vars.log}/live?tag=${this.vars.tag}&step=pre&to=`)} + encodeURIComponent(${q(url)})); } catch {}`
        : '';
    if (step.page === 'tab') {
      const tab = await this.create(
        url,
        step.context ?? this.vars.context,
        client,
        step.background ?? true
      );
      this.sessions.page = tab.sessionId;
      this.pageTarget = tab.targetId;
      return { ok: true, result: tab };
    }
    if (pre && step.page !== 'framed') this.preSent.push(url);
    if (step.page === 'navigate') {
      if (pre) await this.evaluate(pre, session, client);
      return this.navigate(client, session, url);
    }
    if (step.page === 'framed') {
      if (phase === 'trigger') this.preSent.push(url);
      return this.navigate(
        client,
        session,
        `${step.from}/framed?tag=${encodeURIComponent(this.vars.tag)}&url=${encodeURIComponent(url)}&log=${encodeURIComponent(this.vars.log)}`
      );
    }
    let expression = pageExpression(step, url);
    if (pre) expression = `(() => { ${pre} return (${expression}); })()`;
    const promise = this.evaluate(expression, session, client);
    if (step.background) {
      const done = promise.then((out) => {
        if (typeof step.as === 'string') this.calls[step.as] = out;
      });
      this.pending.push(done);
      if (typeof step.as === 'string') this.named.set(step.as, done);
      return { ok: true, result: { pending: true } };
    }
    const out = await promise;
    if (step.page === 'open') {
      await this.poll(() => Boolean(this.sessions.child), 1500);
      if (!this.childSteps.length && this.sessions.child)
        await outcome(this.client.send('Runtime.runIfWaitingForDebugger', {}, this.sessions.child));
    }
    return out;
  }

  async namedSettled(names) {
    const waits = names.map((name) => this.named.get(name)).filter(Boolean);
    if (!waits.length) return true;
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        this.bound(this.options.namedResultMs ?? namedResultMs)
      );
    });
    const done = await Promise.race([Promise.all(waits).then(() => true), expired]);
    clearTimeout(timer);
    if (!done) this.pending = this.pending.filter((work) => !waits.includes(work));
    return done;
  }

  async ready(c) {
    if (c.observer === 'unguarded' && !this.reader) return false;
    return this.namedReady(c);
  }

  async namedReady(c) {
    const names = [c.result, ...(c.compare ?? []), c.refused, c.reached]
      .flat()
      .filter((name) => typeof name === 'string' && this.named.has(name));
    if (!names.length || (await this.namedSettled(names))) return true;
    this.errors.push(
      `${names.join(', ')} did not complete within ${this.bound(this.options.namedResultMs ?? namedResultMs)}ms`
    );
    return false;
  }

  forwardedCheck(name, check, want) {
    const ledger = this.actor().forwarded;
    if (!Array.isArray(ledger)) {
      if (want === undefined) return false;
      this.incomplete.push(`${name}: forwarding audit unavailable`);
      return 'incomplete';
    }
    const c = expand(check, this.vars);
    const call = [...ledger]
      .reverse()
      .find(
        (entry) => entry.method === c.forwarded.method && matches(entry, c.forwarded.where ?? {})
      );
    if (!call) return false;
    return matches(call.params ?? {}, c.forwarded.params ?? {});
  }

  async absenceCheck(check) {
    const first = await this.check(check);
    if (first === 'unwatched' || first === 'incomplete') return first;
    if (first === true) return true;
    const late = await this.poll(async () => (await this.check(check)) === true, observeMs, false);
    return !!late;
  }

  observeEarly(name, check, want) {
    if (name === 'workerReachable' && this.probeStep())
      return this.observeProbeReachable(want, check);
    if (check?.forwarded) return this.forwardedCheck(name, check, want);
    if (
      check?.result &&
      (at(this.calls[check.result], check.path) === 'incomplete' || this.unmeasured(check))
    )
      return 'incomplete';
    return undefined;
  }

  async observe(name, check) {
    const want = (this.side === 'control' ? this.vector.control.expected : this.vector.expected)?.[
      name
    ];
    const early = this.observeEarly(name, check, want);
    if (early !== undefined) return early;
    const plan = steps(this.vector, this.side, this.vars);
    const names = resultNames(check);
    const absencePoll = this.vector.observe?.[name]?.absencePoll === true;
    const snapshots =
      !this.clients.flight?.abandoned &&
      ((this.side === 'control' && want === true) || (want === false && absencePoll))
        ? [...plan.setup, ...plan.trigger].filter(
            (step) =>
              names.includes(step.as) &&
              !step.refusable &&
              ['Page.getFrameTree', 'Target.getTargets'].includes(step.cdp) &&
              supported(step.requires, this.options.capabilities)
          )
        : [];
    const hasEvent = (node) =>
      Boolean(node?.event) ||
      [...(node?.all ?? []), ...(node?.any ?? []), ...(node?.not ? [node.not] : [])].some(hasEvent);
    const polled =
      check?.observer === 'fixture' || check?.world !== undefined || check?.script !== undefined;
    const shouldPoll =
      (want === true && (polled || snapshots.length > 0)) ||
      (want === false && absencePoll && snapshots.length > 0);
    if (
      want === false &&
      !shouldPoll &&
      (check?.world !== undefined || check?.script !== undefined || hasEvent(check))
    )
      return this.absenceCheck(check);
    if (!shouldPoll) return this.check(check);
    let seen = false;
    const met = await this.poll(
      async () => {
        if (this.clients.flight?.abandoned) return true;
        seen = await this.check(check);
        if (seen === 'unwatched' || seen === 'incomplete') return true;
        if (want === false && seen === true) return true;
        if (seen !== true && snapshots.length) {
          await this.execute(snapshots, undefined, 'observation');
          if (this.clients.flight?.abandoned) return true;
          seen = await this.check(check);
        }
        return seen === true;
      },
      observeMs,
      false,
      snapshots.length > 0
    );
    if (seen === 'unwatched' || seen === 'incomplete') return seen;
    if (want === true && (!met || this.clients.flight?.abandoned) && snapshots.length) {
      this.incomplete.push(
        `${name}: snapshot evidence not observed within ${this.bound(observeMs)}ms`
      );
      return 'incomplete';
    }
    return seen;
  }

  unmeasured(check) {
    const out = check?.result ? this.calls[check.result] : undefined;
    return Boolean(out?.result?.incomplete) && at(out, check.path) === undefined;
  }

  async compoundCheck(c) {
    if (c.all) {
      const parts = await Promise.all(c.all.map((item) => this.check(item)));
      if (parts.includes('unwatched')) return 'unwatched';
      if (parts.includes('incomplete')) return 'incomplete';
      return parts.every(Boolean);
    }
    if (c.any) {
      const parts = await Promise.all(c.any.map((item) => this.check(item)));
      if (parts.includes('unwatched') && !parts.some((part) => part === true)) return 'unwatched';
      if (parts.includes('incomplete') && !parts.some((part) => part === true)) return 'incomplete';
      return parts.some((part) => part === true);
    }
    const inner = await this.check(c.not);
    if (inner === 'unwatched' || inner === 'incomplete') return inner;
    return !inner;
  }

  async check(check) {
    const c = expand(check, this.vars);
    if (!(await this.ready(c))) return false;
    const events = this.client.events.slice(this.eventStart);
    const evidence = await this.evidence(c);
    if (evidence !== undefined) return evidence;
    if (c.live) return (await outcome(this.reader.send('Target.getTargets', {}))).ok;
    if (c.executed)
      return this.trace.some(
        (entry) => entry.phase === c.executed && (entry.out.ok || entry.refused)
      );
    if (c.all || c.any || c.not) return this.compoundCheck(c);
    if (c.event) return events.some((e) => e.method === c.event && matches(e, c.where ?? {}));
    if (c.hops || c.beacon || c.served || c.header) return this.requestCheck(c);
    if (c.title !== undefined || c.expression !== undefined) return this.readCheck(c);
    if (c.delivered)
      return events.some(
        (event) => q(event).includes(c.delivered) || q(event).includes(btoa(c.delivered))
      );
    if (c.compare)
      return (
        c.compare.every((name) => observedValue(this.calls[name], c.path) !== undefined) &&
        observedValue(this.calls[c.compare[0]], c.path) ===
          observedValue(this.calls[c.compare[1]], c.path)
      );
    if (c.result) {
      const value = observedValue(this.calls[c.result], c.path);
      return matches(value, c.equals);
    }
    if (c.cookie)
      return (
        this.calls[c.from]?.result?.cookies?.some(
          (cookie) =>
            cookie.name === c.cookie &&
            (!c.on || cookie.domain.replace(/^\./, '') === new URL(c.on).hostname)
        ) ?? false
      );
    if (c.refused || c.reached) return this.callCheck(c);
    if (c.detached) {
      const events = this.client.events.slice(this.eventStart, this.cleanupEventStart);
      const session = this.sessions[c.detached];
      return (
        Boolean(session) &&
        (events.some(
          (event) =>
            event.method === 'Target.detachedFromTarget' && event.params.sessionId === session
        ) ||
          this.trace.some(
            (entry) =>
              entry.session === session &&
              !entry.out.ok &&
              /refused|session.*closed|target.*closed|no session/i.test(
                String(entry.out.error?.message ?? entry.out.error)
              )
          ))
      );
    }
    if (c.attached) return this.attachedCheck(c);
    throw new Error('Unknown observation check');
  }

  async evidence(c) {
    if (c.filtered) {
      const calls =
        c.filtered.from === 'all'
          ? (this.calls.$cdp ?? [])
          : c.filtered.from.map((name) => this.calls[name]);
      return calls.some(
        (out) =>
          out?.ok &&
          Array.isArray(out.result?.cookies) &&
          !out.result.cookies.some(
            (cookie) =>
              cookie.name === c.filtered.cookie &&
              (!c.filtered.on ||
                cookie.domain.replace(/^\./, '') === new URL(c.filtered.on).hostname)
          )
      );
    }
    if (c.registration)
      return this.trace.some(
        (entry) => entry.phase !== 'trigger' && entry.declared && entry.refused
      );
    if (c.state) return this.readState(c.state);
    if (c.blocked) return this.blocked(c.blocked, c.observer);
    if (c.history) return this.history(c.history);
    if (c.frameBlocked) return this.frameBlocked(c.frameBlocked);
    if (c.pre || c.loaded) return this.attemptCheck(c);
    if (c.world !== undefined || c.script !== undefined) {
      const seen = this.watched(c);
      if (seen === 'unwatched') return 'unwatched';
      return seen;
    }
  }

  callCheck(c) {
    const names = c.refused ?? c.reached;
    const calls =
      names === 'all'
        ? (this.calls.$cdp ?? [])
        : names.flatMap((name) =>
            this.calls[name]?.result && Array.isArray(this.calls[name].result)
              ? this.calls[name].result
              : [this.calls[name]]
          );
    for (const out of calls) observedValue(out, 'ok');
    return (
      calls.length > 0 &&
      calls.every(
        (out) =>
          out &&
          (c.refused
            ? !out.ok &&
              new RegExp(c.refusal?.match ?? 'refused').test(
                String(out.error?.message ?? out.error)
              )
            : out.ok || !/refused/.test(String(out.error?.message ?? out.error)))
      )
    );
  }

  attachedCheck(c) {
    const session = this.sessions[c.session ?? 'page'];
    const events = this.client.events.slice(this.eventStart, this.cleanupEventStart);
    if (
      !session ||
      events.some((e) => e.method === 'Target.detachedFromTarget' && e.params.sessionId === session)
    )
      return false;
    if (c.session === 'child')
      return events.some(
        (event) =>
          event.method === 'Target.attachedToTarget' &&
          event.params.sessionId === session &&
          (event.params.targetInfo.openerId === this.pageTarget ||
            event.params.targetInfo.parentId === this.pageTarget ||
            event.params.targetInfo.url.startsWith(c.attached))
      );
    return events.some(
      (event) =>
        (event.sessionId === session &&
          event.method === 'Page.frameNavigated' &&
          event.params.frame.url.startsWith(c.attached)) ||
        (event.method === 'Target.attachedToTarget' &&
          event.params.sessionId === session &&
          event.params.targetInfo.url.startsWith(c.attached))
    );
  }

  async requestCheck(c, start = this.requestStart) {
    if (c.exit && this.exitRequestStart === undefined) return false;
    const all = await this.options.fixture.log();
    const logs = all.slice(
      c.exit === 'after' ? this.exitRequestStart : start,
      c.exit === 'before' ? this.exitRequestStart : all.length
    );
    if (c.hops)
      return c.hops.every((_, i) =>
        logs.some((entry) => entry?.url === hop(c.hops.slice(i), c.to))
      );
    const mine =
      c.tagged === false
        ? logs.filter((entry) => typeof entry?.url === 'string')
        : owned(logs, this.vars.tag);
    return mine.some((entry) => {
      const url = parseURL(entry.url);
      if (c.beacon)
        return (
          url?.pathname === '/beacon' &&
          url.searchParams.get('tag') === this.vars.tag &&
          url.searchParams.get('origin') === c.beacon
        );
      if (c.origin && url?.origin !== c.origin) return false;
      if (c.served)
        return c.served.startsWith('http') ? entry.url === c.served : url?.pathname === c.served;
      return (
        (c.on.startsWith('http') ? entry.url === c.on : url?.pathname === c.on) &&
        entry.headers?.[c.header.toLowerCase()] === (c.value ?? this.vars.tag)
      );
    });
  }

  async readCheck(c) {
    const targetId = c.session === 'child' ? this.targets.at(-1) : this.pageTarget;
    if (!targetId) return false;
    const { sessionId } = await this.reader.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    try {
      const out = await this.evaluate(c.expression ?? 'document.title', sessionId, this.reader);
      return matches(observedValue(out, 'result.result.value'), c.title ?? c.equals);
    } finally {
      await outcome(this.reader.send('Target.detachFromTarget', { sessionId }));
    }
  }

  async observeAll(unseen) {
    const observed = { ...this.refused };
    const incomplete = [];
    for (const [name, observation] of Object.entries(this.vector.observe ?? {})) {
      if (gatedOut(observation, this.options.capabilities)) {
        observed[name] = 'not-supported';
        continue;
      }
      const dependencies = observation.dependsOn ?? [];
      if (dependencies.some((dep) => this.refused[dep] === 'incomplete')) {
        observed[name] = 'incomplete';
        continue;
      }
      if (dependencies.some((dep) => this.refused[dep] === true)) continue;
      observed[name] = await this.observe(name, observation.check);
      if (observed[name] === 'unwatched') {
        observed[name] = 'incomplete';
        this.incomplete.push(`${name}: absence watch not installed`);
      }
      if (exitsClient(this.vector) && dependencies.length && observed[name] === false) {
        observed[name] = 'incomplete';
        this.incomplete.push(`${name}: pre-exit evidence not observed`);
      }
      if (!observation.eitherWhen || this.side !== 'guarded') continue;
      const holds = await this.either(observation.eitherWhen, observed[name], name, unseen);
      observed[`${name}.either`] = holds;
      if (holds === 'incomplete') incomplete.push(name);
    }
    return { observed, incomplete };
  }

  async either(check, value, name, unseen) {
    const holds = () => this.check(check);
    if (await holds()) return true;
    if (unseen.length) return usesPre(check) ? 'incomplete' : false;
    if (value === this.vector.expected?.[name]) return false;
    return this.poll(holds, 1500);
  }

  async liveness(unseen, incomplete) {
    if (this.side === 'control') return { live: true };
    const alive = () => this.check(this.vector.liveCheck);
    let live = await alive();
    if (!live && this.unmeasured(this.vector.liveCheck))
      return { live: 'incomplete', liveWhy: 'incomplete' };
    if (!live && !unseen.length) live = await this.poll(alive, 1500);
    if (!unseen.length || (live && !incomplete.length))
      return live
        ? { live }
        : { live, liveWhy: this.calls[this.vector.liveCheck.result]?.result?.liveWhy };
    const detail = incomplete.length ? ` (${incomplete.join(', ')} incomplete)` : '';
    return { live: false, liveWhy: `pre beacon not observed for ${unseen.join(', ')}${detail}` };
  }

  async run() {
    this.requestStart = (await this.options.fixture.log()).length;
    let pumping;
    try {
      await this.seed();
      pumping = this.pump();
      const plan = steps(this.vector, this.side, {
        ...this.vars,
        context: '{context}',
        log: this.vars.log,
        tag: this.vars.tag,
      });
      await this.execute(plan.setup, undefined, 'setup');
      await this.execute(plan.trigger, undefined, 'trigger');
      await sleep(100);
      const unseen = await this.awaitPre();
      const { observed, incomplete } = await this.observeAll(unseen);
      this.options.debug?.({
        events: this.client.events.slice(this.eventStart),
        calls: this.calls,
        requests: await this.options.fixture.log(),
        side: this.side,
      });
      const { live, liveWhy } = await this.liveness(unseen, incomplete);
      return {
        observed,
        live,
        liveWhy,
        errors: this.errors,
        notes: this.notes,
        incomplete: this.incomplete,
        unsupported: this.unsupported,
        calls: this.namedCallSummaries(),
        evidence: Object.fromEntries(
          Object.entries(this.calls)
            .filter(
              ([, out]) => (out?.result?.delay && out.result.probes) || out?.result?.diagnostics
            )
            .map(([name, out]) => [name, out.result.diagnostics ?? out.result])
        ),
      };
    } finally {
      this.stopped = true;
      await pumping;
      await this.cleanupLeg();
    }
  }

  async cleanupLeg() {
    if (this.watch)
      await outcome(
        this.reader.send('Target.detachFromTarget', { sessionId: this.watch.sessionId })
      );
    await Promise.allSettled(this.pending);
    if (this.spawnWorkerKind()) await this.cleanupSpawnedWorkerLeg();
    else await this.cleanupTargets();
    for (const browserContextId of new Set(this.contexts))
      await outcome(
        (this.reader ?? this.client).send('Target.disposeBrowserContext', { browserContextId })
      );
    this.contexts = [];
    if (
      this.side === 'guarded' &&
      this.vector.observe?.eventsRedacted?.requires?.includes('discovery')
    ) {
      const violation = discoveryViolation(
        this.client.events.slice(this.eventStart),
        supported(['discovery'], this.options.capabilities)
      );
      if (violation) this.errors.push(violation);
    }
  }

  async cleanupSpawnedWorkerLeg() {
    await this.resumeWaiting();
    await releasePersistentWorkerSessions({
      client: this.client,
      reader: this.reader,
      events: this.client.events,
      from: this.eventStart,
      tag: this.vars.tag,
      targets: this.targets,
      attachSessions: [...this.attachSettings.keys()],
    });
    if (this.reader && this.reader !== this.client)
      await releasePersistentWorkerSessions({
        client: this.reader,
        reader: this.reader,
        events: this.reader.events,
        from: 0,
        tag: this.vars.tag,
        targets: this.targets,
        attachSessions: [],
      });
    this.targets = [];
    this.attachSettings.clear();
  }

  async cleanupTargets() {
    for (const session of this.attachSettings.keys())
      await outcome(
        this.client.send(
          'Target.setAutoAttach',
          { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
          session
        )
      );
    await this.resumeWaiting();
    const listed = await outcome((this.reader ?? this.client).send('Target.getTargets', {}));
    const byId = new Map((listed.result?.targetInfos ?? []).map((info) => [info.targetId, info]));
    for (const targetId of new Set(this.targets)) {
      if (byId.get(targetId)?.type === 'iframe') continue;
      await outcome((this.reader ?? this.client).send('Target.closeTarget', { targetId }));
    }
    for (const info of listed.result?.targetInfos ?? []) {
      if (
        (info.type === 'shared_worker' || info.type === 'service_worker') &&
        typeof info.url === 'string' &&
        info.url.includes(this.vars.tag)
      )
        await outcome(
          (this.reader ?? this.client).send('Target.closeTarget', { targetId: info.targetId })
        );
    }
  }
}

const usesPre = (value) =>
  Boolean(value && typeof value === 'object') &&
  (Object.hasOwn(value, 'pre') ||
    Object.hasOwn(value, 'history') ||
    Object.values(value).some(usesPre));

const observerRequired = (check) => {
  if (check?.observer === 'unguarded') return true;
  if (check?.all) return check.all.some(observerRequired);
  if (check?.any) return check.any.every(observerRequired);
  return check?.not ? observerRequired(check.not) : false;
};
const needsObserver = (vector) =>
  vector.control.via === 'unguarded' ||
  allSteps([...(vector.setup ?? []), ...(vector.trigger ?? [])]).some(
    (step) => step.isolatedWorld || step.observer || step.spawnWorker
  ) ||
  observerRequired(vector.liveCheck) ||
  Object.values(vector.observe ?? {}).some(
    (observation) => observerRequired(observation.check) || observerRequired(observation.eitherWhen)
  );

const inactive = (vector, target, capabilities) =>
  inapplicable(vector, target, capabilities.scope) || !supported(vector.requires, capabilities);

const allSteps = (list) => list.flatMap((step) => [step, ...allSteps(step.children ?? [])]);
const exitsClient = (vector) =>
  [...(vector.setup ?? []), ...(vector.trigger ?? [])].some((step) => step.client === 'exit');
const skipRow = (base, reason) => ({
  ...base,
  control: 'skip',
  guarded: 'skip',
  live: 'skip',
  reason,
});
const browserContextStep = (vector, capabilities) =>
  allSteps([...vector.setup, ...vector.trigger]).some(
    (step) =>
      step.params?.browserContextId !== undefined ||
      (step.session === 'page-or-browser' &&
        /^Storage\.(getCookies|setCookies|clearCookies)$/.test(step.cdp ?? '') &&
        supported(['browserContexts'], capabilities))
  );

function nullOrigins(value, targets) {
  return [...q(value).matchAll(/\{([A-Za-z][A-Za-z-]*)\}/g)]
    .map((match) => (match[1] === 'beacon' || match[1] === 'probe' ? 'log' : match[1]))
    .map((name) => (targets[name] === undefined ? (originDefaults[name] ?? name) : name))
    .filter((name) => knownOrigins.includes(name) && (targets[name] ?? null) === null);
}

function prune(check, targets) {
  if (!check || typeof check !== 'object') return { check };
  if (check.any) {
    const parts = check.any.map((item) => prune(item, targets));
    const kept = parts.filter((part) => !part.missing).map((part) => part.check);
    return kept.length ? { check: { ...check, any: kept } } : { missing: parts[0]?.missing };
  }
  if (check.all || check.not) {
    const parts = (check.all ?? [check.not]).map((item) => prune(item, targets));
    const missing = parts.find((part) => part.missing)?.missing;
    if (missing) return { missing };
    return {
      check: check.all
        ? { ...check, all: parts.map((part) => part.check) }
        : { ...check, not: parts[0].check },
    };
  }
  const missing = nullOrigins(check, targets)[0];
  return missing ? { missing } : { check };
}

function available(vector, target, targets = {}) {
  const fixed = nullOrigins(
    [target, '{plain}', vector.control.origin, vector.setup, vector.trigger].map((value) =>
      typeof value === 'string' && !value.startsWith('{') ? `{${value}}` : value
    ),
    targets
  )[0];
  if (fixed) return { missing: fixed };
  const live = prune(vector.liveCheck, targets);
  if (live.missing) return { missing: live.missing };
  const observe = {};
  for (const [name, observation] of Object.entries(vector.observe ?? {})) {
    const pruned = prune(observation.check, targets);
    if (pruned.missing) return { missing: pruned.missing };
    const either = observation.eitherWhen ? prune(observation.eitherWhen, targets) : undefined;
    observe[name] = {
      ...observation,
      check: pruned.check,
      ...(observation.eitherWhen ? { eitherWhen: either.missing ? undefined : either.check } : {}),
    };
  }
  return {
    vector: {
      ...vector,
      ...(vector.liveCheck ? { liveCheck: live.check } : {}),
      ...(vector.observe ? { observe } : {}),
    },
  };
}

function variables(targets, target, side, slot, index) {
  const tag = `guard-${Date.now()}-${slot}-${index}-${side}-${Math.random().toString(36).slice(2)}`;
  const vars = {
    ...targets,
    plain: targets.plain ?? targets.ordinary,
    cross: targets.cross ?? targets.client,
    log: targets.log ?? targets.ordinary,
    tag,
    cookie: `canary-${tag}`,
  };
  vars.protectedTarget = targets[target];
  vars.target = side === 'control' ? vars.plain : targets[target];
  vars.targetHost = new URL(vars.target).hostname;
  vars.responseOrigin = vars.target === vars.ordinary ? '*' : vars.ordinary;
  vars.own ??= vars.client;
  vars.beacon = beacon(vars.log, tag);
  return vars;
}

function tracked(client, calls, name) {
  if (!client || typeof client.send !== 'function') return client;
  let next = 0;
  const send = (method, params, sessionId) => {
    const id = ++next;
    calls.set(id, { name, method, session: sessionId, since: Date.now() });
    return Promise.resolve()
      .then(() => client.send(method, params, sessionId))
      .finally(() => calls.delete(id));
  };
  return new Proxy(client, {
    get(base, key) {
      if (key === 'send') return send;
      const value = Reflect.get(base, key);
      return typeof value === 'function' ? value.bind(base) : value;
    },
  });
}

function view(flight, base, clients) {
  const now = Date.now();
  const pending = (name) =>
    [...flight.calls.values()]
      .filter((call) => call.name === name)
      .map(({ method, session, since }) => ({ method, session, ageMs: now - since }));
  return {
    id: base.id,
    target: base.target,
    variant: base.variant,
    leg: flight.leg,
    phase: flight.phase,
    step: flight.step,
    clients: {
      client: pending('client'),
      ...(clients.unguarded && clients.unguarded !== clients.client
        ? { unguarded: pending('unguarded') }
        : {}),
    },
  };
}

async function watch(work, ms, snapshot) {
  if (!ms) {
    await work;
    return undefined;
  }
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(snapshot()), ms);
  });
  const stuck = await Promise.race([work.then(() => undefined), expired]);
  clearTimeout(timer);
  return stuck;
}

async function timedOut(stuck, base, made, work, opts) {
  const close = made.close;
  made.close = undefined;
  await close?.call(made);
  work.catch(() => {});
  const failed = {
    ...base,
    control: 'fail',
    guarded: 'fail',
    live: 'fail',
    why: `row timed out after ${opts.rowTimeoutMs}ms`,
    errors: [`row timed out after ${opts.rowTimeoutMs}ms: ${JSON.stringify(stuck)}`],
    inFlight: stuck,
  };
  opts.log?.(failed);
  return failed;
}

function probeEvidence(legs) {
  return [legs.control.evidence, legs.guarded.evidence].some(
    (evidence) => Object.keys(evidence ?? {}).length
  )
    ? { evidence: { control: legs.control.evidence, guarded: legs.guarded.evidence } }
    : {};
}

async function executeRow(job, opts, made, set, slot, index, flights) {
  const { target, variant } = job;
  const calls = new Map();
  const client = tracked(made.client, calls, 'client');
  const unguarded =
    made.unguarded === made.client ? client : tracked(made.unguarded, calls, 'unguarded');
  const flight = { calls, leg: undefined, phase: undefined, step: undefined };
  const clients = { ...made, client, unguarded, flight };
  const scoped = available(job.vector, target, opts.targets);
  const vector = scoped.vector ?? job.vector;
  const base = {
    id: vector.id,
    target,
    variant,
    transport: clients.client?.transport ?? 'cdp',
    via: vector.control.via,
    transportVariant: clients.transportVariant === true,
  };
  const unavailable = scoped.missing;
  if (unavailable)
    return {
      ...base,
      control: 'skip',
      guarded: 'skip',
      live: 'skip',
      reason: `not-applicable:no-${unavailable}-origin`,
    };
  if (vector.kind === 'text')
    return {
      ...base,
      control: 'not-run',
      guarded: 'not-run',
      live: 'not-run',
      appliesTo: vector.appliesTo ?? [],
    };
  if (inactive(vector, target, opts.capabilities)) {
    const missing = (vector.requires ?? []).find((cap) => !supported([cap], opts.capabilities));
    return {
      ...base,
      control: 'skip',
      guarded: 'skip',
      live: 'skip',
      reason: missing
        ? `not-supported:${missing}`
        : skipReason(vector, target, opts.capabilities.scope),
    };
  }
  if (
    !supported(['browserSession'], opts.capabilities) &&
    browserContextStep(vector, opts.capabilities)
  )
    return {
      ...base,
      control: 'skip',
      guarded: 'skip',
      live: 'skip',
      reason: 'not-supported:browserSession',
    };
  const observerReason = observerSkip(vector, opts, made, clients);
  if (observerReason) return skipRow(base, observerReason);
  const legs = {};
  const renewed = [];
  flights.add({ flight, base, clients });
  opts.onStart?.(base);
  const sides = runLegs({ vector, opts, clients, set, job, slot, index, legs, renewed });
  const stuck = await watch(sides, opts.rowTimeoutMs, () => view(flight, base, clients));
  for (const entry of flights) if (entry.flight === flight) flights.delete(entry);
  await closeAll(renewed);
  if (stuck) {
    flight.abandoned = true;
    return timedOut(stuck, base, made, sides, opts);
  }
  if (legs.control.unsupported === 'trustedEmulation')
    return skipRow(base, 'not-supported:trustedEmulation');
  const row = finishRow(vector, base, legs, opts);
  opts.log?.(row);
  return row;
}

function finishRow(vector, base, legs, opts) {
  const caps = Array.isArray(opts.capabilities)
    ? opts.capabilities
    : Object.keys(opts.capabilities).filter((k) => opts.capabilities[k] === true);
  const calls = {
    ...(legs.control.calls && Object.keys(legs.control.calls).length
      ? { control: legs.control.calls }
      : {}),
    ...(legs.guarded.calls && Object.keys(legs.guarded.calls).length
      ? { guarded: legs.guarded.calls }
      : {}),
  };
  const row = {
    ...result(vector, {
      ...base,
      capabilities: caps,
      control: legs.control.observed,
      guarded: legs.guarded.observed,
      live: legs.control.live && legs.guarded.live,
      liveWhy: legs.guarded.liveWhy,
    }),
    transportVariant: base.transportVariant,
    observations: { control: legs.control.observed, guarded: legs.guarded.observed },
    errors: [...legs.control.errors, ...legs.guarded.errors],
    designDependent: vector.designDependent ?? [],
    ...(Object.keys(calls).length ? { calls } : {}),
    ...probeEvidence(legs),
  };
  const notes = [
    ...(legs.control.notes ?? []).map((note) => `control ${note}`),
    ...(legs.guarded.notes ?? []).map((note) => `guarded ${note}`),
  ];
  if (notes.length) row.notes = notes;
  settleIncomplete(row, vector, base, legs);
  if (row.errors.length) {
    row.control = 'fail';
    row.guarded = 'fail';
  }
  return row;
}

function observerSkip(vector, opts, made, clients) {
  if (
    vector.requires?.includes('inboundDelay') &&
    typeof clients.client.inboundDelay !== 'function'
  )
    return 'not-supported:inboundDelay';
  if (needsObserver(vector) && !clients.unguarded) return 'not-supported:unguarded-observer';
  if (!exitsClient(vector)) return undefined;
  if (!opts.clientFactory) return 'not-supported:clientExit';
  if (!made.unguarded || made.unguarded === made.client) return 'not-supported:unguarded-observer';
  return undefined;
}

async function runLegs({ vector, opts, clients, set, job, slot, index, legs, renewed }) {
  for (const side of ['control', 'guarded']) {
    if (clients.exited) {
      const missing = await renew(job, opts, set, slot, clients, renewed);
      if (missing) {
        legs[side] = unmeasured(vector, missing);
        continue;
      }
    }
    const vars = variables(opts.targets, job.target, side, slot, index);
    const execution = new Execution(vector, side, opts, clients, vars, set.variants[job.variant]);
    try {
      legs[side] = await execution.run();
    } catch (error) {
      legs[side] = {
        observed: {},
        live: false,
        errors: [...execution.errors, String(error.message ?? error)],
        notes: execution.notes,
      };
    }
  }
}

async function closeAll(closers) {
  for (const close of closers) await close?.();
}

async function renew(job, opts, set, slot, clients, renewed) {
  clients.exited = false;
  const factory = await factoryClients(opts, set, { ...job, leg: 'guarded' }, slot);
  if (!factory.ok) return `clientFactory: ${factory.error.message}`;
  const fresh = normalize(factory.result, opts);
  renewed.push(fresh.close);
  if (!fresh.unguarded || fresh.unguarded === fresh.client)
    return 'client exit: the fresh client has no independent unguarded observer';
  clients.client = tracked(fresh.client, clients.flight.calls, 'client');
  clients.unguarded = tracked(fresh.unguarded, clients.flight.calls, 'unguarded');
  return undefined;
}

function unmeasured(vector, reason) {
  return {
    observed: Object.fromEntries(Object.keys(vector.expected).map((name) => [name, 'incomplete'])),
    live: 'incomplete',
    errors: [],
    notes: [],
    incomplete: [reason],
  };
}

function settleIncomplete(row, vector, base, legs) {
  const incomplete = ['control', 'guarded'].flatMap((side) =>
    (legs[side].incomplete ?? []).map((reason) => `${side} ${reason}`)
  );
  if (!incomplete.length) return;
  row.incomplete = incomplete;
  if (row.errors.length) return;
  const fill = (side) => {
    const want = side === 'control' ? vector.control.expected : vector.expected;
    return Object.fromEntries(
      Object.entries(legs[side].observed).map(([name, value]) => [
        name,
        value === 'incomplete' && Object.hasOwn(want, name)
          ? want[name] === 'either' || want[name]
          : value,
      ])
    );
  };
  const filled = result(vector, {
    ...base,
    control: fill('control'),
    guarded: fill('guarded'),
    live: legs.control.live === true && [true, 'incomplete'].includes(legs.guarded.live),
    liveWhy: legs.guarded.liveWhy,
  });
  for (const side of ['control', 'guarded'])
    if (legs[side].incomplete?.length && filled[side] === 'pass') row[side] = 'incomplete';
  if (legs.guarded.live === 'incomplete' && filled.live === 'pass') row.live = 'incomplete';
  row.why = [filled.why, `incomplete: ${incomplete.join('; ')}`].filter(Boolean).join('; ');
}

const invalidBlocked = (check) =>
  Boolean(
    check?.blocked &&
      ((check.blocked.url === undefined) === (check.blocked.anyOf === undefined) ||
        (check.blocked.anyOf !== undefined &&
          (!Array.isArray(check.blocked.anyOf) || check.blocked.anyOf.length === 0)))
  ) ||
  [...(check?.all ?? []), ...(check?.any ?? []), ...(check?.not ? [check.not] : [])].some(
    invalidBlocked
  );

function validateBlocked(vectors) {
  for (const vector of vectors)
    if (
      [
        vector.liveCheck,
        ...Object.values(vector.observe ?? {}).flatMap((o) => [o.check, o.eitherWhen]),
      ].some(invalidBlocked)
    )
      throw new TypeError(`${vector.id}: blocked needs exactly one url or nonempty anyOf`);
}

function validateScales(opts) {
  if (
    opts.settleScale !== undefined &&
    !(Number.isFinite(opts.settleScale) && opts.settleScale > 0)
  )
    throw new TypeError('settleScale must be a positive number');
  if (
    opts.refusalScale !== undefined &&
    !(Number.isFinite(opts.refusalScale) && opts.refusalScale >= 1)
  )
    throw new TypeError('refusalScale must be a number of at least 1');
}

function validate(set, opts) {
  if (!opts.fixture?.log) throw new TypeError('fixture.log is required');
  validateScales(opts);
  for (const vector of set.vectors)
    for (const [name, observation] of Object.entries(vector.observe ?? {}))
      if (!observation.check) throw new TypeError(`${vector.id}: ${name} lacks a check`);
  for (const vector of set.vectors)
    if (vector.kind === 'cdp' && !vector.liveCheck)
      throw new TypeError(`${vector.id}: lacks liveCheck`);
  const invalidLive = (check) =>
    Boolean(check?.live || check?.executed || check?.on === 'control') ||
    [...(check?.all ?? []), ...(check?.any ?? []), ...(check?.not ? [check.not] : [])].some(
      invalidLive
    );
  for (const vector of set.vectors)
    if (vector.kind === 'cdp' && invalidLive(vector.liveCheck))
      throw new TypeError(`${vector.id}: liveCheck needs guarded attempt evidence`);
  validateBlocked(set.vectors);
  const variants = Array.isArray(opts.variant) ? opts.variant : [opts.variant];
  for (const name of variants)
    if (!(name in set.variants)) throw new TypeError(`Unknown variant: ${name}`);
  if (!Number.isInteger(opts.parallel) || opts.parallel < 1)
    throw new TypeError('parallel must be a positive integer');
  return variants;
}

function factoryClients(opts, set, job, slot) {
  return outcome(
    (async () =>
      opts.clientFactory
        ? opts.clientFactory({
            slot,
            variant: job.variant,
            detachDelay: set.variants[job.variant],
            vector: job.vector,
            target: job.target,
            ...(job.leg ? { leg: job.leg } : {}),
          })
        : opts.client)()
  );
}

function normalize(made, opts) {
  const clients =
    typeof made?.send === 'function'
      ? {
          client: made,
          unguarded: opts.unguarded ?? made.unguarded,
          transportVariant: made.transportVariant,
        }
      : (made ?? { client: undefined, unguarded: opts.unguarded });
  clients.unguarded ??= opts.unguarded;
  return clients;
}

function unmade(job, message) {
  const reason = `clientFactory: ${message}`;
  return {
    id: job.vector.id,
    target: job.target,
    variant: job.variant,
    via: job.vector.control.via,
    transportVariant: false,
    control: 'incomplete',
    guarded: 'incomplete',
    live: 'incomplete',
    why: `incomplete: ${reason}`,
    errors: [],
    incomplete: [reason],
  };
}

export function run(set, options) {
  const flights = new Set();
  const inFlight = () =>
    [...flights].map(({ flight, base, clients }) => view(flight, base, clients));
  const running = runAll(set, options, flights).then((done) => ({ ...done, inFlight }));
  running.inFlight = inFlight;
  return running;
}

async function runAll(set, options, flights) {
  const opts = { capabilities: {}, variant: Object.keys(set.variants), parallel: 1, ...options };
  opts.fixture = prepareFixture(set, opts);
  opts.targets = {
    ...Object.fromEntries(
      Object.entries(set.targets ?? {})
        .filter(([, target]) => typeof target?.url === 'string')
        .map(([name, target]) => [name, target.url])
    ),
    ...opts.targets,
  };
  const variants = validate(set, opts);
  const jobs = set.vectors.flatMap((vector) =>
    vector.targets.flatMap((target) => variants.map((variant) => ({ vector, target, variant })))
  );
  const results = new Array(jobs.length);
  let next = 0;
  let serial = Promise.resolve();
  let transport = 'cdp';
  const unmadeRows = [];
  const worker = async (slot) => {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) break;
      const job = jobs[index];
      const factory = await factoryClients(opts, set, job, slot);
      if (!factory.ok) {
        results[index] = unmade(job, factory.error.message);
        unmadeRows.push(results[index]);
        continue;
      }
      const made = factory.result;
      transport = (typeof made?.send === 'function' ? made : made?.client)?.transport ?? transport;
      const clients = normalize(made, opts);
      try {
        const stateful = [...job.vector.setup, ...job.vector.trigger].some((s) =>
          /Cookie|Storage|IndexedDB|CacheStorage/.test(s.cdp ?? '')
        );
        if (stateful && !supported(['browserContexts'], opts.capabilities)) {
          const previous = serial;
          let done;
          serial = new Promise((resolve) => {
            done = resolve;
          });
          await previous;
          try {
            results[index] = await executeRow(job, opts, clients, set, slot, index, flights);
          } finally {
            done();
          }
        } else results[index] = await executeRow(job, opts, clients, set, slot, index, flights);
      } finally {
        await clients.close?.();
      }
    }
  };
  const width = opts.clientFactory ? opts.parallel : 1;
  await Promise.all(Array.from({ length: width }, (_, slot) => worker(slot)));
  for (const row of unmadeRows) {
    row.transport = transport;
    opts.log?.(row);
  }
  return {
    results,
    summary: (metadata = {}) =>
      summary({ set, results, ...metadata, capabilities: opts.capabilities }),
  };
}

export function summary({ set, results, guard = 'reference', sha = 'unknown', capabilities }) {
  const value = report({
    set: {
      ...set,
      variants: Object.fromEntries(
        [...new Set(results.map((r) => r.variant))].map((v) => [v, set.variants[v]])
      ),
    },
    results,
    guard,
    sha,
    capabilities,
  });
  const observerSkipped = results.filter(
    (row) => row.reason === 'not-supported:unguarded-observer'
  ).length;
  const skips = {};
  for (const row of results)
    if (row.control === 'skip')
      skips[row.reason ?? 'unknown'] = (skips[row.reason ?? 'unknown'] ?? 0) + 1;
  const skipped = Object.values(skips).reduce((sum, count) => sum + count, 0);
  const incomplete = results.filter((row) =>
    [row.control, row.guarded, row.live].includes('incomplete')
  ).length;
  const line = observerSkipped ? value.line.replace('GUARD-PASS', 'GUARD-FAIL') : value.line;
  const skipLine = skipped
    ? `${line} skips ${skipped} (${Object.entries(skips)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ')})`
    : line;
  return {
    ...value,
    pass: value.pass && observerSkipped === 0,
    line: incomplete ? `${skipLine} incomplete ${incomplete}` : skipLine,
    skips,
    observerSkipped,
    incomplete,
    counts: Object.fromEntries(
      ['control', 'guarded', 'live'].map((side) => [
        side,
        Object.fromEntries(
          ['pass', 'fail', 'incomplete', 'skip', 'not-run'].map((status) => [
            status,
            results.filter((r) => r[side] === status).length,
          ])
        ),
      ])
    ),
  };
}
