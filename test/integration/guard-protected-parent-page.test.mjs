import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { judge } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';
import { emulatedGuard } from './guard-emulator.mjs';
import { drivable } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const ids = [
  'C3.protected-parent-iframes.page',
  'C3.protected-parent-srcdoc.page',
  'C3.ordinary-parent-iframes.page',
];
const vectors = set.vectors.filter((v) => ids.includes(v.id));

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

function pageFake({ protectedHosts = ['seven.sliccy.ai', 'vault.sliccy.ai'] } = {}) {
  const tabs = new Map();
  const sessions = new Map();
  const sessionConn = new Map();
  const connections = [];
  let next = 0;
  const infoOf = (tab) => ({
    targetId: tab.targetId,
    type: tab.type,
    url: tab.url,
    title: tab.title ?? tab.url,
    browserContextId: 'B1',
    ...(tab.parentId ? { parentId: tab.parentId } : {}),
  });
  const emit = (conn, method, params, sessionId) => {
    conn.events.push({ method, params, ...(sessionId ? { sessionId } : {}) });
  };
  const hostOf = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  };
  const isProtected = (url) => protectedHosts.some((host) => hostOf(url) === host);
  const buildNest = (tab, midUrl) => {
    const midFrameId = `F${++next}`;
    const childFrameId = `F${++next}`;
    let childUrl = 'about:blank';
    try {
      const mid = new URL(midUrl);
      if (mid.pathname.includes('oopif-srcdoc')) childUrl = 'about:srcdoc';
      else childUrl = mid.searchParams.get('inner') ?? `${new URL(tab.url).origin}/doc?n=inner`;
    } catch {
      childUrl = 'about:blank';
    }
    tab.frameTree = {
      frame: tab.frame,
      childFrames: [
        {
          frame: { id: midFrameId, url: midUrl, parentId: tab.frame.id },
          childFrames: [
            {
              frame: {
                id: childFrameId,
                url: childUrl,
                parentId: midFrameId,
              },
            },
          ],
        },
      ],
    };
    tab.midFrameId = midFrameId;
    tab.childFrameId = childFrameId;
    tab.childUrl = childUrl;
    tab.midUrl = midUrl;
    tab.contexts = [
      {
        id: ++next,
        origin: (() => {
          try {
            return new URL(childUrl).origin;
          } catch {
            return '://';
          }
        })(),
        auxData: { frameId: childFrameId, isDefault: true },
      },
      {
        id: ++next,
        origin: (() => {
          try {
            return new URL(midUrl).origin;
          } catch {
            return '://';
          }
        })(),
        auxData: { frameId: midFrameId, isDefault: true },
      },
    ];
  };
  const emitFrameLife = (conn, sessionId, tab) => {
    if (!tab?.frameTree) return;
    const mid = tab.frameTree.childFrames[0];
    const child = mid.childFrames[0];
    emit(
      conn,
      'Page.frameAttached',
      { frameId: mid.frame.id, parentFrameId: tab.frame.id },
      sessionId
    );
    emit(
      conn,
      'Page.frameNavigated',
      { frame: { id: mid.frame.id, url: mid.frame.url, parentId: tab.frame.id } },
      sessionId
    );
    emit(
      conn,
      'Page.frameAttached',
      { frameId: child.frame.id, parentFrameId: mid.frame.id },
      sessionId
    );
    emit(
      conn,
      'Page.frameNavigated',
      {
        frame: {
          id: child.frame.id,
          url: child.frame.url,
          parentId: mid.frame.id,
        },
      },
      sessionId
    );
    emit(conn, 'Page.frameStartedLoading', { frameId: child.frame.id }, sessionId);
  };
  const emitContexts = (conn, sessionId, tab) => {
    for (const context of tab.contexts ?? [])
      emit(conn, 'Runtime.executionContextCreated', { context }, sessionId);
  };
  async function handle(conn, method, params = {}, sessionId) {
    await tick();
    if (sessionId && !sessions.has(sessionId))
      throw new Error(`Session with given id not found: ${sessionId}`);
    if (method === 'Target.setDiscoverTargets') {
      conn.discover = Boolean(params.discover);
      return {};
    }
    if (method === 'Target.createTarget') {
      const tab = {
        targetId: `T${++next}`,
        type: 'page',
        url: params.url ?? 'about:blank',
        title: params.url ?? 'about:blank',
        frame: { id: `F${++next}`, url: params.url ?? 'about:blank' },
        children: [],
        contexts: [],
      };
      tabs.set(tab.targetId, tab);
      if (/\/oopif-nest\?/.test(tab.url)) {
        const page = new URL(tab.url);
        const mid = page.searchParams.get('mid') ?? 'http://cross.test/oopif-mid';
        buildNest(tab, mid);
      }
      return { targetId: tab.targetId };
    }
    if (method === 'Target.attachToTarget') {
      const tab = tabs.get(params.targetId);
      if (!tab) throw new Error('No target with given id');
      const id = `S${++next}`;
      sessions.set(id, tab.targetId);
      sessionConn.set(id, conn);
      emit(conn, 'Target.attachedToTarget', {
        sessionId: id,
        targetInfo: infoOf(tab),
        waitingForDebugger: false,
      });
      return { sessionId: id };
    }
    if (method === 'Target.detachFromTarget') {
      sessions.delete(params.sessionId);
      sessionConn.delete(params.sessionId);
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
    if (method === 'Page.enable') {
      const tab = tabs.get(sessions.get(sessionId));
      if (tab?.frameTree) emitFrameLife(conn, sessionId, tab);
      return {};
    }
    if (method === 'Runtime.enable') {
      const tab = tabs.get(sessions.get(sessionId));
      if (tab) emitContexts(conn, sessionId, tab);
      return {};
    }
    if (method === 'Network.enable' || method === 'Page.navigate') {
      if (method === 'Page.navigate') {
        const tab = tabs.get(sessions.get(sessionId));
        if (tab && /\/oopif-nest\?/.test(params.url ?? '')) {
          tab.url = params.url;
          tab.frame.url = params.url;
          const page = new URL(params.url);
          buildNest(tab, page.searchParams.get('mid') ?? tab.midUrl);
          for (const [otherSession, targetId] of sessions) {
            if (targetId !== tab.targetId) continue;
            const other = sessionConn.get(otherSession);
            if (!other) continue;
            emitFrameLife(other, otherSession, tab);
            emitContexts(other, otherSession, tab);
          }
        }
      }
      return {};
    }
    if (method === 'Page.getFrameTree') {
      const tab = tabs.get(sessions.get(sessionId));
      return {
        frameTree: tab?.frameTree ?? {
          frame: tab?.frame ?? { id: sessions.get(sessionId), url: '' },
          childFrames: [],
        },
      };
    }
    if (method === 'Page.getResourceTree') {
      const tab = tabs.get(sessions.get(sessionId));
      const tree = tab?.frameTree ?? {
        frame: tab?.frame ?? { id: sessions.get(sessionId), url: '' },
        childFrames: [],
      };
      return { frameTree: tree };
    }
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'document.readyState')
        return { result: { type: 'string', value: 'complete' } };
      if (params.contextId != null) {
        const tab = tabs.get(sessions.get(sessionId));
        const context = (tab?.contexts ?? []).find((entry) => entry.id === params.contextId);
        if (!context) throw new Error('Cannot find context');
        if (params.expression === 'location.href')
          return {
            result: {
              type: 'string',
              value:
                context.auxData?.frameId === tab?.childFrameId
                  ? tab.childUrl
                  : (context.origin ?? ''),
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
  return {
    connect,
    client: connect(),
    unguarded: connect(),
    isProtected,
  };
}

test('protected-parent page rows need no browserSession and the ordinary control is drivable', () => {
  assert.equal(vectors.length, 3);
  for (const vector of vectors) {
    assert.equal(vector.requires, undefined, vector.id);
    assert.equal(vector.trigger[0].requires, undefined, vector.id);
    assert.equal(vector.control.via, 'unguarded', vector.id);
    assert.ok(vector.observe.frameTree, vector.id);
    assert.ok(vector.observe.midFrameAttached, vector.id);
  }
  assert.equal(drivable.has('C3.ordinary-parent-iframes.page'), true);
  assert.equal(drivable.has('C3.protected-parent-iframes.page'), false);
  assert.equal(drivable.has('C3.protected-parent-srcdoc.page'), false);
  assert.deepEqual(
    vectors.find((v) => v.id === 'C3.protected-parent-iframes.page').designDependent,
    ['midFrameAttached']
  );
  assert.equal(
    vectors.find((v) => v.id === 'C3.protected-parent-iframes.page').expected.midFrameAttached,
    'either'
  );
  assert.equal(
    vectors.find((v) => v.id === 'C3.ordinary-parent-iframes.page').expected.frameTree,
    true
  );
  assert.equal(
    vectors.find((v) => v.id === 'C3.protected-parent-iframes.page').trigger[0]
      .protectedParentIframes,
    'page-nested'
  );
  assert.equal(
    vectors.find((v) => v.id === 'C3.protected-parent-srcdoc.page').trigger[0]
      .protectedParentIframes,
    'page-srcdoc'
  );
  assert.equal(
    vectors.find((v) => v.id === 'C3.ordinary-parent-iframes.page').trigger[0]
      .protectedParentIframes,
    'page-ordinary'
  );
});

test('judge fails a grandchild frameTree leak on the page row', () => {
  const vector = vectors.find((v) => v.id === 'C3.protected-parent-iframes.page');
  const ok = {
    frameTree: false,
    resourceTree: false,
    frameEvents: false,
    contextCreated: false,
    contextEvaluate: false,
    midFrameAttached: false,
  };
  assert.equal(judge(vector, 'guarded', ok).pass, true);
  assert.equal(judge(vector, 'guarded', { ...ok, frameTree: true }).pass, false);
  assert.equal(judge(vector, 'guarded', { ...ok, frameEvents: true }).pass, false);
  assert.equal(judge(vector, 'guarded', { ...ok, midFrameAttached: true }).pass, true);
});

async function runMode(mode, { only = ids } = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = pageFake();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const targets = {
      ordinary: origin('ordinary.example.test'),
      seven: origin('seven.sliccy.ai'),
      vault: origin('vault.sliccy.ai'),
      own: origin('client.example.test'),
      client: origin('client.example.test'),
      cross: origin('cross.test'),
      log: origin('log.example.test'),
    };
    const guard =
      mode === 'none'
        ? { client: browser.client, stop: async () => {} }
        : emulatedGuard(browser, {
            protectedOrigins: catalog.protectedOrigins,
            extraOrigins: [targets.seven, targets.vault],
            ...mode,
          });
    try {
      return await run(
        {
          ...set,
          vectors: vectors.filter((v) => only.includes(v.id)),
          variants: { prompt: 0 },
        },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: { discovery: true },
          targets,
        }
      );
    } finally {
      await guard.stop?.();
    }
  } finally {
    await fixture.close();
  }
}

function describe(row) {
  return JSON.stringify(
    {
      id: row.id,
      target: row.target,
      control: row.control,
      guarded: row.guarded,
      live: row.live,
      why: row.why,
      incomplete: row.incomplete,
      notes: row.notes,
      observations: row.observations,
    },
    null,
    2
  );
}

test('a correct guard passes protected-parent page rows and the ordinary control', async () => {
  const execution = await runMode({});
  for (const row of execution.results) {
    assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], describe(row));
  }
});

test('an unguarded run passes control, fails guarded security page rows, and passes the ordinary control', async () => {
  const execution = await runMode('none');
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', describe(row));
    assert.equal(row.live, 'pass', describe(row));
    if (row.id === 'C3.ordinary-parent-iframes.page')
      assert.equal(row.guarded, 'pass', describe(row));
    else assert.equal(row.guarded, 'fail', describe(row));
  }
});

const mutants = [
  ['leakProtectedDescendantFrames', { leakProtectedDescendantFrames: true }],
  ['leakProtectedFrameEvents', { leakProtectedFrameEvents: true }],
  ['leakProtectedFrameContexts', { leakProtectedFrameContexts: true }],
];

for (const [name, options] of mutants) {
  test(`mutant ${name} fails a protected-parent page row`, async () => {
    const execution = await runMode(options, { only: ['C3.protected-parent-iframes.page'] });
    const row = execution.results.find((entry) => entry.id === 'C3.protected-parent-iframes.page');
    assert.ok(row, name);
    assert.equal(row.control, 'pass', describe(row));
    assert.equal(row.guarded, 'fail', describe(row));
  });
}

test('overblockOrdinaryFrames fails the ordinary-parent page control', async () => {
  const execution = await runMode(
    { overblockOrdinaryFrames: true },
    { only: ['C3.ordinary-parent-iframes.page'] }
  );
  const row = execution.results.find((entry) => entry.id === 'C3.ordinary-parent-iframes.page');
  assert.ok(row);
  assert.equal(row.control, 'pass', describe(row));
  assert.equal(row.guarded, 'fail', describe(row));
});

test('without an unguarded observer the protected-parent page rows skip', async () => {
  const fixture = await fixtureServer();
  const browser = pageFake();
  const origin = (host) => `http://${host}:${fixture.port}`;
  const guard = emulatedGuard(browser, {
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [origin('seven.sliccy.ai'), origin('vault.sliccy.ai')],
  });
  try {
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        fixture,
        settleScale: 0.1,
        capabilities: { discovery: true },
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          cross: origin('cross.test'),
          log: origin('log.example.test'),
        },
      }
    );
    for (const row of execution.results) {
      assert.equal(row.control, 'skip', row.id);
      assert.equal(row.reason, 'not-supported:unguarded-observer', row.id);
    }
  } finally {
    await guard.stop();
    await fixture.close();
  }
});

test('without a mapped {cross} the ordinary-parent page row is incomplete', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = pageFake();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const targets = {
      ordinary: origin('ordinary.example.test'),
      seven: origin('seven.sliccy.ai'),
      vault: origin('vault.sliccy.ai'),
      own: origin('client.example.test'),
      client: origin('client.example.test'),
      cross: null,
      log: origin('log.example.test'),
    };
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      extraOrigins: [targets.seven, targets.vault],
    });
    try {
      const execution = await run(
        {
          ...set,
          vectors: vectors.filter((v) => v.id === 'C3.ordinary-parent-iframes.page'),
          variants: { prompt: 0 },
        },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: { discovery: true },
          targets,
        }
      );
      const row = execution.results[0];
      assert.ok([row.control, row.guarded, row.live].includes('incomplete'), describe(row));
    } finally {
      await guard.stop();
    }
  } finally {
    await fixture.close();
  }
});
