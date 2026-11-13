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

function pageFake({
  protectedHosts = ['seven.sliccy.ai', 'vault.sliccy.ai'],
  oopifGrandchildTargets = false,
  omitLiveGrandchild = false,
} = {}) {
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
  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  };
  const buildNest = (tab, midUrl, { skipChild = false } = {}) => {
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
    const topOrigin = originOf(tab.url);
    const midOrigin = originOf(midUrl);
    const childOrigin = originOf(childUrl);
    const oopifMid = Boolean(midOrigin && midOrigin !== topOrigin);
    const oopifChild = Boolean(
      !skipChild &&
        oopifGrandchildTargets &&
        oopifMid &&
        childUrl !== 'about:srcdoc' &&
        childOrigin &&
        childOrigin !== midOrigin
    );
    let midMarker = '';
    try {
      midMarker = new URL(midUrl).searchParams.get('n') ?? '';
    } catch {
      midMarker = '';
    }
    const srcdocTop = Boolean(!skipChild && !oopifMid && childUrl === 'about:srcdoc');
    const nestChild = !skipChild;
    const childNode = {
      frame: { id: childFrameId, url: childUrl, parentId: midFrameId },
    };
    tab.frameTree = {
      frame: tab.frame,
      childFrames: [
        {
          frame: { id: midFrameId, url: midUrl, parentId: tab.frame.id },
          childFrames:
            nestChild && !oopifChild && !srcdocTop && childUrl !== 'about:srcdoc'
              ? [childNode]
              : [],
        },
      ],
    };
    tab.midFrameId = midFrameId;
    tab.childFrameId = nestChild ? childFrameId : undefined;
    tab.childUrl = nestChild ? childUrl : undefined;
    tab.midUrl = midUrl;
    tab.midMarker = midMarker;
    const childAsOwnTarget = Boolean(
      oopifChild || srcdocTop || (oopifMid && childUrl === 'about:srcdoc')
    );
    tab.contexts = nestChild
      ? childAsOwnTarget
        ? [
            {
              id: ++next,
              origin: midOrigin || '://',
              auxData: { frameId: midFrameId, isDefault: true },
            },
          ]
        : [
            {
              id: ++next,
              origin: childOrigin || '://',
              auxData: { frameId: childFrameId, isDefault: true },
            },
            {
              id: ++next,
              origin: midOrigin || '://',
              auxData: { frameId: midFrameId, isDefault: true },
            },
          ]
      : [
          {
            id: ++next,
            origin: midOrigin || '://',
            auxData: { frameId: midFrameId, isDefault: true },
          },
        ];
    if (srcdocTop && nestChild) {
      const childTab = {
        targetId: `T${++next}`,
        type: 'iframe',
        url: childUrl,
        title: childUrl,
        parentId: tab.targetId,
        frame: { id: childFrameId, url: childUrl, parentId: midFrameId },
        frameTree: {
          frame: { id: childFrameId, url: childUrl, parentId: midFrameId },
          childFrames: [],
        },
        contexts: [
          {
            id: ++next,
            origin: '://',
            auxData: { frameId: childFrameId, isDefault: true },
          },
        ],
        children: [],
        bodyText: `ordinary srcdoc ${midMarker}`,
      };
      tabs.set(childTab.targetId, childTab);
      tab.childTargetId = childTab.targetId;
    }
    if (oopifMid) {
      const midTab = {
        targetId: `T${++next}`,
        type: 'iframe',
        url: midUrl,
        title: midUrl,
        parentId: tab.targetId,
        frame: { id: midFrameId, url: midUrl },
        frameTree: {
          frame: { id: midFrameId, url: midUrl },
          childFrames: nestChild && !oopifChild ? [childNode] : [],
        },
        contexts: [
          {
            id: ++next,
            origin: midOrigin || '://',
            auxData: { frameId: midFrameId, isDefault: true },
          },
        ],
        children: [],
        midMarker,
      };
      tabs.set(midTab.targetId, midTab);
      tab.midTargetId = midTab.targetId;
      if (oopifChild && nestChild) {
        const childTab = {
          targetId: `T${++next}`,
          type: 'iframe',
          url: childUrl,
          title: childUrl,
          parentId: midTab.targetId,
          frame: { id: childFrameId, url: childUrl },
          frameTree: { frame: { id: childFrameId, url: childUrl }, childFrames: [] },
          contexts: [
            {
              id: ++next,
              origin: childOrigin || '://',
              auxData: { frameId: childFrameId, isDefault: true },
            },
          ],
          children: [],
        };
        tabs.set(childTab.targetId, childTab);
        tab.childTargetId = childTab.targetId;
        midTab.children = [childTab.targetId];
      } else if (!skipChild && childUrl === 'about:srcdoc') {
        const childTab = {
          targetId: `T${++next}`,
          type: 'iframe',
          url: childUrl,
          title: childUrl,
          parentId: midTab.targetId,
          frame: { id: childFrameId, url: childUrl, parentId: midFrameId },
          frameTree: {
            frame: { id: childFrameId, url: childUrl, parentId: midFrameId },
            childFrames: [],
          },
          contexts: [
            {
              id: ++next,
              origin: '://',
              auxData: { frameId: childFrameId, isDefault: true },
            },
          ],
          children: [],
          bodyText: `ordinary srcdoc ${midMarker}`,
        };
        tabs.set(childTab.targetId, childTab);
        tab.childTargetId = childTab.targetId;
        midTab.children = [childTab.targetId];
        midTab.frameTree = { frame: midTab.frame, childFrames: [] };
      }
    }
  };
  const emitFrameLife = (conn, sessionId, tab) => {
    if (!tab?.frameTree) return;
    if (tab.type === 'iframe') {
      emit(
        conn,
        'Page.frameNavigated',
        { frame: { id: tab.frame.id, url: tab.frame.url } },
        sessionId
      );
      for (const child of tab.frameTree.childFrames ?? []) {
        emit(
          conn,
          'Page.frameAttached',
          { frameId: child.frame.id, parentFrameId: tab.frame.id },
          sessionId
        );
        emit(
          conn,
          'Page.frameNavigated',
          {
            frame: {
              id: child.frame.id,
              url: child.frame.url,
              parentId: tab.frame.id,
            },
          },
          sessionId
        );
      }
      return;
    }
    const mid = tab.frameTree.childFrames?.[0];
    if (!mid) return;
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
    const child = mid.childFrames?.[0];
    if (!child) return;
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
    if (method === 'Target.setAutoAttach') {
      if (!params?.autoAttach || !sessionId) return {};
      const parent = tabs.get(sessions.get(sessionId));
      if (!parent) return {};
      for (const tab of tabs.values()) {
        if (tab.type !== 'iframe') continue;
        if (tab.parentId !== parent.targetId) continue;
        const id = `S${++next}`;
        sessions.set(id, tab.targetId);
        sessionConn.set(id, conn);
        emit(
          conn,
          'Target.attachedToTarget',
          {
            sessionId: id,
            targetInfo: infoOf(tab),
            waitingForDebugger: false,
          },
          sessionId
        );
      }
      return {};
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
          const skipChild = omitLiveGrandchild && page.searchParams.get('live') === '1';
          buildNest(tab, page.searchParams.get('mid') ?? tab.midUrl, { skipChild });
          for (const [otherSession, targetId] of sessions) {
            if (targetId !== tab.targetId) continue;
            const other = sessionConn.get(otherSession);
            if (!other) continue;
            emitFrameLife(other, otherSession, tab);
            emitContexts(other, otherSession, tab);
          }
        } else if (tab?.type === 'iframe' && /\/oopif-(mid|srcdoc)/.test(params.url ?? '')) {
          if (tab.children?.length) {
            for (const childId of tab.children) tabs.delete(childId);
            tab.children = [];
          }
          tab.url = params.url;
          tab.frame = { id: tab.frame?.id ?? `F${++next}`, url: params.url };
          const skipChild = omitLiveGrandchild;
          let childUrl = 'about:blank';
          let midMarker = '';
          try {
            const mid = new URL(params.url);
            midMarker = mid.searchParams.get('n') ?? '';
            if (mid.pathname.includes('oopif-srcdoc')) childUrl = 'about:srcdoc';
            else childUrl = mid.searchParams.get('inner') ?? childUrl;
          } catch {
            childUrl = 'about:blank';
          }
          tab.midMarker = midMarker;
          const childFrameId = `F${++next}`;
          const childOrigin = originOf(childUrl);
          const oopifChild = Boolean(
            oopifGrandchildTargets && childUrl !== 'about:srcdoc' && childOrigin
          );
          const srcdocChild = childUrl === 'about:srcdoc';
          if (!skipChild && (oopifChild || srcdocChild)) {
            const childTab = {
              targetId: `T${++next}`,
              type: 'iframe',
              url: childUrl,
              title: childUrl,
              parentId: tab.targetId,
              frame: {
                id: childFrameId,
                url: childUrl,
                ...(srcdocChild ? { parentId: tab.frame.id } : {}),
              },
              frameTree: {
                frame: {
                  id: childFrameId,
                  url: childUrl,
                  ...(srcdocChild ? { parentId: tab.frame.id } : {}),
                },
                childFrames: [],
              },
              contexts: [
                {
                  id: ++next,
                  origin: srcdocChild ? '://' : childOrigin || '://',
                  auxData: { frameId: childFrameId, isDefault: true },
                },
              ],
              children: [],
              ...(srcdocChild ? { bodyText: `ordinary srcdoc ${midMarker}` } : {}),
            };
            tabs.set(childTab.targetId, childTab);
            tab.children = [childTab.targetId];
            tab.frameTree = { frame: tab.frame, childFrames: [] };
          } else if (!skipChild) {
            tab.frameTree = {
              frame: tab.frame,
              childFrames: [{ frame: { id: childFrameId, url: childUrl, parentId: tab.frame.id } }],
            };
          } else {
            tab.frameTree = { frame: tab.frame, childFrames: [] };
          }
          tab.contexts = [
            {
              id: ++next,
              origin: originOf(tab.url) || '://',
              auxData: { frameId: tab.frame.id, isDefault: true },
            },
          ];
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
      if (params.expression === 'document.querySelector("iframe")?.src || ""') {
        const tab = tabs.get(sessions.get(sessionId));
        const nested = tab?.children?.[0] ? tabs.get(tab.children[0]) : null;
        const src =
          nested?.url ??
          tab?.childUrl ??
          tab?.frameTree?.childFrames?.[0]?.frame?.url ??
          tab?.frameTree?.childFrames?.[0]?.childFrames?.[0]?.frame?.url ??
          '';
        return { result: { type: 'string', value: src } };
      }
      if (
        params.expression ===
        '(document.body && (document.body.innerText || document.body.textContent)) || ""'
      ) {
        const tab = tabs.get(sessions.get(sessionId));
        const text = tab?.bodyText ?? (tab?.midMarker ? `ordinary srcdoc ${tab.midMarker}` : '');
        return { result: { type: 'string', value: text } };
      }
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
    targetInfo: false,
    childAttach: false,
    targetEvents: false,
  };
  assert.equal(judge(vector, 'guarded', ok).pass, true);
  assert.equal(judge(vector, 'guarded', { ...ok, frameTree: true }).pass, false);
  assert.equal(judge(vector, 'guarded', { ...ok, frameEvents: true }).pass, false);
  assert.equal(judge(vector, 'guarded', { ...ok, targetInfo: true }).pass, false);
  assert.equal(judge(vector, 'guarded', { ...ok, childAttach: true }).pass, false);
  assert.equal(judge(vector, 'guarded', { ...ok, targetEvents: true }).pass, false);
  assert.equal(judge(vector, 'guarded', { ...ok, midFrameAttached: true }).pass, true);
});

async function runMode(mode, { only = ids, oopifGrandchildTargets = false } = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = pageFake({ oopifGrandchildTargets });
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
            protectedParentPages: true,
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
  const execution = await runMode({}, { oopifGrandchildTargets: true });
  for (const row of execution.results) {
    assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], describe(row));
  }
});

test('an unguarded run passes control, fails guarded security page rows, and passes the ordinary control', async () => {
  const execution = await runMode('none', { oopifGrandchildTargets: true });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', describe(row));
    assert.equal(row.live, 'pass', describe(row));
    if (row.id === 'C3.ordinary-parent-iframes.page')
      assert.equal(row.guarded, 'pass', describe(row));
    else assert.equal(row.guarded, 'fail', describe(row));
  }
});

test('nested-in-tree shape still passes a correct guard', async () => {
  const execution = await runMode({}, { oopifGrandchildTargets: false });
  for (const row of execution.results) {
    if (row.id === 'C3.ordinary-parent-iframes.page') continue;
    assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], describe(row));
  }
});

const nestedMutants = [
  ['leakProtectedDescendantFrames', { leakProtectedDescendantFrames: true }],
  ['leakProtectedFrameEvents', { leakProtectedFrameEvents: true }],
  ['leakProtectedFrameContexts', { leakProtectedFrameContexts: true }],
  ['leakResourceTreeAfterLive', { leakResourceTreeAfterLive: true }],
];

for (const [name, options] of nestedMutants) {
  test(`mutant ${name} fails a nested protected-parent page row`, async () => {
    const execution = await runMode(options, {
      only: ['C3.protected-parent-iframes.page'],
      oopifGrandchildTargets: false,
    });
    const row = execution.results.find((entry) => entry.id === 'C3.protected-parent-iframes.page');
    assert.ok(row, name);
    assert.equal(row.control, 'pass', describe(row));
    assert.equal(row.guarded, 'fail', describe(row));
  });
}

const oopifMutants = [
  ['iframeOwnUrlOnly', { iframeOwnUrlOnly: true }],
  ['allowProtectedParentAttach', { allowProtectedParentAttach: true }],
  ['leakAttachedToTarget', { leakAttachedToTarget: true }],
  ['leakIframeEvents', { leakIframeEvents: true }],
];

for (const [name, options] of oopifMutants) {
  test(`mutant ${name} fails an OOPIF grandchild protected-parent page row`, async () => {
    const execution = await runMode(options, {
      only: ['C3.protected-parent-iframes.page'],
      oopifGrandchildTargets: true,
    });
    const row = execution.results.find((entry) => entry.id === 'C3.protected-parent-iframes.page');
    assert.ok(row, name);
    assert.equal(row.control, 'pass', describe(row));
    assert.equal(row.guarded, 'fail', describe(row));
  });
}

test('overblockOrdinaryFrames fails the ordinary-parent page control', async () => {
  const execution = await runMode(
    { overblockOrdinaryFrames: true },
    { only: ['C3.ordinary-parent-iframes.page'], oopifGrandchildTargets: false }
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
    protectedParentPages: true,
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

test('unanswered Page.enable on the page session is incomplete, not a guarded pass', async () => {
  const { protectedParentIframes } = await import('../../protected-parent-iframes.mjs');
  const fixture = await fixtureServer();
  try {
    const browser = pageFake();
    const origin = (host) => `http://${host}:${fixture.port}`;
    const ordinary = origin('ordinary.example.test');
    const seven = origin('seven.sliccy.ai');
    const wrap = (conn) => {
      const send = conn.send.bind(conn);
      conn.send = async (method, params, sessionId) => {
        if (sessionId && (method === 'Page.enable' || method === 'Runtime.enable'))
          throw new Error('timeout: no answer');
        return send(method, params, sessionId);
      };
      return conn;
    };
    const reader = browser.unguarded;
    const client = wrap(browser.connect());
    const notes = [];
    const result = await protectedParentIframes({
      client,
      reader,
      protectedOrigin: seven,
      cross: origin('cross.test'),
      ordinary,
      mode: 'page-nested',
      tag: 'enable-timeout',
      notes,
      budget: 2000,
    });
    assert.ok(result.incomplete, JSON.stringify({ result, notes }));
    assert.match(String(result.incomplete), /Page\.enable|Runtime\.enable/);
    assert.equal(result.frameTree, undefined);
  } finally {
    await fixture.close();
  }
});

test('unanswered child Page.enable is incomplete, not a guarded pass', async () => {
  const { protectedParentIframes } = await import('../../protected-parent-iframes.mjs');
  const fixture = await fixtureServer();
  try {
    const browser = pageFake({ oopifGrandchildTargets: true });
    const origin = (host) => `http://${host}:${fixture.port}`;
    let pageEnables = 0;
    const wrap = (conn) => {
      const send = conn.send.bind(conn);
      conn.send = async (method, params, sessionId) => {
        if (sessionId && method === 'Page.enable') {
          pageEnables += 1;
          if (pageEnables > 1) throw new Error('timeout: no answer');
        }
        return send(method, params, sessionId);
      };
      return conn;
    };
    const notes = [];
    const result = await protectedParentIframes({
      client: wrap(browser.connect()),
      reader: browser.unguarded,
      protectedOrigin: origin('seven.sliccy.ai'),
      cross: origin('cross.test'),
      ordinary: origin('ordinary.example.test'),
      mode: 'page-nested',
      tag: 'child-page-enable',
      notes,
      budget: 2000,
    });
    assert.ok(result.incomplete, JSON.stringify({ result, notes }));
    assert.match(String(result.incomplete), /Page\.enable unanswered/);
    assert.equal(result.frameEvents, undefined);
    assert.equal(result.contextCreated, undefined);
  } finally {
    await fixture.close();
  }
});

test('unanswered child Runtime.enable is incomplete, not a guarded pass', async () => {
  const { protectedParentIframes } = await import('../../protected-parent-iframes.mjs');
  const fixture = await fixtureServer();
  try {
    const browser = pageFake({ oopifGrandchildTargets: true });
    const origin = (host) => `http://${host}:${fixture.port}`;
    let runtimeEnables = 0;
    const wrap = (conn) => {
      const send = conn.send.bind(conn);
      conn.send = async (method, params, sessionId) => {
        if (sessionId && method === 'Runtime.enable') {
          runtimeEnables += 1;
          if (runtimeEnables > 1) throw new Error('timeout: no answer');
        }
        return send(method, params, sessionId);
      };
      return conn;
    };
    const notes = [];
    const result = await protectedParentIframes({
      client: wrap(browser.connect()),
      reader: browser.unguarded,
      protectedOrigin: origin('seven.sliccy.ai'),
      cross: origin('cross.test'),
      ordinary: origin('ordinary.example.test'),
      mode: 'page-nested',
      tag: 'child-runtime-enable',
      notes,
      budget: 2000,
    });
    assert.ok(result.incomplete, JSON.stringify({ result, notes }));
    assert.match(String(result.incomplete), /Runtime\.enable unanswered/);
    assert.equal(result.frameEvents, undefined);
    assert.equal(result.contextCreated, undefined);
  } finally {
    await fixture.close();
  }
});

test('refused child Page.enable is incomplete, not an inferred guarded pass', async () => {
  const { protectedParentIframes } = await import('../../protected-parent-iframes.mjs');
  const fixture = await fixtureServer();
  try {
    const browser = pageFake({ oopifGrandchildTargets: true });
    const origin = (host) => `http://${host}:${fixture.port}`;
    let pageEnables = 0;
    const wrap = (conn) => {
      const send = conn.send.bind(conn);
      conn.send = async (method, params, sessionId) => {
        if (sessionId && method === 'Page.enable') {
          pageEnables += 1;
          if (pageEnables > 1) throw new Error('slicc: refused: protected frame');
        }
        return send(method, params, sessionId);
      };
      return conn;
    };
    const notes = [];
    const result = await protectedParentIframes({
      client: wrap(browser.connect()),
      reader: browser.unguarded,
      protectedOrigin: origin('seven.sliccy.ai'),
      cross: origin('cross.test'),
      ordinary: origin('ordinary.example.test'),
      mode: 'page-nested',
      tag: 'child-page-enable-refused',
      notes,
      budget: 2000,
    });
    assert.equal(result.incomplete, undefined, JSON.stringify({ result, notes }));
    assert.equal(result.childEnableRefused, true, JSON.stringify({ result, notes }));
    assert.ok(
      notes.some((note) => note.includes('protected-parent.page-client')),
      notes.join('\n')
    );
  } finally {
    await fixture.close();
  }
});

test('missing live grandchild after post-attach navigation is incomplete', async () => {
  const { protectedParentIframes } = await import('../../protected-parent-iframes.mjs');
  const fixture = await fixtureServer();
  try {
    const browser = pageFake({ oopifGrandchildTargets: true, omitLiveGrandchild: true });
    const origin = (host) => `http://${host}:${fixture.port}`;
    const notes = [];
    const result = await protectedParentIframes({
      client: browser.connect(),
      reader: browser.unguarded,
      protectedOrigin: origin('seven.sliccy.ai'),
      cross: origin('cross.test'),
      ordinary: origin('ordinary.example.test'),
      mode: 'page-nested',
      tag: 'live-missing',
      notes,
      budget: 800,
    });
    assert.ok(result.incomplete, JSON.stringify({ result, notes }));
    assert.match(
      String(result.incomplete),
      /grandchild missing in raw leg after post-attach navigation/
    );
    assert.ok(
      notes.some((note) => note.includes('protected-parent.page-targets-after')),
      notes.join('\n')
    );
  } finally {
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
      protectedParentPages: true,
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

test('emulator without protectedParentPages still refuses ordinary tops that frame protected children', async () => {
  const source = await readFile(new URL('./guard-emulator.mjs', import.meta.url), 'utf8');
  const plain = source.slice(
    source.indexOf('function emulatedGuardPlain'),
    source.indexOf('async function timedSend')
  );
  assert.ok(source.includes('options.protectedParentPages'));
  assert.ok(plain.includes('if (options.protectedParentPages)'));
  assert.ok(plain.includes('} else if (protectedFrame(frameTree)) throw refusal'));
  const { protectedOrigins: rules } = catalog;
  const unguarded = {
    events: [],
    send: async (method, params, sessionId) => {
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { url: 'http://ordinary.example.test/', type: 'page' } };
      if (method === 'Target.attachToTarget') return { sessionId: 'reader' };
      if (method === 'Page.getFrameTree')
        return {
          frameTree: {
            frame: { url: 'http://ordinary.example.test/' },
            childFrames: [{ frame: { url: 'https://seven.sliccy.ai/doc' } }],
          },
        };
      if (method === 'Target.setAutoAttach') return {};
      if (method === 'Target.detachFromTarget') return {};
      return {};
    },
  };
  const calls = [];
  const guard = emulatedGuard(
    {
      unguarded,
      client: {
        events: [],
        send: async (method, params, sessionId) => {
          calls.push({ method, params, sessionId });
          return { sessionId: 'client' };
        },
      },
    },
    {
      protectedOrigins: rules,
      extraOrigins: ['https://seven.sliccy.ai'],
    }
  );
  try {
    await assert.rejects(
      () => guard.client.send('Target.attachToTarget', { targetId: 'ord', flatten: true }),
      /refused.*protected.*frame/
    );
    assert.deepEqual(calls, []);
  } finally {
    await guard.stop();
  }
});
