import { outcome, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';
import { containsSecret } from './redirect-secret.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refusal = (out) =>
  !out.ok &&
  /^(slicc: refused:)|session.*(closed|not found)|no session|target.*closed/i.test(
    out.error?.message ?? ''
  );
const value = (out) =>
  out.ok && !out.result?.exceptionDetails ? out.result?.result?.value : undefined;
const png = (data) => {
  try {
    return typeof data === 'string' && atob(data).startsWith('\x89PNG\r\n\x1a\n');
  } catch {
    return false;
  }
};
const methods = [
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'DOM.getDocument',
  'Accessibility.getFullAXTree',
  'Input.dispatchKeyEvent',
  'Page.captureScreenshot',
  'IO.read',
];

async function bounded(work, ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: { message: 'no answer' } }), ms);
  });
  const out = await Promise.race([outcome(work), expired]);
  clearTimeout(timer);
  return out;
}

class Restore {
  constructor(options) {
    Object.assign(this, options);
    this.marker = `bfcache-marker-${this.tag}-p`;
    this.url = `${this.protectedOrigin}/bfcache?n=${encodeURIComponent(`${this.tag}-p`)}`;
    this.result = { probes: [], delay: { requestedMs: this.delayMs } };
    this.missing = [];
    this.pending = [];
    this.probeId = 0;
  }

  missingEvidence(reason) {
    this.missing.push(reason);
    return false;
  }

  read(method, params, session = method.startsWith('Target.') ? undefined : this.observer) {
    return bounded(this.reader.send(method, params, session), this.budget);
  }

  call(method, params) {
    return bounded(this.client.send(method, params, this.session), this.budget);
  }

  async frame() {
    return (await this.read('Page.getFrameTree', {})).result?.frameTree?.frame;
  }

  async state() {
    return value(
      await this.read('Runtime.evaluate', {
        expression:
          '({origin:location.origin,marker:globalThis.__bfcacheMarker,stored:sessionStorage.getItem("bfcache-marker"),persisted:globalThis.__bfcachePersisted,touched:globalThis.__touched,keys:globalThis.__bfcacheKeys||0})',
        returnByValue: true,
      })
    );
  }

  loaded(destination) {
    return waitFor(async () => {
      const f = await this.frame();
      return (
        f?.url === destination &&
        !f.unreachableUrl &&
        value(
          await this.read('Runtime.evaluate', {
            expression: 'document.readyState',
            returnByValue: true,
          })
        ) === 'complete'
      );
    }, this.budget);
  }

  async attach() {
    this.session = (
      await bounded(
        this.client.send('Target.attachToTarget', { targetId: this.targetId, flatten: true }),
        this.budget
      )
    ).result?.sessionId;
    return Boolean(this.session);
  }

  async seed() {
    this.observer = (
      await this.read('Target.attachToTarget', { targetId: this.targetId, flatten: true })
    ).result?.sessionId;
    if (!this.observer) return this.missingEvidence('observer attach unanswered');
    await this.read('Page.enable', {});
    if (!(await this.loaded(`${this.ordinary}/bfcache?n=${this.tag}-a`)))
      return this.missingEvidence('ordinary A did not commit');
    await this.read('Page.navigate', { url: this.url });
    if (!(await this.loaded(this.url)))
      return this.missingEvidence('protected seed did not commit');
    const state = await this.state();
    if (state?.marker !== this.marker || state.stored !== this.marker)
      return this.missingEvidence('protected fixture marker absent');
    this.result.seed = { protectedURL: this.url };
    const b = `${this.ordinary}/bfcache?n=${this.tag}-b`;
    await this.read('Page.navigate', { url: b });
    if (!(await this.loaded(b))) return this.missingEvidence('ordinary B did not commit');
    if (!(await this.attach())) return this.missingEvidence('initial client attach unanswered');
    const live = await this.call('Page.getFrameTree', {});
    const frame = live.result?.frameTree?.frame;
    this.result.seed.ordinaryAnswer = live;
    if (!(live.ok && frame?.url === b && !frame.unreachableUrl))
      return this.missingEvidence('ordinary B acknowledgement unavailable');
    this.result.sessionLive = true;
    await this.call('Page.enable', {});
    const history = await this.read('Page.getNavigationHistory', {});
    this.entry = history.result?.entries?.find((item) => item.url === this.url);
    return Boolean(this.entry) || this.missingEvidence('protected history entry absent');
  }

  async install() {
    const { targetId, session, delayMs: ms, side, client } = this;
    const installed = await outcome(
      this.delayClient.inboundDelay({ targetId, sessionId: session, ms, side, client, gate: true })
    );
    this.delay = installed.result;
    this.gate = this.delay;
    const delay = this.delay;
    this.result.delay.seeding = {
      protectedObserved: delay?.protectedObserved,
      ordinaryObserved: delay?.ordinaryObserved,
    };
    this.result.delay.acknowledged =
      installed.ok &&
      delay?.ms === ms &&
      delay.targetId === targetId &&
      delay.sessionId === session &&
      delay.protectedObserved === true &&
      delay.ordinaryObserved === true &&
      delay.gate === true;
    return (
      (this.result.delay.acknowledged && typeof delay.release === 'function') ||
      this.missingEvidence('inbound delay not acknowledged')
    );
  }

  async trigger() {
    const method = 'Page.navigateToHistoryEntry';
    const params = { entryId: this.entry.id };
    if (this.mode !== 'history') {
      this.result.triggerPath = 'observer';
      this.result.trigger = await this.read(method, params);
      return;
    }
    const command = { id: 'history-trigger', method, params, sentAt: Date.now() };
    const work = this.client.send(method, params, this.session);
    void outcome(work).then((reply) => {
      this.result.triggerReply = reply;
      if (reply.ok && this.result.triggerPath === 'observer-after-audited-timeout') {
        this.result.triggerPath = 'client-late-answer';
        this.missingEvidence('history navigation answered after non-forwarding audit');
      }
    });
    const out = await bounded(work, this.budget);
    this.result.trigger = out;
    const timedOut = out.error?.message === 'no answer';
    this.result.triggerPath = timedOut ? 'client-timeout' : 'client';
    let refused = refusal(out);
    if (timedOut && this.forwardAudit) {
      const audit = await bounded(
        typeof this.gate.audit === 'function'
          ? Promise.resolve().then(() =>
              this.gate.audit({ historyTrigger: command, probes: [], final: false })
            )
          : Promise.reject(new Error('forwarding audit unavailable')),
        this.budget
      );
      this.result.triggerAudit = audit;
      const decision = audit.result?.historyTrigger;
      refused =
        audit.ok &&
        decision?.complete === true &&
        decision.id === command.id &&
        decision.forwarded === false &&
        !(await bounded(work, 0)).ok;
    }
    if (refused) {
      this.result.triggerPath = timedOut
        ? 'observer-after-audited-timeout'
        : 'observer-after-refusal';
      this.result.fallback = await this.read(method, params);
    }
  }

  async probe(method, params, current) {
    const sentAt = Date.now();
    const record = { id: ++this.probeId, params, method, sentAt, protectedCurrent: current };
    this.result.probes.push(record);
    const work = this.client.send(method, params, this.session);
    const out = await bounded(work, Math.min(this.budget, 250));
    this.answer(record, out);
    record.windowOutcome = record.outcome;
    this.pending.push(
      outcome(work).then((answer) => {
        this.answer(record, answer);
        record.answeredAt = Date.now();
      })
    );
    return out;
  }

  answer(record, out) {
    record.outcome = refusal(out)
      ? 'refused'
      : out.error?.message === 'no answer'
        ? 'no answer'
        : 'answered';
    record.reply = out;
  }

  async round() {
    const f = await this.frame();
    const current = f?.url === this.url && !f.unreachableUrl;
    const restored = this.reader.events
      .slice(this.eventStart)
      .some(
        (event) =>
          event.sessionId === this.observer &&
          event.method === 'Page.frameNavigated' &&
          event.params?.type === 'BackForwardCacheRestore' &&
          event.params.frame?.url === this.url
      );
    if (restored && this.result.restoreAt === undefined) this.result.restoreAt = Date.now();
    const expression =
      'globalThis.__touched=1; JSON.stringify({origin:location.origin,marker:globalThis.__bfcacheMarker,stored:sessionStorage.getItem("bfcache-marker")})';
    const calls = [
      this.probe('Runtime.evaluate', { expression, returnByValue: true }, current),
      this.probe('DOM.getDocument', { depth: -1, pierce: true }, current),
      this.probe('Accessibility.getFullAXTree', {}, current),
      this.probe('Page.captureScreenshot', { format: 'png' }, current),
      this.probe('IO.read', { handle: this.stream ?? 'unavailable-stream' }, current),
      this.probe(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 },
        current
      ),
    ];
    calls.push(
      this.probe(
        'Runtime.callFunctionOn',
        {
          executionContextId: this.contextId,
          functionDeclaration:
            'function(){this.__touched=1;return JSON.stringify({origin:location.origin,marker:this.__bfcacheMarker})}',
          returnByValue: true,
        },
        current
      )
    );
    await Promise.all(calls);
  }

  async window() {
    this.eventStart = this.reader.events.length;
    this.clientStart = this.client.events.length;
    this.messageStart = this.client.messages?.length ?? 0;
    this.result.delay.startedAt = Date.now();
    const trigger = this.trigger();
    if (this.mode === 'history') await trigger;
    const restored = await waitFor(async () => {
      const f = await this.frame();
      return f?.url === this.url && !f.unreachableUrl && (await this.state())?.persisted === true;
    }, this.budget);
    if (!restored) this.missingEvidence('protected restore before probes not observed');
    const f = await this.frame();
    const contextStart = this.reader.events.length;
    await this.read('Runtime.enable', {});
    this.contextId = this.reader.events
      .slice(contextStart)
      .find(
        (event) =>
          event.sessionId === this.observer &&
          event.method === 'Runtime.executionContextCreated' &&
          event.params?.context?.auxData?.isDefault &&
          event.params.context.auxData.frameId === f?.id
      )?.params.context.id;
    this.result.screenshotProof = {
      capturedAt: Date.now(),
      url: f?.url,
      reply: await this.read('Page.captureScreenshot', { format: 'png' }),
    };
    const resource = await this.read('Network.loadNetworkResource', {
      frameId: f?.id,
      url: this.url,
      options: { disableCache: true, includeCredentials: false },
    });
    this.stream = resource.result?.resource?.stream;
    this.result.probeStartedAt = Date.now();
    do {
      await this.round();
      await pause(25);
    } while (Date.now() - this.result.probeStartedAt < this.windowMs);
    this.result.beforeRelease = await this.state();
    await this.audit();
    const released = await outcome(this.delay.release());
    this.result.delay.release = released;
    this.delay = undefined;
    await trigger;
    await this.settleProbes();
    if (
      !released.ok ||
      !(released.result?.delayedEvents > 0) ||
      !(released.result.firstDelayedAt >= this.result.delay.startedAt) ||
      !(released.result.releasedAt >= released.result.firstDelayedAt + this.delayMs)
    )
      this.missingEvidence('held restore events not proven');
  }

  async settleProbes() {
    await waitFor(
      () => this.result.probes.every((probe) => probe.answeredAt !== undefined),
      this.budget
    );
    await this.audit(true);
    if (
      this.result.probes.some(
        (probe) =>
          probe.answeredAt === undefined && !(this.finalAuditComplete && probe.forwarded === false)
      )
    )
      this.missingEvidence('probe replies or terminal non-forwarding evidence unavailable');
  }

  async audit(final = false) {
    if (!this.forwardAudit) {
      this.result.commandsUnforwarded = 'not-supported';
      this.notes.push('commandsUnforwarded: not-supported:forwardAudit');
      return;
    }
    const audit = await outcome(
      typeof this.gate.audit === 'function'
        ? this.gate.audit({ probes: this.result.probes, final })
        : Promise.reject(new Error('forwarding audit unavailable'))
    );
    this.result.delay[final ? 'finalAudit' : 'audit'] = audit;
    const entries = Array.isArray(audit.result?.probes) ? audit.result.probes : [];
    const complete =
      audit.ok &&
      audit.result?.complete === true &&
      entries.length === this.result.probes.length &&
      new Set(entries.map((entry) => entry.id)).size === entries.length &&
      this.result.probes.every((probe) =>
        entries.some((entry) => entry.id === probe.id && typeof entry.forwarded === 'boolean')
      );
    for (const probe of this.result.probes) {
      const matches = entries.filter((entry) => entry.id === probe.id);
      probe.forwarded = matches.some((entry) => entry.forwarded === true)
        ? true
        : matches.find((entry) => entry.forwarded === false)?.forwarded;
    }
    const forwarded =
      this.result.commandsUnforwarded === false ||
      this.result.probes.some((probe) => probe.forwarded);
    this.result.commandsUnforwarded = forwarded ? false : complete ? true : 'incomplete';
    if (final) this.finalAuditComplete = complete;
    if (final && !complete) this.missingEvidence('forwarding audit unavailable');
  }

  async judge() {
    const state = await this.state();
    const { result, marker, protectedOrigin } = this;
    result.sideEffect = state;
    result.restoredObserved =
      result.restoreAt !== undefined &&
      state?.origin === protectedOrigin &&
      state.marker === marker &&
      state.stored === marker &&
      state.persisted === true;
    if (!result.restoredObserved) {
      result.restoredObserved = 'incomplete';
      this.missingEvidence('real protected BFCache restore not observed');
    }
    const delivered = [
      ...result.probes.map((item) => item.reply),
      ...this.client.events
        .slice(this.clientStart)
        .filter((event) => event.sessionId === this.session),
      ...(this.client.messages?.slice(this.messageStart) ?? []),
    ];
    result.markerHidden = !containsSecret(delivered, marker);
    result.originHidden = !containsSecret(
      result.probes.map((item) => item.reply),
      protectedOrigin
    );
    result.sideEffectAbsent = this.effects([result.beforeRelease, state]);
    if (result.sideEffectAbsent === 'incomplete')
      this.missingEvidence('side-effect read unavailable');
    const protectedProbes = result.probes.filter((item) => item.protectedCurrent);
    result.probesRefusedOrUnforwarded =
      result.probes.length > 0 &&
      result.probes.every((item) => ['refused', 'no answer'].includes(item.outcome));
    result.probeRanInProtected = protectedProbes.some(
      (item) =>
        item.method === 'Runtime.evaluate' &&
        String(value(item.reply)).includes(marker) &&
        String(value(item.reply)).includes(protectedOrigin)
    );
    result.touched = state?.touched === 1;
    result.methodsProven = methods.every((method) =>
      protectedProbes.some((item) => item.method === method && this.proven(item, state))
    );
    if (this.side === 'control') this.control();
  }

  proven(probe, state) {
    if (!probe.reply.ok || probe.reply.result?.exceptionDetails) return false;
    if (probe.method === 'Input.dispatchKeyEvent') return state?.keys > 0;
    if (probe.method === 'IO.read')
      return (
        this.stream &&
        probe.params.handle === this.stream &&
        containsSecret(probe.reply.result?.data, this.marker)
      );
    if (probe.method === 'Page.captureScreenshot') {
      const proof = this.result.screenshotProof;
      const data = probe.reply.result?.data;
      return (
        proof?.url === this.url && proof.reply.ok && png(data) && data === proof.reply.result?.data
      );
    }
    return containsSecret(probe.reply, this.marker);
  }

  effects(states) {
    const measured = (state) =>
      state?.origin === this.protectedOrigin &&
      state.marker === this.marker &&
      Number.isInteger(state.keys);
    if (
      states.some(
        (state) =>
          state?.origin === this.protectedOrigin &&
          state.marker === this.marker &&
          (state.touched === 1 || state.keys > 0)
      )
    )
      return false;
    return states.every(measured) ? true : 'incomplete';
  }

  control() {
    if (!this.result.methodsProven) {
      this.result.methodsProven = 'incomplete';
      this.missingEvidence('positive probe methods not observed');
    }
    if (!this.result.probeRanInProtected || !this.result.touched) {
      if (!this.result.probeRanInProtected) this.result.probeRanInProtected = 'incomplete';
      if (!this.result.touched) this.result.touched = 'incomplete';
      this.missingEvidence('positive protected probes not observed');
    }
  }

  async run() {
    const opened = await outcome(
      createObserverTarget(
        this.reader,
        { url: `${this.ordinary}/bfcache?n=${this.tag}-a`, background: true },
        this.notes
      )
    );
    if (!opened.ok) {
      this.missingEvidence(opened.error.message);
    } else {
      this.targetId = opened.result.targetId;
      try {
        if ((await this.seed()) && (await this.install())) {
          await this.window();
          await this.judge();
        }
      } finally {
        if (this.delay?.release) this.result.delay.release = await outcome(this.delay.release());
        if (this.session)
          await bounded(
            this.client.send('Target.detachFromTarget', { sessionId: this.session }),
            this.budget
          );
        if (this.stream) await this.read('IO.close', { handle: this.stream });
        if (this.observer) await this.read('Target.detachFromTarget', { sessionId: this.observer });
        await this.read('Target.closeTarget', { targetId: this.targetId }, undefined);
      }
    }
    return this.missing.length
      ? { ...this.result, incomplete: `bfcache-restore: ${this.missing.join('; ')}` }
      : this.result;
  }
}

export function bfcacheRestore({
  client,
  reader,
  ordinary,
  protectedOrigin,
  tag,
  mode,
  side,
  delayClient = client,
  notes = [],
  budget = 5000,
  forwardAudit = true,
  delayMs = 1500,
  windowMs = delayMs + 1000,
}) {
  return new Restore({
    client,
    reader,
    ordinary,
    protectedOrigin,
    tag,
    mode,
    side,
    delayClient,
    notes,
    budget,
    forwardAudit,
    delayMs,
    windowMs,
  }).run();
}
