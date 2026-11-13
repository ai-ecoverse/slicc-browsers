import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { judge } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { SIGN_IN_HOLD_BODY, SIGN_IN_HOLD_MARK } from '../../sign-in-hold.mjs';
import { emulatedGuard } from './guard-emulator.mjs';
import { drivable, capabilities as sweepCaps } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const ids = [
  'C7.sign-in-hold.held-popup',
  'C7.sign-in-hold.callback',
  'C7.sign-in-hold.callback-encoded',
  'C7.sign-in-hold.callback-origin',
];
const vectors = set.vectors.filter((v) => ids.includes(v.id));

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

function signInFake({ holdAnswer = 'held' } = {}) {
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
  const addTab = (tab) => {
    tabs.set(tab.targetId, tab);
    discover('Target.targetCreated', tab);
    discover('Target.targetInfoChanged', tab);
    return tab;
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
        title:
          url.includes('/held') || url.includes('/ims/authorize')
            ? `${SIGN_IN_HOLD_BODY}-title`
            : url,
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
        tab.title =
          params.url.includes('/held') || params.url.includes('/ims/authorize')
            ? `${SIGN_IN_HOLD_BODY}-title`
            : params.url;
        discover('Target.targetInfoChanged', tab);
      }
      return { frameId: targetId };
    }
    if (method === 'Runtime.evaluate') {
      const expression = params.expression ?? '';
      if (expression === 'document.readyState')
        return { result: { type: 'string', value: 'complete' } };
      if (expression.includes('document.title')) {
        const targetId = sessions.get(sessionId);
        const tab = tabs.get(targetId);
        const title = tab?.title ?? '';
        const body =
          tab?.url?.includes('/held') || tab?.url?.includes('/ims/authorize')
            ? SIGN_IN_HOLD_BODY
            : 'ordinary';
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
          if (holdAnswer === 'held' && heldUrl) {
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
  assert.equal(vectors.length, 4);
  for (const vector of vectors) {
    assert.equal(drivable.has(vector.id), false, vector.id);
    assert.deepEqual(vector.requires, ['signInHold', 'browserSession'], vector.id);
    assert.equal(vector.control.via, 'unguarded', vector.id);
    assert.equal(vector.expected.jsonListed, false, vector.id);
    assert.equal(vector.expected.targetsListed, false, vector.id);
    assert.equal(vector.expected.attachSession, false, vector.id);
    assert.equal(vector.expected.attachRefused, true, vector.id);
    assert.equal(vector.expected.contentRead, false, vector.id);
    assert.equal(vector.expected.connectCompletes, true, vector.id);
    assert.equal(vector.expected.idAnnounced, 'either', vector.id);
    assert.deepEqual(vector.designDependent, ['idAnnounced'], vector.id);
    assert.equal(vector.control.expected.jsonListed, true, vector.id);
    assert.equal(vector.control.expected.attachSession, true, vector.id);
    assert.equal(vector.control.expected.contentRead, true, vector.id);
    assert.deepEqual(vector.observe.eventsSeen.requires, ['discovery'], vector.id);
    assert.ok(sweepCaps.signInHold === true || sweepCaps.signInHold === undefined);
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
        capabilities: { browserSession: true, discovery: true, signInHold: true },
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

test('mutant holdMissing is incomplete, never a guarded pass', async () => {
  const out = await rows({ holdAnswer: 'timeout', holdMissing: true });
  const row = out.results.find((r) => r.id === 'C7.sign-in-hold.held-popup');
  assert.notEqual(row.guarded, 'pass', JSON.stringify(row));
  assert.ok(row.guarded === 'incomplete' || row.live === 'incomplete', JSON.stringify(row));
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
