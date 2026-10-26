import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vectors = set.vectors.filter((vector) => vector.id === 'C8.unparseable');
const blocked = 'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E';
const refusal = "slicc: refused: target is on seven's origin";
const origin = (host) => `http://${host}:8123`;
const targets = {
  ordinary: origin('ordinary.example.test'),
  plain: origin('ordinary.example.test'),
  seven: origin('seven.sliccy.ai'),
  vault: origin('vault.sliccy.ai'),
  own: origin('client.example.test'),
  client: origin('client.example.test'),
  log: origin('log.example.test'),
};

const failure = (message) => Object.assign(new Error(message), { cdp: { code: -32000, message } });
const hostOf = (url) => /^https?:\/\/([^/?#]*)/.exec(url ?? '')?.[1]?.replace(/:\d*$/, '');
const seven = (url) => hostOf(url)?.endsWith('.sliccy.ai') ?? false;

function chrome(wipe) {
  const log = [];
  let cookies = [];
  const pages = new Map();
  const sessions = new Map();
  let next = 0;
  const jar = () => cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const load = (url) => {
    const host = hostOf(url);
    if (host === undefined) return { url, title: url, cookie: '' };
    const shown = host.replaceAll(' ', '%20');
    if (shown.endsWith('.sliccy.ai') && shown !== 'exa%20mple.sliccy.ai') return null;
    const href = url.replace(host, shown);
    const cookie = shown.endsWith('.sliccy.ai') ? jar() : '';
    log.push({ url: href, method: 'GET', headers: cookie ? { cookie } : {}, time: Date.now() });
    return { url: href, title: 'doc', cookie };
  };
  const info = (targetId) => {
    const page = pages.get(targetId);
    return { targetId, type: 'page', url: page.url, title: page.title, attached: false };
  };
  const evaluate = (page, expression) => {
    if (expression.startsWith('document.cookie.includes('))
      return page.cookie.includes(JSON.parse(expression.slice(25, -1)));
    if (expression.includes('document.title'))
      return { title: page.title, href: page.url, cookie: page.cookie };
    return 'complete';
  };
  const send = async (method, params = {}, sessionId) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const page = pages.get(sessions.get(sessionId));
    if (method === 'Storage.setCookies') {
      cookies.push(...params.cookies);
      return {};
    }
    if (method === 'Network.deleteCookies') {
      cookies = cookies.filter((cookie) => cookie.name !== params.name);
      return {};
    }
    if (method === 'Network.getCookies') return { cookies: params.urls.some(seven) ? cookies : [] };
    if (method === 'Browser.getVersion') return { product: 'FakeChrome/1' };
    if (method === 'Target.createTarget') {
      const loaded = load(params.url);
      if (!loaded && !hostOf(params.url).startsWith('xn--a.'))
        throw failure('Cannot create target: invalid URL');
      const targetId = `T${++next}`;
      pages.set(targetId, loaded ?? { url: wipe, title: 'blocked', cookie: '' });
      return { targetId };
    }
    if (method === 'Target.getTargetInfo') return { targetInfo: info(params.targetId) };
    if (method === 'Target.getTargets') return { targetInfos: [...pages.keys()].map(info) };
    if (method === 'Target.attachToTarget') {
      const id = `S${++next}`;
      sessions.set(id, params.targetId);
      return { sessionId: id };
    }
    if (method === 'Target.closeTarget') return { success: pages.delete(params.targetId) };
    if (method === 'Page.navigate') {
      const loaded = load(params.url);
      if (!loaded) return { frameId: 'F', errorText: 'net::ERR_INVALID_URL' };
      Object.assign(page, loaded);
      return { frameId: 'F' };
    }
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'F', loaderId: 'L', url: page.url } } };
    if (method === 'Runtime.evaluate')
      return { result: { type: 'object', value: evaluate(page, params.expression) } };
    return {};
  };
  const unguarded = { events: [], messages: [], send, waitEvent: () => new Promise(() => {}) };
  const guarded = {
    ...unguarded,
    events: [],
    messages: [],
    send: (method, params = {}, sessionId) => {
      const at = method === 'Target.attachToTarget' ? pages.get(params.targetId)?.url : params.url;
      if (seven(at) || (params.urls ?? []).some(seven)) return Promise.reject(failure(refusal));
      return send(method, params, sessionId);
    },
  };
  return { client: guarded, unguarded, fixture: { log: async () => log } };
}

async function row(wipe) {
  const evidence = {};
  const execution = await run(
    { ...set, vectors, variants: { prompt: 0 } },
    {
      ...chrome(wipe),
      targets,
      capabilities: {},
      rowTimeoutMs: 60000,
      debug: (entry) => {
        if (entry.calls?.unparseable?.result) evidence[entry.side] = entry.calls.unparseable.result;
      },
    }
  );
  return { result: execution.results[0], summary: execution.summary(), evidence };
}

test("a guard's blocked data: page on a tab Chrome could not load is a native rejection, not a missing document", async () => {
  const { result, summary, evidence } = await row(blocked);
  assert.equal(result.control, 'pass', JSON.stringify(result));
  assert.equal(result.guarded, 'pass', JSON.stringify(result));
  assert.equal(result.live, 'pass', JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.notSupported, ['listed']);
  assert.equal(summary.pass, true);
  const wiped = evidence.control.responses.find(({ input }) => input === 'xn--a.sliccy.ai');
  assert.equal(wiped.createOutcome, 'native-rejection', JSON.stringify(wiped));
  assert.equal(wiped.created.ok, true, JSON.stringify(wiped));
  for (const response of evidence.control.responses.filter(({ canonical }) =>
    canonical.startsWith('exa%20mple.')
  )) {
    assert.equal(response.createOutcome, 'document', JSON.stringify(response));
    assert.equal(response.navigateOutcome, 'document', JSON.stringify(response));
  }
  assert.ok(
    evidence.guarded.responses.every(
      ({ createOutcome, navigateOutcome }) =>
        createOutcome === 'guard-refusal' && navigateOutcome === 'guard-refusal'
    ),
    JSON.stringify(evidence.guarded.responses)
  );
});

test('only the exact blocked data: page counts: lookalikes, other data: pages and about:blank#blocked leave the document missing', async () => {
  const lookalikes = [
    'data:text/html,%3Ctitle%3Eblocked%3C%2Ftitle%3E%3Cscript%3E%3C%2Fscript%3E',
    'data:text/html,%3ctitle%3eblocked%3c%2ftitle%3e',
    'data:text/html,<title>blocked</title>',
    `${blocked}#blocked`,
    'data:text/html,blocked',
    'about:blank#blocked',
  ];
  const rows = await Promise.all(lookalikes.map(row));
  for (const [index, { result, summary }] of rows.entries()) {
    const page = lookalikes[index];
    assert.equal(result.control, 'fail', `${page}: ${JSON.stringify(result)}`);
    assert.equal(summary.pass, false, page);
    assert.ok(
      result.errors.some((error) =>
        /unparseable: Chrome did not load a fixture document at http:\/\/xn--a\.sliccy\.ai:8123\//.test(
          error
        )
      ),
      `${page}: ${JSON.stringify(result.errors)}`
    );
  }
});
