import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureServer } from '../../fixture-server.mjs';
import { summary as driverSummary } from '../../guard-driver.mjs';
import { run } from '../../guard-runner.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const published = await readFile(join(root, 'guard-vectors.json'), 'utf8');
const set = JSON.parse(published);
const storageRows = ['C6.read-cookies', 'C6.storage-getCookies', 'C6.write-cookies'];
const storageCalls = {
  'C6.read-cookies': 'storage',
  'C6.storage-getCookies': 'call',
  'C6.write-cookies': 'storageSet',
};
const storageMethod = (id) =>
  id === 'C6.write-cookies' ? 'Storage.setCookies' : 'Storage.getCookies';
const targets = ['seven', 'vault', 'vault-x', 'apex'];
const protectedHost = (host) => host === 'sliccy.ai' || host.endsWith('.sliccy.ai');
const hostOf = (url) => new URL(url).hostname;
const bare = (domain) => domain.replace(/^\./, '');
const domainMatch = (host, domain) => host === bare(domain) || host.endsWith(`.${bare(domain)}`);
const refused = () => new Error('slicc: refused: protected origin');

function storageBrowser({
  browserStorage = false,
  fail = () => undefined,
  empty = () => false,
} = {}) {
  const pages = new Map();
  const sessions = new Map();
  const own = new Set();
  let jar = [];
  let next = 0;
  let tabs = 0;
  const sent = [];
  const contextOf = (params, sessionId) =>
    params.browserContextId ??
    (sessionId ? (pages.get(sessions.get(sessionId))?.context ?? 'default') : 'default');
  const cookieOf = (c, context) => ({
    name: c.name,
    value: c.value,
    domain: c.url ? hostOf(c.url) : `.${bare(c.domain)}`,
    path: c.path ?? '/',
    context,
  });
  const shown = (guarded, cookies) =>
    cookies
      .filter((c) => !guarded || !protectedHost(bare(c.domain)))
      .map(({ context: _context, ...c }) => c);
  const add = (guarded, list, context) => {
    const cookies = list.map((c) => cookieOf(c, context));
    if (guarded && cookies.some((c) => protectedHost(bare(c.domain)))) throw refused();
    for (const c of cookies) {
      jar = jar.filter(
        (o) => !(o.context === context && o.name === c.name && bare(o.domain) === bare(c.domain))
      );
      jar.push(c);
    }
  };
  const handle = (guarded, method, params, sessionId) => {
    if (method === 'Target.createBrowserContext') {
      const browserContextId = `CTX${++next}`;
      if (guarded) own.add(browserContextId);
      return { browserContextId };
    }
    if (method === 'Target.createTarget') {
      const targetId = `T${++next}`;
      pages.set(targetId, { url: params.url, context: params.browserContextId ?? 'default' });
      return { targetId };
    }
    if (method === 'Target.attachToTarget') {
      const id = `S${++next}`;
      sessions.set(id, params.targetId);
      return { sessionId: id };
    }
    if (method === 'Target.getTargets')
      return {
        targetInfos: [...pages].map(([targetId, p]) => ({ targetId, type: 'page', url: p.url })),
      };
    if (method === 'Target.getTargetInfo') {
      const url = pages.get(params.targetId)?.url ?? '';
      return { targetInfo: { targetId: params.targetId, type: 'page', url, title: url } };
    }
    if (method === 'Target.closeTarget') return { success: true };
    const context = contextOf(params, sessionId);
    const kept = jar.filter((c) => c.context === context);
    if (method === 'Storage.setCookies' || method === 'Network.setCookies') {
      add(guarded, params.cookies, context);
      return {};
    }
    if (method === 'Network.setCookie') {
      add(guarded, [params], context);
      return { success: true };
    }
    if (method === 'Storage.getCookies' || method === 'Network.getAllCookies')
      return { cookies: shown(guarded, kept) };
    if (method === 'Network.getCookies') {
      const hosts = (params.urls ?? []).map(hostOf);
      const matched = kept.filter((c) => hosts.some((host) => domainMatch(host, c.domain)));
      return { cookies: shown(guarded, matched) };
    }
    if (method === 'Network.deleteCookies') {
      const host = params.url ? hostOf(params.url) : bare(params.domain);
      if (guarded && protectedHost(host)) throw refused();
      jar = jar.filter(
        (c) => !(c.context === context && c.name === params.name && domainMatch(host, c.domain))
      );
      return {};
    }
    if (method === 'Network.clearBrowserCookies' && guarded) throw refused();
    if (method === 'Storage.clearCookies') {
      if (guarded && !own.has(params.browserContextId)) throw refused();
      jar = jar.filter((c) => c.context !== context);
      return {};
    }
    if (method === 'Page.navigate') {
      const page = pages.get(sessions.get(sessionId));
      if (page) page.url = params.url;
      return { frameId: 'F' };
    }
    if (method === 'Page.getFrameTree') {
      const url = pages.get(sessions.get(sessionId))?.url ?? 'about:blank';
      return { frameTree: { frame: { id: 'F', loaderId: 'L', url } } };
    }
    if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'complete' } };
    return {};
  };
  const make = (guarded) => ({
    events: [],
    messages: [],
    async send(method, params = {}, sessionId) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (!guarded) return handle(false, method, params, sessionId);
      if (method === 'Target.createTarget') tabs++;
      const leg = tabs % 2 === 1 ? 'control' : 'guarded';
      sent.push({ method, sessionId, leg });
      const injected = fail(method, leg);
      if (injected) throw new Error(injected);
      const answered =
        sessionId !== undefined ||
        /^(Target|Browser)\./.test(method) ||
        (browserStorage && /^Storage\./.test(method));
      if (!answered)
        throw Object.assign(new Error(`'${method}' wasn't found`), {
          cdp: { code: -32601, message: `'${method}' wasn't found` },
        });
      if (empty(method, leg)) return { cookies: [] };
      return handle(true, method, params, sessionId);
    },
    waitEvent: () => new Promise(() => {}),
  });
  return { client: make(true), unguarded: make(false), sent };
}

async function execute(ids, browser, capabilities, runner = run) {
  const fixture = await fixtureServer();
  try {
    const origin = (host) => `http://${host}:${fixture.port}`;
    return await runner(
      { ...set, vectors: set.vectors.filter((v) => ids.includes(v.id)), variants: { prompt: 0 } },
      {
        client: browser.client,
        unguarded: browser.unguarded,
        fixture,
        capabilities,
        settleScale: 0.05,
        targets: {
          ordinary: origin('ordinary.example.test'),
          plain: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          'vault-x': origin('vault-x.sliccy.ai'),
          apex: origin('sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
  } finally {
    await fixture.close();
  }
}

const rows = async (ids, browser, capabilities, runner = run) =>
  (await execute(ids, browser, capabilities, runner)).results;

const dirs = [];
test.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function mutant(file, change) {
  const here = new URL(`../../${file}`, import.meta.url);
  const source = await readFile(here, 'utf8');
  const changed = change(source);
  assert.notEqual(changed, source, `mutation did not apply to ${file}`);
  const dir = await mkdtemp(join(tmpdir(), 'browser-storage-'));
  dirs.push(dir);
  const path = join(dir, file);
  await writeFile(
    path,
    changed.replaceAll(/from '\.\/([^']+)'/g, (_, name) => `from '${new URL(name, here).href}'`)
  );
  return import(pathToFileURL(path).href);
}

const swap = (from, to) => (source) => {
  assert.equal(source.split(from).length, 2, `mutation anchor not unique: ${from}`);
  return source.replace(from, () => to);
};

const statuses = (row) => [row.control, row.guarded, row.live];

function storageSessions(browser, id) {
  const method = storageMethod(id);
  return browser.sent.filter((call) => call.method === method).map((call) => call.sessionId);
}

test('a transport that declares browserSession alone runs the C6 storage rows on the page session', async () => {
  for (const id of storageRows) {
    const browser = storageBrowser();
    const results = await rows([id], browser, { browserSession: true });
    assert.deepEqual(
      results.map((row) => row.target),
      targets
    );
    for (const row of results) {
      assert.deepEqual(statuses(row), ['pass', 'pass', 'pass'], JSON.stringify(row));
      const call = storageCalls[id];
      assert.ok(
        row.notes.includes(`control ${call}: ${storageMethod(id)} ran on the page session`),
        JSON.stringify(row.notes)
      );
      assert.ok(
        row.notes.some(
          (note) =>
            note.startsWith(`guarded ${call}: `) && note.endsWith(' ran on the page session')
        ),
        JSON.stringify(row.notes)
      );
    }
    const used = storageSessions(browser, id);
    assert.equal(used.length, 8);
    assert.ok(used.every((session) => session !== undefined));
  }
});

test('a transport that declares browserStorage runs the C6 storage rows on the browser session', async () => {
  for (const id of storageRows) {
    const browser = storageBrowser({ browserStorage: true });
    const results = await rows([id], browser, { browserSession: true, browserStorage: true });
    assert.equal(results.length, 4);
    for (const row of results) {
      assert.deepEqual(statuses(row), ['pass', 'pass', 'pass'], JSON.stringify(row));
      assert.ok(
        row.notes.some(
          (note) => note.startsWith('control ') && note.endsWith(' ran on the browser session')
        ),
        JSON.stringify(row.notes)
      );
    }
    const used = storageSessions(browser, id);
    assert.equal(used.length, 8);
    assert.ok(used.every((session) => session === undefined));
  }
});

const routedOnBrowserSession = swap(
  "supported(['browserStorage'], this.options.capabilities) &&",
  "supported(['browserSession'], this.options.capabilities) &&"
);

test('mutant: routing the C6 storage rows on browserSession sends them to a browser session without Storage.*', async () => {
  const mod = await mutant('guard-runner.mjs', routedOnBrowserSession);
  for (const id of storageRows) {
    const browser = storageBrowser();
    const results = await rows([id], browser, { browserSession: true }, mod.run);
    for (const row of results) assert.notEqual(row.control, 'pass', JSON.stringify(row));
    assert.ok(storageSessions(browser, id).every((session) => session === undefined));
  }
});

test('a declared browserStorage the browser session lacks leaves the control incomplete with the error text', async () => {
  for (const id of storageRows) {
    const browser = storageBrowser();
    const results = await rows([id], browser, { browserSession: true, browserStorage: true });
    assert.ok(storageSessions(browser, id).every((session) => session === undefined));
    const call = storageCalls[id];
    const method = storageMethod(id);
    for (const row of results) {
      assert.equal(row.control, 'incomplete', JSON.stringify(row));
      assert.ok(
        row.incomplete.includes(
          `control ${call} failed without a refusal: '${method}' wasn't found`
        ),
        JSON.stringify(row.incomplete)
      );
      assert.match(row.why, new RegExp(`incomplete: control ${call} failed without a refusal`));
    }
  }
});

const controlError = (method) => (sent, leg) =>
  leg === 'control' && sent === method ? 'Internal error' : undefined;

test('a control transport error on a C6 storage call is incomplete with the error text, not a failure', async () => {
  for (const id of storageRows) {
    const method = storageMethod(id);
    const results = await rows([id], storageBrowser({ fail: controlError(method) }), {
      browserSession: true,
    });
    for (const row of results) {
      assert.deepEqual(statuses(row), ['incomplete', 'pass', 'pass'], JSON.stringify(row));
      assert.deepEqual(row.errors, []);
      assert.deepEqual(row.incomplete, [
        `control ${storageCalls[id]} failed without a refusal: Internal error`,
      ]);
    }
  }
});

test('a control transport error on a Network cookie read of a C6 row is incomplete too', async () => {
  const results = await rows(
    ['C6.read-cookies'],
    storageBrowser({ fail: controlError('Network.getAllCookies') }),
    { browserSession: true }
  );
  for (const row of results) {
    assert.deepEqual(statuses(row), ['incomplete', 'pass', 'pass'], JSON.stringify(row));
    assert.deepEqual(row.incomplete, ['control all failed without a refusal: Internal error']);
  }
});

const emptied = (method) => (sent, leg) => leg === 'control' && sent === method;

async function failsWithoutFailedCall(runner) {
  for (const id of ['C6.read-cookies', 'C6.storage-getCookies']) {
    const results = await rows(
      [id],
      storageBrowser({ empty: emptied('Storage.getCookies') }),
      { browserSession: true },
      runner
    );
    assert.equal(results.length, 4);
    for (const row of results) {
      assert.equal(row.control, 'fail', JSON.stringify(row));
      assert.deepEqual(row.errors, [], JSON.stringify(row));
      assert.ok(
        !(row.incomplete ?? []).some((reason) => reason.includes('failed without a refusal')),
        JSON.stringify(row)
      );
    }
  }
}

test('a control observation that reads false without a failed call still fails the C6 row', async () => {
  await failsWithoutFailedCall(run);
});

const withoutFailedCall = {
  'a failedCalls that counts calls that succeeded': swap(
    'out.ok || this.refused[name] === true',
    'this.refused[name] === true'
  ),
  'a control error rule that fires without a failed call': (source) =>
    swap('      if (!call) continue;\n', '')(swap('    if (!failed.size) return;\n', '')(source)),
};

for (const [name, change] of Object.entries(withoutFailedCall))
  test(`mutant: ${name} makes a false control read incomplete`, async () => {
    const mod = await mutant('guard-runner.mjs', change);
    await assert.rejects(failsWithoutFailedCall(mod.run), assert.AssertionError);
  });

const undeclaredNote =
  'browserStorage undeclared: page-or-browser Storage.getCookies, Storage.setCookies and Storage.clearCookies steps ran on the page session, not the browser session';

const summaryCases = [
  [{ browserSession: true }, false, true],
  [['browserSession', 'browserContexts'], false, true],
  [{ browserSession: true, browserStorage: true }, true, false],
  [['browserSession', 'browserStorage'], true, false],
  [{}, false, false],
  [['browserContexts'], false, false],
];

async function namesUndeclared(runner) {
  for (const [capabilities, browserStorage, named] of summaryCases) {
    const execution = await execute(
      ['C6.storage-getCookies'],
      storageBrowser({ browserStorage }),
      capabilities,
      runner
    );
    const value = execution.summary({ guard: 'reference', sha: 'test' });
    const label = JSON.stringify(capabilities);
    assert.equal(value.pass, true, label);
    if (named) {
      assert.equal(value.browserStorageUndeclared, true, label);
      assert.equal(value.browserStorageNote, undeclaredNote, label);
    } else {
      assert.equal(Object.hasOwn(value, 'browserStorageUndeclared'), false, label);
      assert.equal(Object.hasOwn(value, 'browserStorageNote'), false, label);
    }
  }
}

test('the summary names browserStorage undeclared only when browserSession is declared without it', async () => {
  await namesUndeclared(run);
});

const undeclaredAnchor = "declared('browserSession', caps) && !declared('browserStorage', caps);";

for (const [name, to] of [
  ['always names', 'true;'],
  ['never names', 'false;'],
])
  test(`mutant: a summary that ${name} browserStorage undeclared fails`, async () => {
    const mod = await mutant('guard-runner.mjs', swap(undeclaredAnchor, to));
    await assert.rejects(namesUndeclared(mod.run), assert.AssertionError);
  });

const clearCapabilities = { browserSession: true, browserContexts: true, browserStorage: true };

test('C6.clear-cookies runs with browserStorage and its control clears the created context on the browser session', async () => {
  const browser = storageBrowser({ browserStorage: true });
  const results = await rows(['C6.clear-cookies'], browser, clearCapabilities);
  assert.equal(results.length, 4);
  for (const row of results)
    assert.deepEqual(statuses(row), ['pass', 'pass', 'pass'], JSON.stringify(row));
  const clears = browser.sent.filter((call) => call.method === 'Storage.clearCookies');
  assert.equal(clears.length, 8);
  assert.ok(clears.every((call) => call.sessionId === undefined));
});

test('C6.clear-cookies is not supported without browserStorage, and a page-only transport is never asked', async () => {
  const browser = storageBrowser();
  for (const capabilities of [
    { browserSession: true, browserContexts: true },
    ['browserSession', 'browserContexts'],
  ]) {
    const results = await rows(['C6.clear-cookies'], browser, capabilities);
    for (const row of results) {
      assert.deepEqual(statuses(row), ['skip', 'skip', 'skip']);
      assert.equal(row.reason, 'not-supported:browserStorage');
    }
  }
  assert.deepEqual(browser.sent, []);
});

test('a refusable control step that fails without a refusal is incomplete with the error text', async () => {
  const results = await rows(
    ['C6.clear-cookies'],
    storageBrowser({ browserStorage: true, fail: controlError('Network.clearBrowserCookies') }),
    clearCapabilities
  );
  for (const row of results) {
    assert.deepEqual(statuses(row), ['incomplete', 'pass', 'pass'], JSON.stringify(row));
    assert.deepEqual(row.errors, []);
    assert.deepEqual(row.incomplete, ['control network failed without a refusal: Internal error']);
  }
});

const controlErrorsDropped = swap('    this.controlErrors(observed);\n', '');
const controlErrorsFail = swap(
  '    const failed = this.failedCalls();\n    this.unrun();\n',
  '    const failed = this.failedCalls();\n'
);

test('mutant: without the control error rule a control transport error fails the C6 row', async () => {
  const mod = await mutant('guard-runner.mjs', controlErrorsDropped);
  const results = await rows(
    ['C6.read-cookies'],
    storageBrowser({ fail: controlError('Storage.getCookies') }),
    { browserSession: true },
    mod.run
  );
  for (const row of results) assert.equal(row.control, 'fail', JSON.stringify(row));
});

test('mutant: a refusable control error kept as a row error fails both legs', async () => {
  const mod = await mutant('guard-runner.mjs', controlErrorsFail);
  const results = await rows(
    ['C6.clear-cookies'],
    storageBrowser({ browserStorage: true, fail: controlError('Network.clearBrowserCookies') }),
    clearCapabilities,
    mod.run
  );
  for (const row of results) {
    assert.deepEqual([row.control, row.guarded], ['fail', 'fail'], JSON.stringify(row));
    assert.deepEqual(row.errors, ['network failed without a refusal: Internal error']);
  }
});

test('the runner refuses browserStorage without browserSession', async () => {
  for (const capabilities of [{ browserStorage: true }, ['browserStorage', 'browserContexts']])
    await assert.rejects(
      rows(storageRows, storageBrowser(), capabilities),
      /browserStorage needs browserSession in one run/
    );
});

test('mutant: a runner without that check runs a browserStorage-only declaration', async () => {
  const mod = await mutant(
    'guard-runner.mjs',
    swap("throw new TypeError('browserStorage needs browserSession in one run');", 'void 0;')
  );
  const results = await rows(
    ['C6.read-cookies'],
    storageBrowser(),
    { browserStorage: true },
    mod.run
  );
  assert.equal(results.length, 4);
});

const byId = (id) => set.vectors.find((v) => v.id === id);
const sessionRow = set.vectors.find(
  (v) => v.id.startsWith('C3.') && (v.requires ?? []).includes('browserSession')
);
const skipped = (vector, reason) =>
  Object.keys(set.variants).flatMap((variant) =>
    vector.targets.map((target) => ({
      id: vector.id,
      target,
      variant,
      transport: 'cdp',
      control: 'skip',
      guarded: 'skip',
      live: 'skip',
      reason,
    }))
  );
const report = (vector, reason, capabilities, summary = driverSummary, vectors = [vector]) =>
  summary({
    guard: 'reference',
    sha: 'test',
    set: { ...set, vectors },
    results: skipped(vector, reason),
    capabilities,
  });

test('genuine browserSession and browserStorage skips are not forged', () => {
  const cases = [
    [
      byId('C6.clear-cookies'),
      'not-supported:browserStorage',
      ['browserSession', 'browserContexts'],
    ],
    [byId('C6.clear-cookies'), 'not-supported:browserSession', ['browserContexts']],
    [sessionRow, 'not-supported:browserSession', []],
    [byId('C6.read-cookies'), 'not-supported:browserSession', { browserContexts: true }],
  ];
  for (const [vector, reason, capabilities] of cases) {
    const value = report(vector, reason, capabilities);
    assert.deepEqual(value.forged, [], `${vector.id} ${reason}`);
    assert.equal(value.pass, true, `${vector.id} ${reason}`);
  }
});

const forgedCases = [
  [sessionRow, 'browserStorage', ['browserSession'], 'on a row that does not need browserStorage'],
  [
    byId('C6.read-cookies'),
    'browserStorage',
    ['browserSession'],
    'on a row that does not need browserStorage',
  ],
  [byId('C6.read-cookies'), 'browserSession', [], 'on a row that does not need browserSession'],
  [
    byId('C6.clear-cookies'),
    'browserSession',
    ['browserSession', 'browserContexts'],
    'while the run declared browserSession',
  ],
  [sessionRow, 'browserSession', ['browserSession'], 'while the run declared browserSession'],
  [
    byId('C6.clear-cookies'),
    'browserStorage',
    { browserSession: true, browserContexts: true, browserStorage: true },
    'while the run declared browserStorage',
  ],
];

test('a browserSession or browserStorage skip on a row of the other kind, or while declared, is forged', () => {
  for (const [vector, cap, capabilities, why] of forgedCases) {
    const value = report(vector, `not-supported:${cap}`, capabilities, driverSummary, set.vectors);
    assert.equal(value.pass, false, `${vector.id} ${cap}`);
    assert.equal(value.forged.length, vector.targets.length * Object.keys(set.variants).length);
    assert.ok(
      value.forged.every((row) => row.why === `skip with not-supported:${cap} ${why}`),
      JSON.stringify(value.forged)
    );
  }
});

test('mutant: a driver without the browser rules accepts the forged skips', async () => {
  const mod = await mutant(
    'guard-driver.mjs',
    swap(
      "    if (['browserSession', 'browserStorage'].includes(cap) && !needsBrowser(vector, cap, declared))\n      return `skip with not-supported:${cap} on a row that does not need ${cap}`;\n",
      ''
    )
  );
  for (const [vector, cap, capabilities, why] of forgedCases.filter(([, , , w]) =>
    w.startsWith('on a row')
  )) {
    const value = report(vector, `not-supported:${cap}`, capabilities, mod.summary, set.vectors);
    assert.deepEqual(value.forged, [], `${vector.id} ${cap} ${why}`);
  }
});

test('mutant: a driver that ignores a declared browserSession or browserStorage accepts the skip', async () => {
  const mod = await mutant(
    'guard-driver.mjs',
    swap(
      "['extensionFrame', 'explicitAttach', 'browserSession', 'browserStorage']",
      "['extensionFrame', 'explicitAttach']"
    )
  );
  const value = report(
    byId('C6.clear-cookies'),
    'not-supported:browserSession',
    ['browserSession', 'browserContexts'],
    mod.summary,
    set.vectors
  );
  assert.deepEqual(value.forged, []);
});

const skippedDirs = new Set([
  'node_modules',
  '.git',
  'target',
  'test',
  'artifacts',
  'coverage',
  'src',
]);
let copy;

async function validate(change) {
  if (!copy) {
    copy = await mkdtemp(join(tmpdir(), 'slicc-validate-storage-'));
    dirs.push(copy);
    await cp(root, copy, {
      recursive: true,
      filter: (source) => !skippedDirs.has(source.slice(root.length).split('/')[0]),
    });
    await symlink(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
  }
  const changed = JSON.parse(published);
  change((id) => changed.vectors.find((vector) => vector.id === id));
  await writeFile(join(copy, 'guard-vectors.json'), `${JSON.stringify(changed, null, 2)}\n`);
  return spawnSync(process.execPath, ['scripts/validate.mjs'], { cwd: copy, encoding: 'utf8' });
}

const clearStep = (vector) =>
  vector.trigger.find((step) => step.cdp === 'Storage.clearCookies' && step.on === 'control');

test('the browserStorage rows validate unchanged', async () => {
  const result = await validate(() => {});
  assert.equal(result.status, 0, result.stderr);
});

const broken = {
  'a step that requires browserStorage without browserSession': [
    (find) => {
      clearStep(find('C6.clear-cookies')).requires = ['browserStorage'];
    },
    /C6\.clear-cookies: browserStorage needs browserSession/,
  ],
  'a row that requires browserStorage without browserSession': [
    (find) => {
      const vector = find('C6.clear-cookies');
      vector.requires = vector.requires.filter((cap) => cap !== 'browserSession');
    },
    /C6\.clear-cookies: browserStorage needs browserSession/,
  ],
  'a page-or-browser Storage step with a browserContextId not gated on browserStorage': [
    (find) => {
      const vector = find('C6.clear-cookies');
      clearStep(vector).requires = ['browserSession'];
      vector.requires = vector.requires.filter((cap) => cap !== 'browserStorage');
    },
    /C6\.clear-cookies: a Storage\.clearCookies step doesn't require browserStorage/,
  ],
  'a guarded browser-session Storage step not gated on browserStorage': [
    (find) => {
      const vector = find('C6.read-cookies');
      vector.trigger.find((step) => step.as === 'storage').session = 'browser';
      vector.trigger.find((step) => step.as === 'storage').requires = ['browserSession'];
      vector.requires = ['browserSession'];
    },
    /C6\.read-cookies: a Storage\.getCookies step doesn't require browserStorage/,
  ],
};

for (const [name, [change, message]] of Object.entries(broken))
  test(`validate refuses ${name}`, async () => {
    const result = await validate(change);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr + result.stdout, message);
  });
