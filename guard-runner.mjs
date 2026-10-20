import { extensionWorld } from './extension-world.mjs';
import {
  beacon,
  canary,
  expand,
  hop,
  isRefusal,
  loadedAfter,
  outcome,
  owned,
  parseURL,
  summary as report,
  result,
  steps,
} from './guard-driver.mjs';
import { protectedErrorPage } from './protected-error-page.mjs';
import { canonicalURL, unparseableURLs } from './unparseable-url.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const namedResultMs = 10000;
const observeMs = 5000;
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
const stateCheck = (check) =>
  check?.state ||
  [...(check?.all ?? []), ...(check?.any ?? []), ...(check?.not ? [check.not] : [])]
    .map(stateCheck)
    .find(Boolean);

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
    this.preSent = [];
    this.notes = [];
    this.answers = [];
    this.internalSessions = new Set();
    this.attachSettings = new Map();
    this.childSteps = [];
    this.deferred = [];
    this.expectWhere = [...(vector.setup ?? []), ...(vector.trigger ?? [])].some(
      (step) => step.children && step.where
    );
    this.scale = options.settleScale ?? 1;
    this.refusalScale = options.refusalScale ?? 1;
    this.childRuns = new Map();
    this.named = new Map();
    this.processed = new Set();
    this.eventStart = this.client.events.length;
    this.actionEventStart = this.eventStart;
    this.requestStart = undefined;
    this.trace = [];
    this.stopped = false;
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
    const { targetId } = await client.send('Target.createTarget', {
      url: 'about:blank',
      background,
      ...(context ? { browserContextId: context } : {}),
    });
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

  async poll(predicate, ms = 1500, absent = false) {
    const deadline = Date.now() + this.bound(ms, absent);
    do {
      if (await predicate()) return true;
      await sleep(25);
    } while (Date.now() < deadline);
    return false;
  }

  async prepareState(spec) {
    if (!spec || !this.reader) return;
    const state = expand(spec, this.vars);
    await this.reader.send('Storage.setCookies', {
      cookies: [{ name: state.cookie, value: state.value, url: state.origin }],
      ...(this.vars.context ? { browserContextId: this.vars.context } : {}),
    });
    if (!state.storage) return;
    const { targetId } = await this.reader.send('Target.createTarget', {
      url: 'about:blank',
      ...(this.vars.context ? { browserContextId: this.vars.context } : {}),
    });
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

  async blocked(spec, observer) {
    const urls = (spec.anyOf ?? [spec.url]).map(address);
    const events = this.client.events.slice(this.eventStart);
    if (observer === 'client') {
      const requests = new Map(
        events
          .filter((event) => event.method === 'Network.requestWillBeSent')
          .map((event) => [event.params.requestId, event.params.request.url])
      );
      return events.some(
        (event) =>
          (event.method === 'Page.frameNavigated' &&
            (!spec.frame ||
              event.params.frame.parentId ||
              event.sessionId === this.sessions.child) &&
            urls.includes(event.params.frame.unreachableUrl) &&
            event.params.frame.url.startsWith('chrome-error://')) ||
          (event.method === 'Network.loadingFailed' &&
            urls.includes(requests.get(event.params.requestId)) &&
            (event.params.blockedReason || event.params.errorText === 'net::ERR_BLOCKED_BY_CLIENT'))
      );
    }
    const targetId = spec.session === 'child' ? this.targets.at(-1) : this.pageTarget;
    if (!targetId) return false;
    const attached = await outcome(
      this.reader.send('Target.attachToTarget', { targetId, flatten: true })
    );
    if (!attached.ok) return false;
    try {
      const read = await outcome(
        this.reader.send('Page.getFrameTree', {}, attached.result.sessionId)
      );
      const visit = (tree) =>
        Boolean(
          tree &&
            ((urls.includes(tree.frame.unreachableUrl) &&
              tree.frame.url.startsWith('chrome-error://')) ||
              (tree.childFrames ?? []).some(visit))
        );
      if (
        read.ok &&
        (spec.frame
          ? (read.result.frameTree.childFrames ?? []).some(visit)
          : visit(read.result.frameTree))
      )
        return true;
      return spec.frame ? Boolean(await this.blockedFrameTarget(urls, targetId)) : false;
    } finally {
      await outcome(
        this.reader.send('Target.detachFromTarget', { sessionId: attached.result.sessionId })
      );
    }
  }

  async frameIds(targetId) {
    const attached = await outcome(
      this.reader.send('Target.attachToTarget', { targetId, flatten: true })
    );
    if (!attached.ok) return [];
    try {
      const read = await outcome(
        this.reader.send('Page.getFrameTree', {}, attached.result.sessionId)
      );
      const ids = (tree) => [tree.frame.id, ...(tree.childFrames ?? []).flatMap(ids)];
      return read.ok ? ids(read.result.frameTree) : [];
    } finally {
      await outcome(
        this.reader.send('Target.detachFromTarget', { sessionId: attached.result.sessionId })
      );
    }
  }

  async blockedFrameTarget(urls, parentTarget) {
    const parents = await this.frameIds(parentTarget);
    const listed = await outcome(this.reader.send('Target.getTargets', {}));
    if (!listed.ok) return undefined;
    for (const info of listed.result.targetInfos) {
      if (info.type !== 'iframe' || !parents.includes(info.parentFrameId)) continue;
      const attached = await outcome(
        this.reader.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
      );
      if (!attached.ok) continue;
      try {
        const read = await outcome(
          this.reader.send('Page.getFrameTree', {}, attached.result.sessionId)
        );
        const frame = read.result?.frameTree?.frame;
        if (frame?.url.startsWith('chrome-error://') && urls.includes(frame.unreachableUrl))
          return info.targetId;
      } finally {
        await outcome(
          this.reader.send('Target.detachFromTarget', { sessionId: attached.result.sessionId })
        );
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

  adopt(event) {
    const info = event.params.targetInfo;
    const child = event.params.sessionId;
    if (info?.type === 'browser_ui') return;
    if (this.expectWhere && !this.childWhere) {
      this.deferred.push(event);
      return;
    }
    if (info?.browserContextId && this.vars.context && info.browserContextId !== this.vars.context)
      return;
    if (this.childWhere && !this.childMatches(info)) {
      if (event.params.waitingForDebugger)
        this.pending.push(outcome(this.client.send('Runtime.runIfWaitingForDebugger', {}, child)));
      return;
    }
    this.sessions.child = child;
    if (info?.targetId) this.targets.push(info.targetId);
    const started = (async () => {
      const reload = this.childSteps.findIndex((step) => step.cdp === 'Page.reload');
      if (reload < 0) await this.execute(this.childSteps, child);
      else {
        await this.execute(this.childSteps.slice(0, reload), child);
        const start = this.client.events.length;
        if (event.params.waitingForDebugger)
          await outcome(this.client.send('Runtime.runIfWaitingForDebugger', {}, child));
        await this.poll(
          () =>
            this.client.events
              .slice(start)
              .some((e) => e.method === 'Page.loadEventFired' && e.sessionId === child),
          1500
        );
        await this.execute(this.childSteps.slice(reload), child);
      }
      const resumed = this.client.events.length;
      if (event.params.waitingForDebugger)
        await outcome(this.client.send('Runtime.runIfWaitingForDebugger', {}, child));
      if (this.childSteps.some((step) => step.cdp === 'Page.enable'))
        await this.poll(() => this.firstLoad(child, resumed), 5000);
    })().catch((error) => this.errors.push(String(error.message ?? error)));
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
    if (this.childWhere.openerId === 'page') return info?.openerId === this.pageTarget;
    return String(info?.url ?? '').startsWith(this.childWhere.urlPrefix);
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
    const refused =
      !gone &&
      (step.refusable
        ? isRefusal(out, step)
        : /refused/.test(String(out.error?.message ?? out.error)));
    this.trace.push({
      phase,
      declared: Boolean(step.refusable),
      session,
      out,
      refused,
      ...(gone ? { detached: true } : {}),
    });
    if (step.refusable) this.refused[step.refusal.name] = refused;
    if (step.refusable && !out.ok && !refused && !gone)
      this.errors.push(
        `${step.refusal.name} failed without a refusal: ${String(out.error?.message ?? out.error)}`
      );
    if ((step.extensionWorld || step.unparseable || step.errorPage) && !out.ok)
      this.errors.push(
        `${step.unparseable ? 'unparseable' : step.errorPage ? 'errorPage' : 'extensionWorld'}: ${out.error?.message ?? 'probe failed'}`
      );
    if (step.as && !out.result?.pending) this.calls[step.as] = out;
    if (step.cdp) (this.calls.$cdp ??= []).push({ method: step.cdp, ...out });
  }

  async execute(list, childSession, phase = 'child') {
    if (phase === 'trigger') await this.childrenSettled();
    for (const [index, raw] of list.entries()) {
      if (this.clients.flight)
        Object.assign(this.clients.flight, { leg: this.side, phase, step: index });
      const step = expand(raw, this.vars);
      if (!supported(step.requires, this.options.capabilities) || step.text) continue;
      if (!childSession && step.session === 'child') await this.childrenSettled();
      const session = childSession ?? this.session(step.session);
      const out = await this.operation(step, session, phase);
      if (!out) continue;
      this.record(
        step,
        out,
        session,
        phase,
        Boolean(childSession) && !out.ok && this.detached(childSession)
      );
      this.options.debug?.({ step, out, side: this.side });
    }
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
    if (step.errorPage)
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
          browserSession: supported(['browserSession'], this.options.capabilities),
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
          extensionId: this.options.extensionWorldId,
        })
      );
    if (step.guess) return this.guess(step.guess, session);
    if (step.cdp) return this.cdp(step, session);
    if (step.page) return this.page(step, session, phase);
    throw new Error('Unknown step kind');
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
      const events = this.client.events.slice(this.actionEventStart);
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
    if (settle.required && !met)
      this.errors.push(
        `settle: no ${settle.beacon ? `beacon from ${settle.beacon}` : settle.served ? `request for ${settle.served}` : settle.title ? `title ${settle.title}` : 'load'} within ${this.bound(settle.ms ?? 1500)}ms`
      );
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

  async cdp(step, sessionId) {
    if (step.cdp === 'Target.detachFromTarget') await sleep(this.delay);
    if (step.cdp === 'Target.setAutoAttach' && step.params?.autoAttach === false)
      this.cleanupEventStart = this.client.events.length;
    const params = { ...step.params };
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
    const out = await outcome(this.client.send(step.cdp, params, session));
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
    return out;
  }

  async seedContext(context) {
    await this.reader.send('Storage.setCookies', {
      cookies: [{ name: this.vars.cookie, value: this.vars.tag, url: this.vars.target }],
      browserContextId: context,
    });
  }

  async page(step, session, phase) {
    this.actionEventStart = this.client.events.length;
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
        this.client,
        step.background ?? true
      );
      this.sessions.page = tab.sessionId;
      this.pageTarget = tab.targetId;
      return { ok: true, result: tab };
    }
    if (pre && step.page !== 'framed') this.preSent.push(url);
    if (step.page === 'navigate') {
      if (pre) await this.evaluate(pre, session);
      return this.navigate(this.client, session, url);
    }
    if (step.page === 'framed') {
      if (phase === 'trigger') this.preSent.push(url);
      return this.navigate(
        this.client,
        session,
        `${step.from}/framed?tag=${encodeURIComponent(this.vars.tag)}&url=${encodeURIComponent(url)}&log=${encodeURIComponent(this.vars.log)}`
      );
    }
    let expression = pageExpression(step, url);
    if (pre) expression = `(() => { ${pre} return (${expression}); })()`;
    const promise = this.evaluate(expression, session);
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

  async observe(name, check) {
    const want = (this.side === 'control' ? this.vector.control.expected : this.vector.expected)?.[
      name
    ];
    if (want !== true || check?.observer !== 'fixture') return this.check(check);
    let seen = false;
    await this.poll(async () => {
      seen = await this.check(check);
      return seen === true;
    }, observeMs);
    return seen;
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
    if (c.all) return (await Promise.all(c.all.map((item) => this.check(item)))).every(Boolean);
    if (c.any) return (await Promise.all(c.any.map((item) => this.check(item)))).some(Boolean);
    if (c.not) return !(await this.check(c.not));
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
    const logs = (await this.options.fixture.log()).slice(start);
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
      if (!supported(observation.requires, this.options.capabilities)) {
        observed[name] = 'not-supported';
        continue;
      }
      if ((observation.dependsOn ?? []).some((dep) => this.refused[dep])) continue;
      observed[name] = await this.observe(name, observation.check);
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
    if (!live && !unseen.length) live = await this.poll(alive, 1500);
    if (!unseen.length || (live && !incomplete.length)) return { live };
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
      return { observed, live, liveWhy, errors: this.errors, notes: this.notes };
    } finally {
      this.stopped = true;
      await pumping;
      for (const session of this.attachSettings.keys())
        await outcome(
          this.client.send(
            'Target.setAutoAttach',
            { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
            session
          )
        );
      for (const targetId of new Set(this.targets))
        await outcome((this.reader ?? this.client).send('Target.closeTarget', { targetId }));
      for (const browserContextId of new Set(this.contexts))
        await outcome(
          (this.reader ?? this.client).send('Target.disposeBrowserContext', { browserContextId })
        );
      await Promise.allSettled(this.pending);
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
  observerRequired(vector.liveCheck) ||
  Object.values(vector.observe ?? {}).some(
    (observation) => observerRequired(observation.check) || observerRequired(observation.eitherWhen)
  );

const inactive = (vector, target, capabilities) =>
  vector.skip?.target === target ||
  vector.observable?.[target] === false ||
  !supported(vector.requires, capabilities) ||
  (vector.scope !== 'any' && vector.scope !== capabilities.scope);

const allSteps = (list) => list.flatMap((step) => [step, ...allSteps(step.children ?? [])]);
const browserContextStep = (vector, capabilities) =>
  allSteps([...vector.setup, ...vector.trigger]).some(
    (step) =>
      step.params?.browserContextId !== undefined ||
      (step.session === 'page-or-browser' &&
        /^Storage\.(getCookies|setCookies|clearCookies)$/.test(step.cdp ?? '') &&
        supported(['browserContexts'], capabilities))
  );

const originDefaults = { plain: 'ordinary', cross: 'client', log: 'ordinary', own: 'client' };
const knownOrigins = [
  'ordinary',
  'ordinary-same-site',
  'seven',
  'vault',
  'vault-x',
  'apex',
  'own',
  'client',
  'plain',
  'cross',
  'log',
];

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
      reason: missing ? `not-supported:${missing}` : 'not-applicable',
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
  if (needsObserver(vector) && !clients.unguarded)
    return {
      ...base,
      control: 'skip',
      guarded: 'skip',
      live: 'skip',
      reason: 'not-supported:unguarded-observer',
    };
  const legs = {};
  flights.add({ flight, base, clients });
  opts.onStart?.(base);
  const sides = (async () => {
    for (const side of ['control', 'guarded']) {
      try {
        const vars = variables(opts.targets, target, side, slot, index);
        legs[side] = await new Execution(
          vector,
          side,
          opts,
          clients,
          vars,
          set.variants[variant]
        ).run();
      } catch (error) {
        legs[side] = { observed: {}, live: false, errors: [String(error.message ?? error)] };
      }
    }
  })();
  const stuck = await watch(sides, opts.rowTimeoutMs, () => view(flight, base, clients));
  for (const entry of flights) if (entry.flight === flight) flights.delete(entry);
  if (stuck) {
    flight.abandoned = true;
    return timedOut(stuck, base, made, sides, opts);
  }
  const row = {
    ...result(vector, {
      ...base,
      capabilities: Array.isArray(opts.capabilities)
        ? opts.capabilities
        : Object.keys(opts.capabilities).filter((k) => opts.capabilities[k] === true),
      control: legs.control.observed,
      guarded: legs.guarded.observed,
      live: legs.control.live && legs.guarded.live,
      liveWhy: legs.guarded.liveWhy,
    }),
    transportVariant: base.transportVariant,
    observations: { control: legs.control.observed, guarded: legs.guarded.observed },
    errors: [...legs.control.errors, ...legs.guarded.errors],
    designDependent: vector.designDependent ?? [],
  };
  const notes = [
    ...(legs.control.notes ?? []).map((note) => `control ${note}`),
    ...(legs.guarded.notes ?? []).map((note) => `guarded ${note}`),
  ];
  if (notes.length) row.notes = notes;
  if (row.errors.length) {
    row.control = 'fail';
    row.guarded = 'fail';
  }
  opts.log?.(row);
  return row;
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
  const worker = async (slot) => {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) break;
      const job = jobs[index];
      const made = opts.clientFactory
        ? await opts.clientFactory({
            slot,
            variant: job.variant,
            detachDelay: set.variants[job.variant],
            vector: job.vector,
            target: job.target,
          })
        : opts.client;
      const clients =
        typeof made?.send === 'function'
          ? {
              client: made,
              unguarded: opts.unguarded ?? made.unguarded,
              transportVariant: made.transportVariant,
            }
          : (made ?? { client: undefined, unguarded: opts.unguarded });
      clients.unguarded ??= opts.unguarded;
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
  return { results, summary: (metadata = {}) => summary({ set, results, ...metadata }) };
}

export function summary({ set, results, guard = 'reference', sha = 'unknown' }) {
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
  });
  const observerSkipped = results.filter(
    (row) => row.reason === 'not-supported:unguarded-observer'
  ).length;
  const skips = {};
  for (const row of results)
    if (row.control === 'skip')
      skips[row.reason ?? 'unknown'] = (skips[row.reason ?? 'unknown'] ?? 0) + 1;
  const skipped = Object.values(skips).reduce((sum, count) => sum + count, 0);
  const line = observerSkipped ? value.line.replace('GUARD-PASS', 'GUARD-FAIL') : value.line;
  return {
    ...value,
    pass: value.pass && observerSkipped === 0,
    line: skipped
      ? `${line} skips ${skipped} (${Object.entries(skips)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([reason, count]) => `${reason}=${count}`)
          .join(', ')})`
      : line,
    skips,
    observerSkipped,
    counts: Object.fromEntries(
      ['control', 'guarded', 'live'].map((side) => [
        side,
        Object.fromEntries(
          ['pass', 'fail', 'skip', 'not-run'].map((status) => [
            status,
            results.filter((r) => r[side] === status).length,
          ])
        ),
      ])
    ),
  };
}
