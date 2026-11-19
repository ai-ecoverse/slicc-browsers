import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { summary as driverSummary, judge } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { SIGN_IN_HOLD_BODY, SIGN_IN_HOLD_MARK, signInHold } from '../../sign-in-hold.mjs';
import { emulatedGuard } from './guard-emulator.mjs';
import { drivable, capabilities as sweepCaps } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const attackIds = [
  'C7.sign-in-hold.held-popup',
  'C7.sign-in-hold.callback',
  'C7.sign-in-hold.callback-encoded',
  'C7.sign-in-hold.callback-origin',
];
const positiveIds = ['C7.sign-in-hold.ordinary-popup', 'C7.sign-in-hold.ordinary-authorize'];
const ids = [...attackIds, ...positiveIds];
const vectors = set.vectors.filter((v) => ids.includes(v.id));
const attackVectors = vectors.filter((v) => attackIds.includes(v.id));
const positiveVectors = vectors.filter((v) => positiveIds.includes(v.id));

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

function signInFake({ holdAnswer = 'held', markReadyMs = 0, markNever = false } = {}) {
  const tabs = new Map();
  const sessions = new Map();
  const connections = [];
  let next = 0;
  const infoOf = (tab) => ({
    targetId: tab.targetId,
    type: tab.type,
    url: tab.url,
    title: tab.title ?? tab.url,
    browserContextId: 'B1',
    ...(tab.openerId ? { openerId: tab.openerId } : {}),
  });
  const emit = (conn, method, params, sessionId) => {
    conn.events.push({ method, params, ...(sessionId ? { sessionId } : {}) });
  };
  const discover = (method, tab) => {
    for (const conn of connections)
      if (conn.discover) emit(conn, method, { targetInfo: infoOf(tab) });
  };
  const markReady = (tab) => {
    if (!tab) return false;
    if (tab.markNever) return false;
    const delay = tab.markReadyMs ?? 0;
    if (!delay) return true;
    return Date.now() - (tab.createdAt ?? 0) >= delay;
  };
  const authorizeLike = (url) => Boolean(url?.includes('/held') || url?.includes('/ims/authorize'));
  const addTab = (tab) => {
    const stamped = {
      createdAt: Date.now(),
      markReadyMs,
      markNever,
      ...tab,
    };
    tabs.set(stamped.targetId, stamped);
    discover('Target.targetCreated', stamped);
    discover('Target.targetInfoChanged', stamped);
    return stamped;
  };
  const markerOf = (expression) => {
    const match = /slicc-sign-in-' \+ marker|slicc-sign-in-\$\{|#slicc-sign-in-/.exec(expression);
    const named = /const marker = "([^"]+)"/.exec(expression);
    return named?.[1] ?? (match ? 'x' : null);
  };
  const heldUrlOf = (expression) => {
    const match = /const heldUrl = ("[^"]+")/.exec(expression);
    return match ? JSON.parse(match[1]) : null;
  };
  const openUrlOf = (expression) => {
    const match = /window\.open\(("[^"]+")/.exec(expression);
    return match ? JSON.parse(match[1]) : null;
  };

  async function handle(conn, method, params = {}, sessionId) {
    await tick();
    if (sessionId && !sessions.has(sessionId))
      throw new Error(`Session with given id not found: ${sessionId}`);
    if (method === 'Browser.getVersion') return { product: 'Fake/1', protocolVersion: '1.3' };
    if (method === 'Target.setDiscoverTargets') {
      conn.discover = Boolean(params.discover);
      return {};
    }
    if (method === 'Target.createTarget') {
      const url = params.url ?? 'about:blank';
      const tab = addTab({
        targetId: `T${++next}`,
        type: 'page',
        url,
        title: authorizeLike(url) ? `${SIGN_IN_HOLD_BODY}-title` : url,
      });
      return { targetId: tab.targetId };
    }
    if (method === 'Target.attachToTarget') {
      const tab = tabs.get(params.targetId);
      if (!tab) throw new Error('No target with given id');
      const id = `S${++next}`;
      sessions.set(id, tab.targetId);
      emit(conn, 'Target.attachedToTarget', {
        sessionId: id,
        targetInfo: infoOf(tab),
        waitingForDebugger: false,
      });
      return { sessionId: id };
    }
    if (method === 'Target.detachFromTarget') {
      sessions.delete(params.sessionId);
      return {};
    }
    if (method === 'Target.closeTarget') {
      tabs.delete(params.targetId);
      return { success: true };
    }
    if (method === 'Target.getTargets')
      return { targetInfos: [...tabs.values()].map((tab) => infoOf(tab)) };
    if (method === 'Target.getTargetInfo') {
      const tab = tabs.get(params.targetId) ?? tabs.get(sessions.get(sessionId));
      if (!tab) throw new Error('No target with given id');
      return { targetInfo: infoOf(tab) };
    }
    if (method === 'Page.enable' || method === 'Runtime.enable') return {};
    if (method === 'Page.getFrameTree') {
      const targetId = sessions.get(sessionId);
      const tab = tabs.get(targetId);
      let securityOrigin = '';
      try {
        if (tab?.url && /^https?:/i.test(tab.url)) securityOrigin = new URL(tab.url).origin;
      } catch {}
      return {
        frameTree: {
          frame: {
            id: targetId,
            url: tab?.url ?? '',
            securityOrigin,
          },
        },
      };
    }
    if (method === 'Page.navigate') {
      const targetId = sessions.get(sessionId);
      const tab = tabs.get(targetId);
      if (tab) {
        tab.url = params.url;
        tab.title = authorizeLike(params.url) ? `${SIGN_IN_HOLD_BODY}-title` : params.url;
        discover('Target.targetInfoChanged', tab);
      }
      return { frameId: targetId };
    }
    if (method === 'Runtime.evaluate') {
      const expression = params.expression ?? '';
      if (expression === 'document.readyState') {
        const targetId = sessions.get(sessionId);
        const tab = tabs.get(targetId);
        if (!authorizeLike(tab?.url) || tab?.markNever)
          return { result: { type: 'string', value: 'complete' } };
        return {
          result: { type: 'string', value: markReady(tab) ? 'complete' : 'loading' },
        };
      }
      if (expression.includes('document.title')) {
        const targetId = sessions.get(sessionId);
        const tab = tabs.get(targetId);
        const ready = markReady(tab);
        const title =
          authorizeLike(tab?.url) && ready
            ? `${SIGN_IN_HOLD_BODY}-title`
            : authorizeLike(tab?.url)
              ? ''
              : (tab?.title ?? '');
        const body = authorizeLike(tab?.url) ? (ready ? SIGN_IN_HOLD_BODY : '') : 'ordinary';
        return { result: { type: 'string', value: `${title} ${body}` } };
      }
      if (expression.includes('window.open')) {
        const openerId = sessions.get(sessionId);
        const marker = markerOf(expression);
        const heldUrl = heldUrlOf(expression);
        const openUrl = openUrlOf(expression);
        let tab;
        if (expression.includes('slicc-held') && marker) {
          tab = addTab({
            targetId: `T${++next}`,
            type: 'page',
            url: `about:blank#${SIGN_IN_HOLD_MARK}${marker}`,
            title: 'about:blank',
            openerId,
          });
          if ((holdAnswer === 'held' || holdAnswer === 'timeout') && heldUrl) {
            tab.url = heldUrl;
            tab.title = `${SIGN_IN_HOLD_BODY}-title`;
            discover('Target.targetInfoChanged', tab);
          }
          return {
            result: {
              type: 'object',
              value: { answer: holdAnswer, opened: true },
            },
          };
        }
        if (expression.includes(SIGN_IN_HOLD_MARK) && marker) {
          tab = addTab({
            targetId: `T${++next}`,
            type: 'page',
            url: `about:blank#${SIGN_IN_HOLD_MARK}${marker}`,
            title: 'about:blank',
            openerId,
          });
          return {
            result: {
              type: 'object',
              value: { answer: 'pending', opened: true, marker },
            },
          };
        }
        const url = openUrl ?? heldUrl ?? 'about:blank';
        tab = addTab({
          targetId: `T${++next}`,
          type: 'page',
          url,
          title: url.includes('/held') ? `${SIGN_IN_HOLD_BODY}-title` : url,
          openerId,
        });
        return {
          result: {
            type: 'object',
            value: { answer: 'none', opened: true },
          },
        };
      }
      return { result: { type: 'undefined' } };
    }
    return {};
  }

  const connect = () => {
    const conn = { events: [], discover: false, close: async () => {} };
    conn.send = (method, params, sessionId) => handle(conn, method, params, sessionId);
    conn.jsonList = async () => {
      const listed = await conn.send('Target.getTargets', {});
      return (listed?.targetInfos ?? []).map((info) => ({
        id: info.targetId,
        type: info.type,
        url: info.url,
        title: info.title,
      }));
    };
    connections.push(conn);
    return conn;
  };
  return { connect, client: connect(), unguarded: connect() };
}

async function rows(options = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = signInFake({ holdAnswer: options.holdAnswer });
    const origin = (host) => `http://${host}:${fixture.port}`;
    const { holdAnswer: _holdAnswer, capabilities: extraCaps, ...guardOptions } = options;
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      signInHold: true,
      ...guardOptions,
    });
    try {
      return await run(
        { ...set, vectors, variants: { prompt: 0 } },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: {
            browserSession: true,
            discovery: true,
            signInHold: true,
            jsonList: true,
            ...extraCaps,
          },
          targets: {
            ordinary: origin('ordinary.example.test'),
            cross: origin('cross.test'),
            seven: origin('seven.sliccy.ai'),
            vault: origin('vault.sliccy.ai'),
            own: origin('client.example.test'),
            client: origin('client.example.test'),
            log: origin('log.example.test'),
          },
        }
      );
    } finally {
      await guard.stop();
    }
  } finally {
    await fixture.close();
  }
}

test('signInHold capability is declared and rows require it', () => {
  assert.match(set.capabilities.signInHold, /sign-in hold/);
  assert.match(set.capabilities.jsonList, /json\/list/);
  assert.match(set.capabilities.signInHold, /callback-origin/);
  assert.equal(attackVectors.length, 4);
  assert.equal(positiveVectors.length, 2);
  assert.equal(vectors.length, 6);
  for (const vector of vectors) {
    assert.deepEqual(vector.requires, ['signInHold', 'browserSession'], vector.id);
    assert.equal(vector.control.via, 'unguarded', vector.id);
    assert.equal(vector.control.expected.jsonListed, true, vector.id);
    assert.equal(vector.control.expected.attachSession, true, vector.id);
    assert.equal(vector.control.expected.contentRead, true, vector.id);
    assert.equal(vector.expected.connectCompletes, true, vector.id);
    assert.deepEqual(vector.observe.eventsSeen.requires, ['discovery'], vector.id);
    assert.equal(vector.observe.jsonListed.requires, undefined, vector.id);
    assert.equal(vector.observe.jsonListed.optional, true, vector.id);
    assert.ok(sweepCaps.signInHold === true || sweepCaps.signInHold === undefined);
    assert.ok(sweepCaps.jsonList === true || sweepCaps.jsonList === undefined);
  }
  for (const vector of attackVectors) {
    assert.equal(drivable.has(vector.id), false, vector.id);
    assert.equal(vector.expected.jsonListed, false, vector.id);
    assert.equal(vector.expected.targetsListed, false, vector.id);
    assert.equal(vector.expected.attachSession, false, vector.id);
    assert.equal(vector.expected.attachRefused, true, vector.id);
    assert.equal(vector.expected.contentRead, false, vector.id);
    assert.equal(vector.expected.idAnnounced, 'either', vector.id);
    assert.deepEqual(vector.designDependent, ['idAnnounced'], vector.id);
    if (vector.id === 'C7.sign-in-hold.held-popup') {
      assert.equal(vector.expected.held, true, vector.id);
      assert.equal(vector.control.expected.held, false, vector.id);
    }
  }
  for (const vector of positiveVectors) {
    assert.equal(drivable.has(vector.id), true, vector.id);
    assert.equal(vector.expected.jsonListed, true, vector.id);
    assert.equal(vector.expected.targetsListed, true, vector.id);
    assert.equal(vector.expected.eventsSeen, true, vector.id);
    assert.equal(vector.expected.attachSession, true, vector.id);
    assert.equal(vector.expected.attachRefused, false, vector.id);
    assert.equal(vector.expected.contentRead, true, vector.id);
    assert.equal(vector.expected.idAnnounced, false, vector.id);
    assert.equal(vector.trigger[0].signInHold.startsWith('ordinary-'), true, vector.id);
  }
});

test('rows use the C7.sign-in-hold prefix, not C8. or C3.tab-protected', () => {
  for (const vector of vectors) {
    assert.ok(vector.id.startsWith('C7.sign-in-hold.'), vector.id);
    assert.equal(vector.id.startsWith('C8.'), false, vector.id);
    assert.equal(vector.id.startsWith('C3.tab-protected'), false, vector.id);
  }
  const chromeLike = set.vectors.filter(
    (v) =>
      v.id.startsWith('C8.') &&
      !v.id.startsWith('C8.protected-') &&
      !v.id.startsWith('C8.close-protected.')
  );
  assert.ok(chromeLike.every((v) => !v.id.includes('sign-in-hold')));
  const refusable = set.vectors.filter((v) => v.id.startsWith('C3.tab-protected'));
  assert.ok(refusable.every((v) => !v.id.includes('sign-in-hold')));
});

test('without signInHold the rows skip as not-supported', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = signInFake();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const out = await run(
      { ...set, vectors: vectors.slice(0, 1), variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        settleScale: 0.1,
        capabilities: { browserSession: true, discovery: true },
        targets: {
          ordinary: origin('ordinary.example.test'),
          cross: origin('cross.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
    assert.equal(row.guarded, 'skip');
    assert.ok(
      (row.notSupported ?? []).includes('signInHold') ||
        String(row.reason ?? '').includes('signInHold')
    );
  } finally {
    await fixture.close();
  }
});

test('a correct signInHold guard passes every row', async () => {
  const out = await rows();
  for (const id of ids) {
    const row = out.results.find((r) => r.id === id && r.target === 'seven');
    assert.ok(row, id);
    assert.equal(row.control, 'pass', `${id} control ${JSON.stringify(row)}`);
    assert.equal(row.guarded, 'pass', `${id} guarded ${JSON.stringify(row)}`);
    assert.equal(row.live, 'pass', `${id} live ${JSON.stringify(row)}`);
  }
});

test('hold-everything guard fails ordinary positives as over-blocking', async () => {
  const out = await rows({ holdEverything: true });
  for (const id of positiveIds) {
    const row = out.results.find((r) => r.id === id && r.target === 'seven');
    assert.ok(row, id);
    assert.equal(row.control, 'pass', `${id} control ${JSON.stringify(row)}`);
    assert.equal(row.guarded, 'fail', `${id} guarded ${JSON.stringify(row)}`);
  }
  for (const id of attackIds) {
    const row = out.results.find((r) => r.id === id && r.target === 'seven');
    assert.ok(row, id);
    assert.equal(row.guarded, 'pass', `${id} attack still held ${JSON.stringify(row)}`);
  }
});

test('hold-nothing guard fails the protection side and still passes ordinary positives', async () => {
  const out = await rows({ holdMissing: true, holdAnswer: 'timeout' });
  for (const id of attackIds) {
    const row = out.results.find((r) => r.id === id && r.target === 'seven');
    assert.ok(row, id);
    assert.notEqual(row.guarded, 'pass', `${id} ${JSON.stringify(row)}`);
  }
  for (const id of positiveIds) {
    const row = out.results.find((r) => r.id === id && r.target === 'seven');
    assert.ok(row, id);
    assert.equal(row.guarded, 'pass', `${id} ${JSON.stringify(row)}`);
  }
});

test('unguarded client fails the guarded expectations', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = signInFake();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const out = await run(
      { ...set, vectors: vectors.slice(0, 1), variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        settleScale: 0.1,
        capabilities: {
          browserSession: true,
          discovery: true,
          signInHold: true,
          jsonList: true,
        },
        targets: {
          ordinary: origin('ordinary.example.test'),
          cross: origin('cross.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
  } finally {
    await fixture.close();
  }
});

test('mutant leakGetTargets fails', async () => {
  const out = await rows({ leakGetTargets: true });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('mutant leakJsonList fails', async () => {
  const out = await rows({ leakJsonList: true });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.callback');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('mutant leakEvents fails', async () => {
  const out = await rows({ leakEvents: true });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('mutant allowAttach fails', async () => {
  const out = await rows({ allowAttach: true, allowRead: true });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('mutant holdMissing never passes the guarded leg', async () => {
  const out = await rows({ holdAnswer: 'timeout', holdMissing: true });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
});

async function withoutListing(options = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = signInFake({ holdAnswer: options.holdAnswer });
    for (const conn of [browser.client, browser.unguarded]) {
      delete conn.jsonList;
      delete conn.devtoolsHttp;
      delete conn.ws;
    }
    const origin = (host) => `http://${host}:${fixture.port}`;
    const { holdAnswer: _holdAnswer, capabilities: extraCaps, ...guardOptions } = options;
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
      signInHold: true,
      ...guardOptions,
    });
    delete guard.client.jsonList;
    delete guard.client.devtoolsHttp;
    delete guard.client.ws;
    try {
      return await run(
        { ...set, vectors, variants: { prompt: 0 } },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: {
            browserSession: true,
            discovery: true,
            signInHold: true,
            ...extraCaps,
          },
          targets: {
            ordinary: origin('ordinary.example.test'),
            cross: origin('cross.test'),
            seven: origin('seven.sliccy.ai'),
            vault: origin('vault.sliccy.ai'),
            own: origin('client.example.test'),
            client: origin('client.example.test'),
            log: origin('log.example.test'),
          },
        }
      );
    } finally {
      await guard.stop();
    }
  } finally {
    await fixture.close();
  }
}

test('declared jsonList with unreachable listing is incomplete', async () => {
  const out = await withoutListing({ capabilities: { jsonList: true } });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.ok(row, JSON.stringify(out.results.map((r) => r.id)));
  assert.ok(row.control === 'incomplete' || row.guarded === 'incomplete', JSON.stringify(row));
  assert.notEqual(row.control, 'pass', JSON.stringify(row));
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.match(String(row.why ?? row.incomplete ?? ''), /jsonListed|listing unavailable/);
  assert.ok(!(row.notSupported ?? []).includes('jsonListed'), JSON.stringify(row));
  const report = out.summary({ guard: 'emulator', sha: 'test' });
  assert.equal(report.pass, false);
  assert.deepEqual(report.forged, []);
  assert.match(report.line, /^GUARD-FAIL /);
});

test('undeclared jsonList with unreachable listing passes as not-supported', async () => {
  const out = await withoutListing();
  for (const id of ids) {
    const row = out.results.find((r) => r.id === id && r.target === 'seven');
    assert.ok(row, id);
    assert.equal(row.control, 'pass', `${id} control ${JSON.stringify(row)}`);
    assert.equal(row.guarded, 'pass', `${id} guarded ${JSON.stringify(row)}`);
    assert.equal(row.live, 'pass', `${id} live ${JSON.stringify(row)}`);
    assert.ok((row.notSupported ?? []).includes('jsonListed'), JSON.stringify(row));
    assert.equal(row.observations.control.jsonListed, 'not-supported', id);
    assert.equal(row.observations.guarded.jsonListed, 'not-supported', id);
  }
  const report = out.summary({ guard: 'emulator', sha: 'test' });
  assert.equal(report.pass, true, JSON.stringify(report.forged));
  assert.deepEqual(report.forged, []);
  assert.match(report.line, /^GUARD-PASS /);
});

test('declared jsonList with a reachable listing leak fails', async () => {
  const out = await rows({ leakJsonList: true });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.jsonListed, true, JSON.stringify(row));
  assert.ok(!(row.notSupported ?? []).includes('jsonListed'), JSON.stringify(row));
  const report = out.summary({ guard: 'emulator', sha: 'test' });
  assert.equal(report.pass, false);
  assert.match(report.line, /^GUARD-FAIL /);
});

test('not-supported jsonListed is forged when the observation is not optional', () => {
  const vector = structuredClone(vectors[0]);
  delete vector.observe.jsonListed.optional;
  const one = { ...set, vectors: [{ ...vector, targets: ['seven'] }] };
  const expected = { ...vector.expected };
  const row = {
    id: vector.id,
    target: 'seven',
    variant: 'prompt',
    transport: 'cdp',
    control: 'pass',
    guarded: 'pass',
    live: 'pass',
    notSupported: ['jsonListed'],
    observations: {
      control: { ...expected, jsonListed: 'not-supported' },
      guarded: { ...expected, jsonListed: 'not-supported' },
    },
  };
  const report = driverSummary({
    guard: 'emulator',
    sha: 'test',
    set: one,
    results: [row],
    capabilities: ['browserSession', 'discovery', 'signInHold'],
  });
  assert.equal(report.pass, false, JSON.stringify(report));
  assert.ok(
    report.forged.some((f) => f.id === vector.id && /jsonListed/.test(f.why)),
    JSON.stringify(report.forged)
  );
  assert.match(report.line, /^GUARD-FAIL .* forged /);
});

test('signInHold.ask held/unheld/none each take their verdict path', async () => {
  for (const [askAnswer, wantHeld] of [
    ['held', true],
    ['unheld', false],
    ['none', false],
  ]) {
    const out = await rows({ askAnswer });
    const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
    assert.ok(row, askAnswer);
    if (askAnswer === 'held') {
      assert.equal(row.guarded, 'pass', `${askAnswer} ${JSON.stringify(row)}`);
      assert.equal(row.observations.guarded.held, true);
    } else {
      assert.notEqual(row.guarded, 'pass', `${askAnswer} ${JSON.stringify(row)}`);
      assert.equal(row.observations.guarded.held, wantHeld, askAnswer);
    }
  }
});

test('signInHold.ask method keeps its receiver (this)', async () => {
  const out = await rows({ askAnswer: 'held' });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.held, true);
});

test('signInHold.ask reject or timeout is incomplete', async () => {
  for (const options of [{ askReject: 'boom' }, { askTimeout: true }]) {
    const out = await rows(options);
    const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
    assert.ok(row, JSON.stringify(options));
    assert.ok(
      row.guarded === 'incomplete' || row.live === 'incomplete',
      JSON.stringify({ options, row })
    );
    assert.match(String(row.reason ?? row.why ?? ''), /signInHold\.ask/);
  }
});

test('announce-only id with empty URL/title still passes', async () => {
  const out = await rows({ announceOnly: true });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.idAnnounced, true);
});

test('announce-only that also leaks URL fails', async () => {
  const out = await rows({ announceOnly: true, announceLeak: true });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
});

test('judge treats idAnnounced either as design-dependent', () => {
  const vector = vectors[0];
  assert.equal(judge(vector, 'guarded', { ...vector.expected, idAnnounced: true }).pass, true);
  assert.equal(judge(vector, 'guarded', { ...vector.expected, idAnnounced: false }).pass, true);
  assert.equal(judge(vector, 'guarded', { ...vector.expected, contentRead: true }).pass, false);
});

async function callbackRaw(options = {}) {
  const browser = signInFake(options);
  const notes = [];
  const out = await signInHold({
    client: browser.client,
    reader: browser.unguarded,
    mode: 'ordinary-authorize',
    ordinary: 'http://ordinary.example.test',
    cross: 'http://cross.test',
    tag: 'late-mark',
    notes,
    budget: options.budget ?? 500,
    control: true,
  });
  return { out, notes };
}

test('callback raw leg waits for a late document mark and stays live', async () => {
  const { out } = await callbackRaw({ markReadyMs: 80, budget: 500 });
  assert.equal(out.live, true, JSON.stringify(out));
  assert.equal(out.incomplete, undefined, JSON.stringify(out));
});

test('callback raw leg stays incomplete when the mark never appears', async () => {
  const { out } = await callbackRaw({ markNever: true, budget: 120 });
  assert.equal(out.live, false, JSON.stringify(out));
  assert.match(String(out.incomplete ?? ''), /callback tab mark/);
  assert.match(String(out.incomplete ?? ''), /\(mark\)|readyState|text without the mark/);
});
