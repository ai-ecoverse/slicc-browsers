import {
  beacon,
  expand,
  hop,
  isRefusal,
  outcome,
  summary as report,
  result,
  steps,
} from './guard-driver.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    this.answers = [];
    this.attachSettings = new Map();
    this.childSteps = [];
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
    if (url !== 'about:blank') await this.navigate(client, sessionId, url);
    return { targetId, sessionId };
  }

  async navigate(client, session, url) {
    const start = client.events.length;
    const out = await outcome(client.send('Page.navigate', { url }, session));
    if (out.ok && !out.result.errorText)
      await this.poll(
        () =>
          client.events
            .slice(start)
            .some((event) => event.method === 'Page.loadEventFired' && event.sessionId === session),
        3000
      );
    return out;
  }

  async poll(predicate, ms = 1500) {
    const deadline = Date.now() + ms;
    do {
      if (await predicate()) return true;
      await sleep(25);
    } while (Date.now() < deadline);
    return false;
  }

  async seed() {
    if (supported(['browserContexts'], this.options.capabilities)) {
      const { browserContextId } = await (this.reader ?? this.client).send(
        'Target.createBrowserContext',
        {}
      );
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
  }

  async pump() {
    while (!this.stopped) {
      for (const event of this.client.events.slice(this.eventStart)) {
        if (this.processed.has(event)) continue;
        this.processed.add(event);
        if (event.method === 'Fetch.requestPaused' || event.method === 'Fetch.authRequired') {
          this.pending.push(
            this.answer(event).catch((error) => this.errors.push(String(error.message ?? error)))
          );
        }
        if (
          event.method === 'Target.attachedToTarget' &&
          event.params.targetInfo?.targetId !== this.pageTarget &&
          event.params.sessionId !== this.sessions.page
        ) {
          const info = event.params.targetInfo;
          if (
            info?.browserContextId &&
            this.vars.context &&
            info.browserContextId !== this.vars.context
          )
            continue;
          this.sessions.child = event.params.sessionId;
          if (info?.targetId) this.targets.push(info.targetId);
          this.pending.push(
            (async () => {
              await this.execute(this.childSteps, event.params.sessionId);
              await outcome(
                this.client.send('Runtime.runIfWaitingForDebugger', {}, event.params.sessionId)
              );
            })().catch((error) => this.errors.push(String(error.message ?? error)))
          );
        }
      }
      await sleep(10);
    }
  }

  async answer(event) {
    const p = event.params;
    const rule = this.answers.find(
      (a) =>
        a.url === p.request.url &&
        (!a.stage || (a.stage === 'Response') === Boolean(p.responseStatusCode)) &&
        (a.cdp === 'Fetch.continueWithAuth') === (event.method === 'Fetch.authRequired')
    );
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

  async execute(list, childSession, phase = 'child') {
    for (const raw of list) {
      const step = expand(raw, this.vars);
      if (!supported(step.requires, this.options.capabilities) || step.text) continue;
      const session = childSession ?? this.session(step.session);
      const out = await this.operation(step, session);
      if (!out) continue;
      this.trace.push({
        phase,
        session,
        out,
        refused: step.refusable
          ? isRefusal(out, step)
          : /refused/.test(String(out.error?.message ?? out.error)),
      });
      if (step.refusable) this.refused[step.refusal.name] = isRefusal(out, step);
      if (step.as && !out.result?.pending) this.calls[step.as] = out;
      if (step.cdp) (this.calls.$cdp ??= []).push({ method: step.cdp, ...out });
      this.options.debug?.({ step, out, side: this.side });
    }
  }

  async operation(step, session) {
    if (step.children) {
      this.childSteps = step.children;
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
    if (step.settle) {
      await this.settle(step.settle);
      return;
    }
    if (step.guess) return this.guess(step.guess, session);
    if (step.cdp) return this.cdp(step, session);
    if (step.page) return this.page(step, session);
    throw new Error('Unknown step kind');
  }

  async settle(settle) {
    if (settle.variant) await sleep(this.delay);
    if (settle.title && !this.reader) {
      await sleep(settle.ms ?? 1500);
      return;
    }
    await this.poll(async () => {
      if (settle.beacon) return this.check({ beacon: settle.beacon });
      if (settle.title) return this.check({ title: settle.title, session: settle.session });
      return this.client.events
        .slice(this.actionEventStart)
        .some((event) => event.method === 'Page.loadEventFired');
    }, settle.ms ?? 1500);
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
    if (
      /^Storage\.(getCookies|setCookies|clearCookies)$/.test(step.cdp) &&
      this.vars.context &&
      !params.browserContextId
    )
      params.browserContextId = this.vars.context;
    const session =
      step.session === 'page-or-browser' &&
      supported(['browserSession'], this.options.capabilities) &&
      /^Storage\.(getCookies|setCookies|clearCookies)$/.test(step.cdp)
        ? undefined
        : sessionId;
    const out = await outcome(this.client.send(step.cdp, params, session));
    if (step.cdp === 'Target.setAutoAttach' && out.ok) {
      if (params.autoAttach) this.attachSettings.set(session, true);
      else this.attachSettings.delete(session);
    }
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

  async page(step, session) {
    this.actionEventStart = this.client.events.length;
    const url = step.hops ? hop(step.hops, step.url) : step.url;
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
    if (step.page === 'navigate') return this.navigate(this.client, session, url);
    if (step.page === 'framed')
      return this.navigate(
        this.client,
        session,
        `${step.from}/framed?tag=${encodeURIComponent(this.vars.tag)}&url=${encodeURIComponent(url)}`
      );
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
        expression = `window.open(${q(url)}); 'opened'`;
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
    const promise = this.evaluate(expression, session);
    if (step.background) {
      this.pending.push(
        promise.then((out) => {
          if (typeof step.as === 'string') this.calls[step.as] = out;
        })
      );
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

  async check(check) {
    const c = expand(check, this.vars);
    const events = this.client.events.slice(this.eventStart);
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
        c.compare.every((name) => at(this.calls[name], c.path) !== undefined) &&
        at(this.calls[c.compare[0]], c.path) === at(this.calls[c.compare[1]], c.path)
      );
    if (c.result) {
      const value = at(this.calls[c.result], c.path);
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
    return (
      calls.length > 0 &&
      calls.every(
        (out) =>
          out &&
          (c.refused
            ? !out.ok && /refused/.test(String(out.error?.message ?? out.error))
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

  async requestCheck(c) {
    const logs = (await this.options.fixture.log()).slice(this.requestStart);
    if (c.hops)
      return c.hops.every((_, i) => logs.some((entry) => entry.url === hop(c.hops.slice(i), c.to)));
    return logs.some((entry) => {
      const url = new URL(entry.url);
      if (c.beacon)
        return (
          url.pathname === '/beacon' &&
          url.searchParams.get('tag') === this.vars.tag &&
          url.searchParams.get('origin') === c.beacon
        );
      if (c.tagged !== false && !entry.url.includes(this.vars.tag)) return false;
      if (c.origin && url.origin !== c.origin) return false;
      if (c.served)
        return c.served.startsWith('http') ? entry.url === c.served : url.pathname === c.served;
      return (
        (c.on.startsWith('http') ? entry.url === c.on : url.pathname === c.on) &&
        entry.headers[c.header.toLowerCase()] === (c.value ?? this.vars.tag)
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
      return out.ok && matches(out.result?.result?.value, c.title ?? c.equals);
    } finally {
      await outcome(this.reader.send('Target.detachFromTarget', { sessionId }));
    }
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
      const observed = { ...this.refused };
      for (const [name, observation] of Object.entries(this.vector.observe ?? {})) {
        if (!supported(observation.requires, this.options.capabilities)) continue;
        if ((observation.dependsOn ?? []).some((dep) => this.refused[dep])) continue;
        observed[name] = await this.check(observation.check);
      }
      this.options.debug?.({
        events: this.client.events.slice(this.eventStart),
        calls: this.calls,
        requests: await this.options.fixture.log(),
        side: this.side,
      });
      const live = await this.check(this.vector.liveCheck);
      return { observed, live, errors: this.errors };
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

const observerRequired = (check) =>
  check?.observer === 'unguarded' ||
  [...(check?.all ?? []), ...(check?.any ?? []), ...(check?.not ? [check.not] : [])].some(
    observerRequired
  );
const needsObserver = (vector) =>
  vector.control.via === 'unguarded' ||
  observerRequired(vector.liveCheck) ||
  Object.values(vector.observe ?? {}).some((observation) => observerRequired(observation.check));

const inactive = (vector, target, capabilities) =>
  vector.skip?.target === target ||
  vector.observable?.[target] === false ||
  !supported(vector.requires, capabilities) ||
  (vector.scope !== 'any' && vector.scope !== capabilities.scope);

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

async function executeRow(job, opts, clients, set, slot, index) {
  const { vector, target, variant } = job;
  const base = {
    id: vector.id,
    target,
    variant,
    transport: clients.client?.transport ?? 'cdp',
    via: vector.control.via,
    transportVariant: clients.transportVariant === true,
  };
  if (vector.kind === 'text')
    return {
      ...base,
      control: 'not-run',
      guarded: 'not-run',
      live: 'not-run',
      appliesTo: vector.appliesTo ?? [],
    };
  if (inactive(vector, target, opts.capabilities))
    return { ...base, control: 'skip', guarded: 'skip', live: 'skip', reason: 'not-applicable' };
  if (needsObserver(vector) && !clients.unguarded)
    return {
      ...base,
      control: 'skip',
      guarded: 'skip',
      live: 'skip',
      reason: 'not-supported:unguarded-observer',
    };
  const legs = {};
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
  const row = {
    ...result(vector, {
      ...base,
      capabilities: Array.isArray(opts.capabilities)
        ? opts.capabilities
        : Object.keys(opts.capabilities).filter((k) => opts.capabilities[k] === true),
      control: legs.control.observed,
      guarded: legs.guarded.observed,
      live: legs.control.live && legs.guarded.live,
    }),
    transportVariant: base.transportVariant,
    observations: { control: legs.control.observed, guarded: legs.guarded.observed },
    errors: [...legs.control.errors, ...legs.guarded.errors],
    designDependent: vector.designDependent ?? [],
  };
  if (row.errors.length) {
    row.control = 'fail';
    row.guarded = 'fail';
  }
  opts.log?.(row);
  return row;
}

function validate(set, opts) {
  if (!opts.fixture?.log) throw new TypeError('fixture.log is required');
  for (const vector of set.vectors)
    for (const [name, observation] of Object.entries(vector.observe ?? {}))
      if (!observation.check) throw new TypeError(`${vector.id}: ${name} lacks a check`);
  for (const vector of set.vectors)
    if (vector.kind === 'cdp' && !vector.liveCheck)
      throw new TypeError(`${vector.id}: lacks liveCheck`);
  const variants = Array.isArray(opts.variant) ? opts.variant : [opts.variant];
  for (const name of variants)
    if (!(name in set.variants)) throw new TypeError(`Unknown variant: ${name}`);
  if (!Number.isInteger(opts.parallel) || opts.parallel < 1)
    throw new TypeError('parallel must be a positive integer');
  return variants;
}

export async function run(set, options) {
  const opts = { capabilities: {}, variant: Object.keys(set.variants), parallel: 1, ...options };
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
            results[index] = await executeRow(job, opts, clients, set, slot, index);
          } finally {
            done();
          }
        } else results[index] = await executeRow(job, opts, clients, set, slot, index);
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
  return {
    ...value,
    pass: value.pass && observerSkipped === 0,
    line: observerSkipped ? value.line.replace('GUARD-PASS', 'GUARD-FAIL') : value.line,
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
