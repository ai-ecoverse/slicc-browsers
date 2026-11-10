import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { launch, origins } from './cdp-client.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const stripId = 'E7.isolated-world';
const stripVectors = set.vectors.filter((vector) => vector.id === stripId);
const attackIds = [
  'E7.init-boundary',
  'E7.init-world-carry',
  'E7.init-world-carry.script',
  'E7.init-world-bfcache',
  'E7.init-world-bfcache.script',
  'E7.emulation-carry',
  'E7.emulation-carry.script',
  'E7.isolated-foreign',
  'E7.isolated-foreign.script',
  'E7.ua-empty',
  'E7.binding-main',
  'E7.binding-main-ctx',
  'C3.tab-protected',
  'C3.tab-blank',
  'C3.tab-protected.synthetic',
  'C3.tab-blank.synthetic',
  'C3.tab-iframe-leak',
  'C3.protected-worker-dedicated',
  'C3.protected-worker-shared',
  'C3.protected-worker-framed',
];
const attackVectors = set.vectors.filter((vector) => attackIds.includes(vector.id));
const positiveStockIds = [
  'E7.init-world-error',
  'E7.init-world-error.script',
  'C3.tab-worker-leak',
  'C3.tab-service-worker-leak',
];
const base = { autoAttach: true, browserSession: true, browserContexts: true };
const stockCaps = { ...base, stockSetup: true, syntheticAutoAttach: true, forwardAudit: true };

function record(client) {
  const forwarded = client.forwarded ?? [];
  if (!client.forwarded) client.forwarded = forwarded;
  const send = client.send.bind(client);
  client.send = (method, params = {}, sessionId) => {
    forwarded.push({ method, params, sessionId, sentAt: Date.now() });
    return send(method, params, sessionId);
  };
  return client;
}

async function execute(mode, only = stripVectors) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.client);
  record(browser.unguarded);
  const guard =
    mode === 'none'
      ? { client: browser.client, stop: async () => {} }
      : emulatedGuard(browser, {
          stripUniversalAccess: mode === 'strip',
          narrowAutoAttach: mode === 'strip',
          refuse: mode === 'refuse' ? (method) => method === 'Page.createIsolatedWorld' : undefined,
        });
  try {
    return await run(
      { ...set, vectors: only, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: stockCaps,
        rowTimeoutMs: 60000,
      }
    );
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
}

test('the published attack and strip rows are present', () => {
  assert.deepEqual(attackVectors.map((vector) => vector.id).sort(), [...attackIds].sort());
  for (const id of positiveStockIds) {
    assert.ok(
      set.vectors.some((vector) => vector.id === id),
      id
    );
    assert.equal(attackIds.includes(id), false, id);
  }
  assert.equal(stripVectors.length, 1);
  assert.deepEqual(stripVectors[0].targets, ['ordinary']);
  assert.equal(stripVectors[0].control.via, 'unguarded');
  assert.ok(stripVectors[0].requires.includes('forwardAudit'));
});

test('E7.init-boundary sources hold real CR, LS, PS, NUL and BOM characters', () => {
  const vector = set.vectors.find((item) => item.id === 'E7.init-boundary');
  const source = (as) => vector.setup.find((step) => step.as === as).params.source;
  assert.ok(source('boundCr').includes('\r'));
  assert.ok(source('boundLs').includes('\u2028'));
  assert.ok(source('boundPs').includes('\u2029'));
  assert.ok(source('boundNul').includes('\0'));
  assert.ok(source('boundBom').includes('\ufeff'));
  assert.equal(source('boundCr').includes('\\r'), false);
  assert.equal(source('boundNul').includes('\\0'), false);
  assert.equal(vector.expected.installedNul, false);
  assert.equal(
    set.vectors.find((item) => item.id === 'E7.init-script').expected.installedNul,
    true
  );
  assert.deepEqual(vector.observe.ranCr.dependsOn, []);
  assert.deepEqual(vector.observe.installedNul.dependsOn, []);
});

test('a guard that strips grantUniveralAccess passes E7.isolated-world', {
  timeout: 180000,
}, async () => {
  const execution = await execute('strip');
  const [row] = execution.results;
  assert.deepEqual(
    [row.control, row.guarded, row.live],
    ['pass', 'pass', 'pass'],
    JSON.stringify(row)
  );
  assert.equal(row.observations.guarded.stripped, true);
});

test('a guard that forwards grantUniveralAccess true fails E7.isolated-world', {
  timeout: 180000,
}, async () => {
  const execution = await execute('none');
  const [row] = execution.results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.stripped, false, JSON.stringify(row));
});

test('without forwardAudit E7.isolated-world skips, never passes', async () => {
  const client = { events: [], forwarded: [], send: async () => assert.fail('skipped') };
  const fixture = await fixtureServer();
  try {
    const execution = await run(
      { ...set, vectors: stripVectors, variants: { prompt: 0 } },
      {
        client,
        unguarded: client,
        fixture,
        targets: origins(fixture),
        capabilities: { ...base, stockSetup: true },
      }
    );
    const [row] = execution.results;
    assert.deepEqual([row.control, row.guarded, row.live], ['skip', 'skip', 'skip']);
    assert.equal(row.reason, 'not-supported:forwardAudit');
  } finally {
    await fixture.close();
  }
});

test('without a guard every stock-setup attack control passes', {
  timeout: 900000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.client);
  record(browser.unguarded);
  try {
    const execution = await run(
      { ...set, vectors: attackVectors, variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: stockCaps,
        rowTimeoutMs: 90000,
      }
    );
    for (const row of execution.results) assert.equal(row.control, 'pass', JSON.stringify(row));
  } finally {
    await browser.close();
    await fixture.close();
  }
});

const attackStock = new Set([
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Emulation.setFocusEmulationEnabled',
  'Emulation.setEmulatedMedia',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setUserAgentOverride',
  'Runtime.addBinding',
  'Page.createIsolatedWorld',
  'Target.setAutoAttach',
]);

test('an admit-all reference fails every protected-target stock-setup attack row', {
  timeout: 900000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.client);
  record(browser.unguarded);
  try {
    const execution = await run(
      { ...set, vectors: attackVectors, variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: stockCaps,
        rowTimeoutMs: 90000,
      }
    );
    const leaking = execution.results.filter(
      (row) => row.target !== 'ordinary' || row.id === 'E7.ua-empty'
    );
    assert.ok(leaking.length > 0);
    for (const row of leaking) assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(execution.summary({ guard: 'admit-all' }).pass, false);
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('C3.tab-service-worker-leak control passes on a secure origin', {
  timeout: 180000,
}, async () => {
  const tls = {
    key: await readFile(new URL('./fixtures/tls-key.pem', import.meta.url)),
    cert: await readFile(new URL('./fixtures/tls-cert.pem', import.meta.url)),
  };
  const spki = createHash('sha256')
    .update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const fixture = await fixtureServer({ tls });
  const browser = await launch(fixture, { spki });
  record(browser.client);
  record(browser.unguarded);
  const only = set.vectors.filter((vector) => vector.id === 'C3.tab-service-worker-leak');
  try {
    const execution = await run(
      { ...set, vectors: only, variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: { ...stockCaps, secureOrigin: true },
        rowTimeoutMs: 90000,
      }
    );
    for (const row of execution.results) assert.equal(row.control, 'pass', JSON.stringify(row));
  } finally {
    await browser.close();
    await fixture.close();
  }
});

const carryIds = ['E7.emulation-carry', 'E7.init-world-carry', 'E7.init-world-bfcache'];
const carryScriptIds = carryIds.map((id) => `${id}.script`);
const carryVectors = set.vectors.filter((vector) => carryIds.includes(vector.id));
const carryScriptVectors = set.vectors.filter((vector) => carryScriptIds.includes(vector.id));
const errorScriptVectors = set.vectors.filter(
  (vector) => vector.id === 'E7.init-world-error.script'
);
const commandNavIds = [
  ...carryIds,
  'E7.init-world-error',
  'E7.isolated-foreign',
  'C3.tab-protected',
  'C3.tab-protected.synthetic',
];
const commandNavVectors = set.vectors.filter((vector) => commandNavIds.includes(vector.id));
const scriptAttackVectors = set.vectors.filter((vector) =>
  [...carryScriptIds, 'E7.isolated-foreign.script'].includes(vector.id)
);

function protectedCommand(method, params, targets) {
  const origins = new Set([targets.seven, targets.vault].map((origin) => new URL(origin).origin));
  if (method === 'Page.navigate' && params?.url) return origins.has(new URL(params.url).origin);
  if (method === 'Target.createTarget' && params?.url)
    return origins.has(new URL(params.url).origin);
  return false;
}

function lyingRefuseClient(browser, targets) {
  const raw = browser.client;
  const forwarded = [];
  const send = async (method, params = {}, sessionId) => {
    if (protectedCommand(method, params, targets)) {
      forwarded.push({ method, params, sessionId, sentAt: Date.now() });
      await raw.send(method, params, sessionId);
      throw new Error('slicc: refused: browser-wide call');
    }
    forwarded.push({ method, params, sessionId, sentAt: Date.now() });
    return raw.send(method, params, sessionId);
  };
  return { ...raw, send, forwarded, events: raw.events };
}

function lyingRefuseWorldClient(browser) {
  const raw = browser.client;
  const forwarded = [];
  const send = async (method, params = {}, sessionId) => {
    if (method === 'Page.createIsolatedWorld') {
      forwarded.push({ method, params, sessionId, sentAt: Date.now() });
      await raw.send(method, params, sessionId);
      throw new Error('slicc: refused: browser-wide call');
    }
    forwarded.push({ method, params, sessionId, sentAt: Date.now() });
    return raw.send(method, params, sessionId);
  };
  return { ...raw, send, forwarded, events: raw.events };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lateCommitClient(
  raw,
  targets,
  { refuse = false, refuseWorld = false, delayMs = 400 } = {}
) {
  const origins = new Set([targets.seven, targets.vault].map((origin) => new URL(origin).origin));
  const protectedUrl = (url) => {
    try {
      return origins.has(new URL(url).origin);
    } catch {
      return false;
    }
  };
  const fetchReady = new Set();
  const forwarded = [];
  const events = raw.events;
  const push = events.push.bind(events);
  events.push = (...items) => {
    for (const event of items) {
      if (event?.method !== 'Fetch.requestPaused') continue;
      const url = event.params?.request?.url ?? '';
      const sessionId = event.sessionId;
      const requestId = event.params?.requestId;
      void (async () => {
        if (event.params?.resourceType === 'Document' && protectedUrl(url)) await pause(delayMs);
        if (requestId)
          await raw.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
      })();
    }
    return push(...items);
  };
  const ensureFetch = async (sessionId) => {
    if (!sessionId || fetchReady.has(sessionId)) return;
    fetchReady.add(sessionId);
    await raw
      .send(
        'Fetch.enable',
        {
          patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
        },
        sessionId
      )
      .catch(() => fetchReady.delete(sessionId));
  };
  const send = async (method, params = {}, sessionId) => {
    if (method === 'Page.enable') await ensureFetch(sessionId);
    if (refuseWorld && method === 'Page.createIsolatedWorld') {
      forwarded.push({ method, params, sessionId, sentAt: Date.now() });
      throw new Error('slicc: refused: browser-wide call');
    }
    if (protectedCommand(method, params, targets)) {
      forwarded.push({ method, params, sessionId, sentAt: Date.now() });
      if (refuse) {
        setTimeout(() => {
          raw.send(method, params, sessionId).catch(() => {});
        }, delayMs);
        throw new Error('slicc: refused: browser-wide call');
      }
      await pause(delayMs);
      return raw.send(method, params, sessionId);
    }
    forwarded.push({ method, params, sessionId, sentAt: Date.now() });
    return raw.send(method, params, sessionId);
  };
  return { ...raw, send, forwarded, events };
}

function clearingStockClient(browser, targets) {
  const protectedOrigins = new Set(
    [targets.seven, targets.vault, targets.apex, targets['vault-x']]
      .filter(Boolean)
      .map((origin) => new URL(origin).origin)
  );
  const scripts = new Map();
  const fetchReady = new Set();
  const clearing = new Set();
  const raw = browser.client;
  const forwarded = [];
  const protectedUrl = (url) => {
    try {
      return protectedOrigins.has(new URL(url).origin);
    } catch {
      return false;
    }
  };
  const clearAdmitted = async (sessionId) => {
    if (!sessionId || clearing.has(sessionId)) return;
    clearing.add(sessionId);
    try {
      for (const identifier of scripts.get(sessionId) ?? [])
        await raw
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId)
          .catch(() => {});
      scripts.set(sessionId, []);
      await raw.send('Emulation.clearDeviceMetricsOverride', {}, sessionId).catch(() => {});
      await raw
        .send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId)
        .catch(() => {});
      await raw
        .send('Emulation.setEmulatedMedia', { media: '', features: [] }, sessionId)
        .catch(() => {});
      await raw
        .send('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId)
        .catch(() => {});
    } finally {
      clearing.delete(sessionId);
    }
  };
  const ensureFetch = async (sessionId) => {
    if (!sessionId || fetchReady.has(sessionId)) return;
    fetchReady.add(sessionId);
    await raw
      .send(
        'Fetch.enable',
        {
          patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
        },
        sessionId
      )
      .catch(() => fetchReady.delete(sessionId));
  };
  const events = raw.events;
  const push = events.push.bind(events);
  events.push = (...items) => {
    for (const event of items) {
      if (event?.method === 'Fetch.requestPaused') {
        const url = event.params?.request?.url ?? '';
        const sessionId = event.sessionId;
        const requestId = event.params?.requestId;
        void (async () => {
          if (event.params?.resourceType === 'Document' && protectedUrl(url))
            await clearAdmitted(sessionId);
          if (requestId)
            await raw.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
        })();
      }
      if (event?.method === 'Page.frameNavigated' && !event.params?.frame?.parentId) {
        const frame = event.params.frame;
        const url = frame.unreachableUrl || frame.url;
        if (protectedUrl(url)) void clearAdmitted(event.sessionId);
      }
    }
    return push(...items);
  };
  const send = async (method, params = {}, sessionId) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      const result = await raw.send(method, params, sessionId);
      forwarded.push({ method, params, sessionId, sentAt: Date.now() });
      const list = scripts.get(sessionId) ?? [];
      if (result?.identifier) list.push(result.identifier);
      scripts.set(sessionId, list);
      return result;
    }
    if (method === 'Page.enable') await ensureFetch(sessionId);
    if (method === 'Page.navigate' && params?.url && protectedUrl(params.url))
      await clearAdmitted(sessionId);
    if (method === 'Runtime.evaluate' && typeof params.expression === 'string') {
      const match = /^location\.href=(.*)$/.exec(params.expression);
      if (match) {
        try {
          if (protectedUrl(JSON.parse(match[1]))) await clearAdmitted(sessionId);
        } catch {}
      }
    }
    forwarded.push({ method, params, sessionId, sentAt: Date.now() });
    return raw.send(method, params, sessionId);
  };
  return { ...raw, send, forwarded, events };
}

function pageEvidenceOnly(client, { rewrite } = {}) {
  const send = client.send.bind(client);
  client.send = async (method, params = {}, sessionId) => {
    if (method === 'Network.enable') return {};
    return send(method, params, sessionId);
  };
  const events = client.events;
  const push = events.push.bind(events);
  events.push = (...items) => {
    const kept = [];
    for (const event of items) {
      if (event?.method?.startsWith('Network.')) continue;
      const frame = event?.params?.frame;
      if (rewrite && event?.method === 'Page.frameNavigated' && frame?.unreachableUrl)
        frame.unreachableUrl = rewrite(frame.unreachableUrl) ?? frame.unreachableUrl;
      kept.push(event);
    }
    return kept.length ? push(...kept) : events.length;
  };
  return client;
}

async function runCarry(mode, { vectors = carryVectors, rewrite } = {}) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  const targets = origins(fixture);
  let unguarded = browser.unguarded;
  let guard;
  if (mode === 'refuse-nav' || mode === 'wrong-url') {
    guard = emulatedGuard(browser, {
      failDocumentOrigins: [targets.seven, targets.vault],
    });
    pageEvidenceOnly(guard.client, mode === 'wrong-url' ? { rewrite } : undefined);
  } else if (mode === 'refuse-command') {
    guard = emulatedGuard(browser, {
      refuse: (method, params) => protectedCommand(method, params, targets),
    });
  } else if (mode === 'lying-refuse') {
    guard = { client: lyingRefuseClient(browser, targets), stop: async () => {} };
  } else if (mode === 'lying-refuse-world') {
    guard = { client: lyingRefuseWorldClient(browser), stop: async () => {} };
  } else if (mode === 'refuse-world') {
    guard = emulatedGuard(browser, {
      refuse: (method) => method === 'Page.createIsolatedWorld',
    });
  } else if (mode === 'fail-document-refuse-world') {
    guard = emulatedGuard(browser, {
      failDocumentOrigins: [targets.seven, targets.vault],
      refuse: (method) => method === 'Page.createIsolatedWorld',
    });
    pageEvidenceOnly(guard.client);
  } else if (mode === 'late-lying-refuse') {
    guard = {
      client: lateCommitClient(browser.client, targets, { refuse: true, delayMs: 400 }),
      stop: async () => {},
    };
    unguarded = lateCommitClient(browser.unguarded, targets, { delayMs: 400 });
  } else if (mode === 'late-keep') {
    guard = {
      client: lateCommitClient(browser.client, targets, { delayMs: 400 }),
      stop: async () => {},
    };
    unguarded = lateCommitClient(browser.unguarded, targets, { delayMs: 400 });
  } else if (mode === 'late-refuse-world') {
    guard = {
      client: lateCommitClient(browser.client, targets, { refuseWorld: true, delayMs: 400 }),
      stop: async () => {},
    };
    unguarded = lateCommitClient(browser.unguarded, targets, { delayMs: 400 });
  } else if (mode === 'refuse-command-and-block-script') {
    guard = emulatedGuard(browser, {
      refuse: (method, params) => protectedCommand(method, params, targets),
      failDocumentOrigins: [targets.seven, targets.vault],
    });
    pageEvidenceOnly(guard.client);
  } else if (mode === 'refuse-command-keep-script') {
    guard = emulatedGuard(browser, {
      refuse: (method, params) => protectedCommand(method, params, targets),
    });
  } else if (mode === 'unrelated-error') {
    guard = emulatedGuard(browser, {
      fail: (method, params) =>
        protectedCommand(method, params, targets) ? 'Internal error' : undefined,
    });
  } else if (mode === 'clear') {
    guard = { client: clearingStockClient(browser, targets), stop: async () => {} };
  } else {
    guard = { client: browser.client, stop: async () => {} };
  }
  record(unguarded);
  record(guard.client);
  try {
    const execution = await run(
      { ...set, vectors, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded,
        fixture,
        targets,
        capabilities: stockCaps,
        rowTimeoutMs: 90000,
      }
    );
    return { execution, client: guard.client, targets };
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
}

function mainFrameBlocked(client, match) {
  return client.events.some(
    (event) =>
      event.method === 'Page.frameNavigated' &&
      !event.params?.frame?.parentId &&
      event.params?.frame?.url?.startsWith('chrome-error://') &&
      match(event.params.frame.unreachableUrl ?? '')
  );
}

test('a guard that refuses the main-frame protected navigation passes the three carry rows live', {
  timeout: 600000,
}, async () => {
  const { execution, client, targets } = await runCarry('refuse-nav');
  assert.equal(execution.results.length, carryIds.length * 2);
  assert.equal(
    client.events.some((event) => event.method?.startsWith('Network.')),
    false
  );
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    const origin = targets[row.target];
    const match =
      row.id === 'E7.init-world-bfcache'
        ? (url) => url.startsWith(`${origin}/bfcache?`) && /[?&]n=[^&]*-p(?:&|$)/.test(url)
        : (url) => url.startsWith(`${origin}/doc?`);
    assert.equal(
      mainFrameBlocked(client, match),
      true,
      JSON.stringify({ id: row.id, target: row.target })
    );
  }
});

test('a guard that loads the protected document and keeps admitted state fails the three carry rows', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('keep');
  for (const row of execution.results.filter((item) => item.target !== 'ordinary')) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
  }
});

test('a guard that clears admitted state before the protected document runs passes the three carry rows', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('clear');
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
  }
});

const effectLieIds = [
  ...carryIds,
  'E7.isolated-foreign',
  'C3.tab-protected',
  'C3.tab-protected.synthetic',
];
const effectLieVectors = set.vectors.filter((vector) => effectLieIds.includes(vector.id));

test('a guard that refuses the protected navigate or createTarget command passes those rows', {
  timeout: 900000,
}, async () => {
  const { execution } = await runCarry('refuse-command', { vectors: commandNavVectors });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
  }
});

test('a correct refusal of the protected command still passes the effect-checked rows', {
  timeout: 900000,
}, async () => {
  const { execution } = await runCarry('refuse-command', { vectors: effectLieVectors });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
  }
});

test('a guard that replies with a refusal but still forwards the protected command fails those rows', {
  timeout: 900000,
}, async () => {
  const { execution } = await runCarry('lying-refuse', { vectors: effectLieVectors });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
  }
});

const isolatedForeignScript = set.vectors.filter(
  (vector) => vector.id === 'E7.isolated-foreign.script'
);

test('a correct refusal of createIsolatedWorld passes E7.isolated-foreign.script', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('refuse-world', { vectors: isolatedForeignScript });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
  }
});

test('a guard that fails the protected document without a load passes E7.isolated-foreign.script', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('fail-document-refuse-world', {
    vectors: isolatedForeignScript,
  });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
  }
});

test('a guard that loads the protected document and admits the foreign world fails E7.isolated-foreign.script', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('keep', { vectors: isolatedForeignScript });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.observations.guarded.world, true, JSON.stringify(row));
  }
});

test('a guard that forwards createIsolatedWorld but replies refused fails E7.isolated-foreign.script', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('lying-refuse-world', { vectors: isolatedForeignScript });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.equal(row.observations.guarded.world, true, JSON.stringify(row));
  }
});

const emulationCarry = set.vectors.filter((vector) => vector.id === 'E7.emulation-carry');
const emulationCarryScript = set.vectors.filter(
  (vector) => vector.id === 'E7.emulation-carry.script'
);

test('a late-commit lying refusal still fails E7.emulation-carry after the navigation commits', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('late-lying-refuse', { vectors: emulationCarry });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
  }
});

test('a late-commit keep fails E7.emulation-carry.script while the delayed control still passes', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('late-keep', { vectors: emulationCarryScript });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
  }
});

test('E7.isolated-foreign.script control and a correct world refusal pass under a late document commit', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('late-refuse-world', { vectors: isolatedForeignScript });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
  }
});

test('a guard that refuses the command and blocks script navigation passes command and script carry rows', {
  timeout: 900000,
}, async () => {
  const { execution } = await runCarry('refuse-command-and-block-script', {
    vectors: [
      ...commandNavVectors.filter((vector) => carryIds.includes(vector.id)),
      ...carryScriptVectors,
    ],
  });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
  }
});

test('a guard that refuses the command but keeps admitted state on a script load fails the script variants', {
  timeout: 900000,
}, async () => {
  const { execution } = await runCarry('refuse-command-keep-script', {
    vectors: scriptAttackVectors,
  });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
  }
});

test('E7.init-world-error.script still proves the admitted world on the error page under a command refusal', {
  timeout: 600000,
}, async () => {
  const { execution } = await runCarry('refuse-command', { vectors: errorScriptVectors });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
  }
});

test('a guard that fails the protected navigate without a matched refusal fails the command rows', {
  timeout: 900000,
}, async () => {
  const { execution } = await runCarry('unrelated-error', {
    vectors: carryVectors,
  });
  for (const row of execution.results) {
    const control = row.observations.control;
    assert.equal(control.loaded, true, JSON.stringify(row));
    if (row.id === 'E7.emulation-carry') assert.equal(control.exposed, true, JSON.stringify(row));
    else assert.equal(control.worldOnProtected, true, JSON.stringify(row));
    assert.equal(row.guarded, 'fail', JSON.stringify(row));
    assert.ok(
      row.errors.some((error) => /failed without a refusal/.test(error)),
      JSON.stringify(row)
    );
  }
});

test('clear-then-load still passes command and script carry rows', {
  timeout: 900000,
}, async () => {
  const { execution } = await runCarry('clear', {
    vectors: [...carryVectors, ...carryScriptVectors],
  });
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'pass', JSON.stringify(row));
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
  }
});

test('a blocked event for the wrong URL does not satisfy carry live', {
  timeout: 600000,
}, async () => {
  const source = carryVectors.find((vector) => vector.id === 'E7.init-world-bfcache');
  const url = '{target}/bfcache?n={tag}-p';
  const only = [
    {
      ...structuredClone(source),
      liveCheck: {
        all: [
          { pre: url, observer: 'fixture' },
          {
            blocked: { url, session: 'page', frame: false },
            observer: 'client',
          },
        ],
        observer: 'client',
      },
    },
  ];
  const { execution } = await runCarry('wrong-url', {
    vectors: only,
    rewrite: (value) =>
      value.includes('/bfcache?')
        ? value.replace(/-p(?=$|[&#])/, '-b')
        : value.replace(/\/doc\?/, '/other?'),
  });
  assert.ok(execution.results.length >= 2);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.equal(row.live, 'fail', JSON.stringify(row));
  }
});

function sideChannelGuard(browser, targets, mode) {
  const protectedOrigins = new Set(
    [targets.seven, targets.vault].map((origin) => new URL(origin).origin)
  );
  const raw = browser.client;
  const mainFrame = new Map();
  const events = [];
  const messages = [];
  const forwarded = [];
  let cursor = 0;
  let stopped = false;
  const decide = async (event) => {
    const frameId = event.params.frameId;
    const main = mainFrame.get(event.sessionId);
    const url = event.params.request?.url ?? '';
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = undefined;
    }
    if (!origin || !protectedOrigins.has(origin)) {
      await raw
        .send('Fetch.continueRequest', { requestId: event.params.requestId }, event.sessionId)
        .catch(() => {});
      return;
    }
    const resourceType = event.params.resourceType;
    const fail =
      mode === 'iframe'
        ? Boolean(main && frameId && frameId !== main)
        : resourceType === 'Fetch' || resourceType === 'XHR';
    if (fail)
      await raw
        .send(
          'Fetch.failRequest',
          { requestId: event.params.requestId, errorReason: 'BlockedByClient' },
          event.sessionId
        )
        .catch(() => {});
    else
      await raw
        .send('Fetch.continueRequest', { requestId: event.params.requestId }, event.sessionId)
        .catch(() => {});
  };
  const watch = (async () => {
    while (!stopped) {
      for (const event of raw.events.slice(cursor)) {
        cursor++;
        if (event.method === 'Fetch.requestPaused' || event.method === 'Fetch.authRequired') {
          await decide(event);
          continue;
        }
        events.push(event);
        messages.push(JSON.stringify(event));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const send = async (method, params = {}, sessionId) => {
    forwarded.push({ method, params, sessionId, sentAt: Date.now() });
    if (
      method === 'Page.navigate' &&
      params?.url &&
      protectedOrigins.has(new URL(params.url).origin)
    ) {
      await raw
        .send(
          'Fetch.enable',
          {
            patterns: [
              { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
              { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' },
              { urlPattern: '*', resourceType: 'XHR', requestStage: 'Request' },
            ],
          },
          sessionId
        )
        .catch(() => {});
      const tree = await raw.send('Page.getFrameTree', {}, sessionId);
      mainFrame.set(sessionId, tree.frameTree.frame.id);
      const target = JSON.stringify(params.url);
      const expression =
        mode === 'iframe'
          ? `(() => { const i = document.createElement('iframe'); i.src = ${target}; document.body.appendChild(i); return true; })()`
          : `fetch(${target}).catch(() => false)`;
      await raw.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      return { frameId: tree.frameTree.frame.id, loaderId: `${mode}-only` };
    }
    const reply = await raw.send(method, params, sessionId);
    messages.push(JSON.stringify({ id: messages.length + 1, result: reply, sessionId }));
    return reply;
  };
  return {
    client: { ...raw, events, messages, forwarded, send },
    stop: async () => {
      stopped = true;
      await watch;
    },
  };
}

async function runSideChannel(mode) {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.unguarded);
  const targets = origins(fixture);
  const only = carryVectors.filter((vector) => vector.id !== 'E7.init-world-bfcache');
  const stripped = only.map((vector) => {
    const copy = structuredClone(vector);
    const url = '{target}/doc?n={tag}';
    copy.liveCheck = {
      all: [
        { pre: url, observer: 'fixture' },
        {
          any: [
            {
              blocked: { url, session: 'page', frame: false },
              observer: 'client',
            },
            {
              blocked: { url, session: 'page', frame: false },
              observer: 'unguarded',
            },
          ],
          observer: 'client',
        },
      ],
      observer: 'client',
    };
    return copy;
  });
  const guard = sideChannelGuard(browser, targets, mode);
  record(guard.client);
  try {
    return await run(
      { ...set, vectors: stripped, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets,
        capabilities: stockCaps,
        rowTimeoutMs: 90000,
      }
    );
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
}

test('an iframe-only block of the protected URL does not satisfy carry live', {
  timeout: 600000,
}, async () => {
  const execution = await runSideChannel('iframe');
  assert.ok(execution.results.length >= 2);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.notEqual(row.live, 'pass', JSON.stringify(row));
  }
});

test('a fetch-only block of the protected URL does not satisfy carry live', {
  timeout: 600000,
}, async () => {
  const execution = await runSideChannel('fetch');
  assert.ok(execution.results.length >= 2);
  for (const row of execution.results) {
    assert.equal(row.control, 'pass', JSON.stringify(row));
    assert.notEqual(row.live, 'pass', JSON.stringify(row));
  }
});

function secondTabGuard(browser, targets) {
  const protectedOrigins = new Set(
    [targets.seven, targets.vault].map((origin) => new URL(origin).origin)
  );
  const raw = browser.client;
  const events = [];
  const messages = [];
  const forwarded = [];
  const otherSessions = new Set();
  let cursor = 0;
  let stopped = false;
  const decide = async (event) => {
    if (!otherSessions.has(event.sessionId)) {
      await raw
        .send('Fetch.continueRequest', { requestId: event.params.requestId }, event.sessionId)
        .catch(() => {});
      return;
    }
    const url = event.params.request?.url ?? '';
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = undefined;
    }
    if (origin && protectedOrigins.has(origin) && event.params.resourceType === 'Document')
      await raw
        .send(
          'Fetch.failRequest',
          { requestId: event.params.requestId, errorReason: 'BlockedByClient' },
          event.sessionId
        )
        .catch(() => {});
    else
      await raw
        .send('Fetch.continueRequest', { requestId: event.params.requestId }, event.sessionId)
        .catch(() => {});
  };
  const watch = (async () => {
    while (!stopped) {
      for (const event of raw.events.slice(cursor)) {
        cursor++;
        if (event.method === 'Fetch.requestPaused' || event.method === 'Fetch.authRequired') {
          await decide(event);
          continue;
        }
        events.push(event);
        messages.push(JSON.stringify(event));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const send = async (method, params = {}, sessionId) => {
    forwarded.push({ method, params, sessionId, sentAt: Date.now() });
    if (
      method === 'Page.navigate' &&
      params?.url &&
      protectedOrigins.has(new URL(params.url).origin)
    ) {
      const { targetId } = await raw.send('Target.createTarget', {
        url: 'about:blank',
        background: true,
      });
      const { sessionId: other } = await raw.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      otherSessions.add(other);
      await raw.send('Page.enable', {}, other);
      await raw.send(
        'Fetch.enable',
        {
          patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
        },
        other
      );
      await raw.send('Page.navigate', { url: params.url }, other).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
      const tree = await raw.send('Page.getFrameTree', {}, sessionId);
      return { frameId: tree.frameTree.frame.id, loaderId: 'second-tab' };
    }
    const reply = await raw.send(method, params, sessionId);
    messages.push(JSON.stringify({ id: messages.length + 1, result: reply, sessionId }));
    return reply;
  };
  return {
    client: { ...raw, events, messages, forwarded, send },
    stop: async () => {
      stopped = true;
      await watch;
    },
  };
}

test('a block on a second tab does not satisfy carry live', {
  timeout: 600000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.unguarded);
  const targets = origins(fixture);
  const only = carryVectors.filter((vector) => vector.id === 'E7.init-world-carry');
  const stripped = only.map((vector) => {
    const copy = structuredClone(vector);
    const url = '{target}/doc?n={tag}';
    copy.liveCheck = {
      all: [
        { pre: url, observer: 'fixture' },
        {
          any: [
            {
              blocked: { url, session: 'page', frame: false },
              observer: 'client',
            },
            {
              blocked: { url, session: 'page', frame: false },
              observer: 'unguarded',
            },
          ],
          observer: 'client',
        },
      ],
      observer: 'client',
    };
    return copy;
  });
  const guard = secondTabGuard(browser, targets);
  record(guard.client);
  try {
    const execution = await run(
      { ...set, vectors: stripped, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets,
        capabilities: stockCaps,
        rowTimeoutMs: 90000,
      }
    );
    assert.ok(execution.results.length >= 2);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.notEqual(row.live, 'pass', JSON.stringify(row));
    }
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});

test('a refuse-all reference passes every E7 stock-setup attack row', {
  timeout: 900000,
}, async () => {
  const fixture = await fixtureServer();
  const browser = await launch(fixture);
  record(browser.client);
  record(browser.unguarded);
  const guard = emulatedGuard(browser, {
    refuse: (method) => attackStock.has(method),
  });
  const e7 = attackVectors.filter((vector) => vector.id.startsWith('E7.'));
  try {
    const execution = await run(
      { ...set, vectors: e7, variants: { prompt: 0 } },
      {
        client: guard.client,
        unguarded: browser.unguarded,
        fixture,
        targets: origins(fixture),
        capabilities: stockCaps,
        rowTimeoutMs: 90000,
      }
    );
    for (const row of execution.results)
      assert.deepEqual(
        [row.control, row.guarded, row.live],
        ['pass', 'pass', 'pass'],
        JSON.stringify(row)
      );
  } finally {
    await guard.stop();
    await browser.close();
    await fixture.close();
  }
});
