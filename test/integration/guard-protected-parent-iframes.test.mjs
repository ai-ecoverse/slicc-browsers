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
const ids = ['C3.protected-parent-iframes', 'C3.protected-parent-srcdoc'];
const vectors = set.vectors.filter((v) => ids.includes(v.id));

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

function nestedFake({ srcdocTarget = true } = {}) {
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
    ...(tab.parentId ? { parentId: tab.parentId } : {}),
  });
  const emit = (conn, method, params, sessionId) => {
    conn.events.push({ method, params, ...(sessionId ? { sessionId } : {}) });
  };
  const discover = (method, tab) => {
    for (const conn of connections)
      if (conn.discover) emit(conn, method, { targetInfo: infoOf(tab) });
  };
  const spawnIframes = (parent, midUrl, innerUrl) => {
    const mid = {
      targetId: `I${++next}`,
      type: 'iframe',
      url: midUrl,
      title: midUrl,
      parentId: parent.targetId,
      frame: { id: `F${next}`, url: midUrl },
    };
    const inner = {
      targetId: `I${++next}`,
      type: 'iframe',
      url: innerUrl,
      title: innerUrl,
      parentId: mid.targetId,
      frame: { id: `F${next}`, url: innerUrl },
    };
    tabs.set(mid.targetId, mid);
    tabs.set(inner.targetId, inner);
    parent.children = [mid, inner];
    discover('Target.targetCreated', mid);
    discover('Target.targetInfoChanged', mid);
    discover('Target.targetCreated', inner);
    discover('Target.targetInfoChanged', inner);
  };
  const spawnSrcdoc = (parent) => {
    parent.frameTreeChild = { id: `F${++next}`, url: 'about:srcdoc' };
    if (!srcdocTarget) return;
    const child = {
      targetId: `I${++next}`,
      type: 'iframe',
      url: 'about:srcdoc',
      title: 'about:srcdoc',
      parentId: parent.targetId,
      frame: parent.frameTreeChild,
    };
    tabs.set(child.targetId, child);
    parent.children = [child];
    discover('Target.targetCreated', child);
    discover('Target.targetInfoChanged', child);
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
      };
      tabs.set(tab.targetId, tab);
      discover('Target.targetCreated', tab);
      if (/\/oopif-nest\?/.test(tab.url)) {
        const page = new URL(tab.url);
        const mid = page.searchParams.get('mid') ?? 'http://cross.test/oopif-mid';
        const midUrl = new URL(mid);
        const inner = midUrl.searchParams.get('inner') ?? 'http://ordinary.example.test/doc';
        spawnIframes(tab, mid, inner);
      }
      if (/\/oopif-srcdoc\?/.test(tab.url)) spawnSrcdoc(tab);
      discover('Target.targetInfoChanged', tab);
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
      const tab = tabs.get(params.targetId);
      if (tab) {
        for (const child of tab.children ?? []) tabs.delete(child.targetId);
        tabs.delete(params.targetId);
      }
      return { success: true };
    }
    if (method === 'Target.getTargets')
      return { targetInfos: [...tabs.values()].map((tab) => infoOf(tab)) };
    if (method === 'Target.getTargetInfo') {
      const tab = tabs.get(params.targetId) ?? tabs.get(sessions.get(sessionId));
      if (!tab) throw new Error('No target with given id');
      return { targetInfo: infoOf(tab) };
    }
    if (method === 'Page.enable' || method === 'Runtime.enable' || method === 'Page.navigate')
      return {};
    if (method === 'Page.getFrameTree') {
      const targetId = sessions.get(sessionId);
      const tab = tabs.get(targetId);
      const childFrames = (tab?.children ?? []).map((child) => ({
        frame: child.frame ?? { id: child.targetId, url: child.url },
      }));
      if (tab?.frameTreeChild && !childFrames.length)
        childFrames.push({ frame: tab.frameTreeChild });
      return {
        frameTree: {
          frame: tab?.frame ?? { id: targetId, url: tab?.url ?? '' },
          childFrames,
        },
      };
    }
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'document.readyState')
        return { result: { type: 'string', value: 'complete' } };
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
  };
}

test('protected-parent iframe rows are security rows without a capability gate', () => {
  assert.equal(vectors.length, 2);
  for (const vector of vectors) {
    assert.equal(drivable.has(vector.id), false, vector.id);
    assert.deepEqual(vector.requires, ['browserSession'], vector.id);
    assert.equal(vector.control.via, 'unguarded', vector.id);
    assert.equal(vector.expected.iframeListed, false, vector.id);
    assert.equal(vector.expected.infoRead, false, vector.id);
    assert.equal(vector.expected.eventsSeen, false, vector.id);
    assert.equal(vector.expected.attachSession, false, vector.id);
    assert.equal(vector.expected.attachRefused, true, vector.id);
    assert.equal(vector.control.expected.iframeListed, true, vector.id);
    assert.equal(vector.control.expected.attachSession, true, vector.id);
    assert.equal(vector.control.expected.attachRefused, false, vector.id);
    assert.deepEqual(vector.observe.eventsSeen.requires, ['discovery'], vector.id);
    assert.equal(vector.observe.iframeListed.absencePoll, true, vector.id);
  }
  assert.deepEqual(vectors.find((v) => v.id === 'C3.protected-parent-iframes').targets, [
    'seven',
    'vault',
  ]);
  assert.deepEqual(vectors.find((v) => v.id === 'C3.protected-parent-srcdoc').targets, ['seven']);
  assert.equal(
    vectors.find((v) => v.id === 'C3.protected-parent-iframes').trigger[0].protectedParentIframes,
    'nested-cross'
  );
  assert.equal(
    vectors.find((v) => v.id === 'C3.protected-parent-srcdoc').trigger[0].protectedParentIframes,
    'sandboxed-srcdoc'
  );
});

test('judge fails a leaking protected-parent iframe observation', () => {
  const vector = vectors[0];
  const ok = {
    iframeListed: false,
    infoRead: false,
    eventsSeen: false,
    attachSession: false,
    attachRefused: true,
  };
  assert.equal(judge(vector, 'guarded', ok).pass, true);
  assert.equal(judge(vector, 'guarded', { ...ok, iframeListed: true }).pass, false);
  assert.equal(judge(vector, 'guarded', { ...ok, attachSession: true }).pass, false);
  assert.equal(
    judge(vector, 'control', {
      ...ok,
      iframeListed: true,
      infoRead: true,
      eventsSeen: true,
      attachSession: true,
      attachRefused: false,
    }).pass,
    true
  );
});

async function runMode(mode, { srcdocTarget = true, ids: only = ids } = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = nestedFake({ srcdocTarget });
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
          capabilities: { discovery: true, browserSession: true },
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

test('a correct guard passes protected-parent iframe rows', async () => {
  const execution = await runMode({});
  for (const row of execution.results) {
    assert.deepEqual([row.control, row.guarded, row.live], ['pass', 'pass', 'pass'], describe(row));
  }
});

test('an unguarded run passes control and fails guarded protected-parent iframe rows', async () => {
  const execution = await runMode('none');
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', describe(row));
    assert.equal(row.guarded, 'fail', describe(row));
    assert.equal(row.live, 'pass', describe(row));
  }
});

const mutants = [
  ['iframeOwnUrlOnly', { iframeOwnUrlOnly: true }],
  ['iframeHeldParentOnly', { iframeHeldParentOnly: true }],
  ['leakIframeEvents', { leakIframeEvents: true }],
  ['leakAttachedToTarget', { leakAttachedToTarget: true }],
  ['leakTargetDestroyed', { leakTargetDestroyed: true }],
  ['allowProtectedParentAttach', { allowProtectedParentAttach: true }],
  ['redactIframeUrlKeepId', { redactIframeUrlKeepId: true }],
  ['leakNestedIframeOnly', { leakNestedIframeOnly: true }],
];

for (const [name, options] of mutants) {
  test(`mutant ${name} fails a protected-parent iframe row`, async () => {
    const execution = await runMode(options, { ids: ['C3.protected-parent-iframes'] });
    const row = execution.results.find((entry) => entry.id === 'C3.protected-parent-iframes');
    assert.ok(row, name);
    assert.equal(row.control, 'pass', describe(row));
    assert.equal(row.guarded, 'fail', describe(row));
  });
}

test('sandboxed srcdoc without an own target is incomplete, not a pass', async () => {
  const execution = await runMode({}, { srcdocTarget: false, ids: ['C3.protected-parent-srcdoc'] });
  const row = execution.results.find((entry) => entry.id === 'C3.protected-parent-srcdoc');
  assert.ok(row);
  assert.ok([row.control, row.guarded, row.live].includes('incomplete'), describe(row));
  assert.match(
    `${row.why ?? ''};${(row.incomplete ?? []).join(';')}`,
    /sandboxed srcdoc frame has no own target in this Chrome/
  );
  assert.ok(
    (row.notes ?? []).some((note) => note.includes('protected-parent.srcdoc-no-oopif')),
    describe(row)
  );
});

test('without an unguarded observer the protected-parent rows skip', async () => {
  const fixture = await fixtureServer();
  const browser = nestedFake();
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
        capabilities: { discovery: true, browserSession: true },
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

test('without a mapped {cross} origin the nested row is incomplete', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = nestedFake();
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
          vectors: vectors.filter((v) => v.id === 'C3.protected-parent-iframes'),
          variants: { prompt: 0 },
        },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: { discovery: true, browserSession: true },
          targets,
        }
      );
      for (const row of execution.results) {
        assert.ok([row.control, row.guarded].includes('incomplete'), describe(row));
        assert.match(
          `${row.why ?? ''};${(row.incomplete ?? []).join(';')}`,
          /no cross-site ordinary origin \(\{cross\}\) mapped/
        );
      }
    } finally {
      await guard.stop();
    }
  } finally {
    await fixture.close();
  }
});

function wrapListInfo(client, mode) {
  const send = client.send.bind(client);
  client.send = async (method, params, sessionId) => {
    if (method === 'Target.getTargets' || method === 'Target.getTargetInfo') {
      if (mode === 'timeout') throw new Error('timeout: no answer');
      throw new Error('slicc: refused: protected target');
    }
    return send(method, params, sessionId);
  };
  return client;
}

test('unanswered getTargets and getTargetInfo leave protected-parent incomplete, not a pass', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = nestedFake();
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
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      extraOrigins: [targets.seven, targets.vault],
    });
    wrapListInfo(guard.client, 'timeout');
    try {
      const execution = await run(
        {
          ...set,
          vectors: vectors.filter((v) => v.id === 'C3.protected-parent-iframes'),
          variants: { prompt: 0 },
        },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: { discovery: true, browserSession: true },
          targets,
        }
      );
      for (const row of execution.results) {
        assert.equal(row.control, 'pass', describe(row));
        assert.ok(
          [row.guarded, row.live].includes('incomplete') || row.guarded === 'incomplete',
          describe(row)
        );
        assert.match(
          `${row.why ?? ''};${(row.incomplete ?? []).join(';')}`,
          /Target\.getTargets unanswered|Target\.getTargetInfo unanswered/
        );
        assert.notEqual(row.guarded, 'pass', describe(row));
      }
    } finally {
      await guard.stop();
    }
  } finally {
    await fixture.close();
  }
});

test('slicc refused getTargets and getTargetInfo are valid negatives for protected-parent', async () => {
  const fixture = await fixtureServer();
  try {
    const browser = nestedFake();
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
    const guard = emulatedGuard(browser, {
      protectedOrigins: catalog.protectedOrigins,
      extraOrigins: [targets.seven, targets.vault],
    });
    wrapListInfo(guard.client, 'refused');
    try {
      const execution = await run(
        {
          ...set,
          vectors: vectors.filter((v) => v.id === 'C3.protected-parent-iframes'),
          variants: { prompt: 0 },
        },
        {
          client: guard.client,
          unguarded: browser.unguarded,
          fixture,
          settleScale: 0.1,
          capabilities: { discovery: true, browserSession: true },
          targets,
        }
      );
      for (const row of execution.results) {
        assert.deepEqual(
          [row.control, row.guarded, row.live],
          ['pass', 'pass', 'pass'],
          describe(row)
        );
      }
    } finally {
      await guard.stop();
    }
  } finally {
    await fixture.close();
  }
});
