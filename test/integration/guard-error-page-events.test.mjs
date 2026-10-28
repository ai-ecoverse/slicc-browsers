import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';
import { chrome, quarantining } from './error-page-fake.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const vectors = set.vectors.filter((v) => v.trigger.some((s) => s.errorPage));
const every = vectors.map((v) => v.id);
const all = 'C8.protected-error-page';
const recover = [all, `${all}.query`, `${all}.fragment`];
const errorPage = 'chrome-error://chromewebdata/';
const failed = (info) => new URL(info.url);
const seven = (info) => failed(info).hostname === 'seven.sliccy.ai';
const originOnly = (info) => ({ ...info, url: failed(info).origin, title: failed(info).origin });
const onSeven = (shown) => (info) => (seven(info) ? shown(info) : info);
const bytes = (text) =>
  Array.from(new TextEncoder().encode(text), (byte) => `%${byte.toString(16)}`).join('');
const ownPage = (shown) => {
  const pages = new Map();
  return (info) => {
    if (seven(info)) return shown(info, pages.get(info.targetId));
    pages.set(info.targetId, info.url);
    return info;
  };
};
const legs = ['live', 'attached', 'infoRedacted', 'listRedacted', 'attachRedacted'];
const discoveryMethods = ['Target.targetCreated', 'Target.targetInfoChanged'];
const upper = (text) =>
  Array.from(
    new TextEncoder().encode(text),
    (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  ).join('');
const unschemed = (url) => url.replace(/^http:\/\//, '');
const trigger = (url, to) => `${url.origin}${url.pathname}?k=deferred&defer=0&to=${to}`;
const reduced =
  (keep, { encode = upper, title = (url) => unschemed(url) } = {}) =>
  (info) => {
    if (seven(info)) return originOnly(info);
    const page = URL.parse(info.url);
    const to = page?.searchParams.get('to');
    if (!to) return info;
    const url = trigger(page, encode(keep(new URL(to))));
    return { ...info, url, title: title(url, page, new URL(to)) };
  };
const undiscovered = (info, method) => (discoveryMethods.includes(method) ? [] : info);
const cut =
  (title, { url = (page) => page.origin } = {}) =>
  (info) => {
    if (seven(info)) return originOnly(info);
    const page = URL.parse(info.url);
    const to = page?.searchParams.get('to');
    return to ? { ...info, url: url(page), title: title(page, new URL(to)) } : info;
  };
const cutTo = (keep) => (page, to) => unschemed(trigger(page, keep(to)));
const bare = cutTo((to) => to.origin);

async function rows(ids, discovery, { observed, port, guarded = [] } = {}) {
  const fixture = await fixtureServer();
  try {
    const browser = chrome();
    const origin = (host) => `http://${host}:${port ?? fixture.port}`;
    const client = quarantining(browser, { discovery });
    guarded.push(client);
    return await run(
      { ...set, vectors: vectors.filter((v) => ids.includes(v.id)), variants: { prompt: 0 } },
      {
        client,
        unguarded: browser.connect(observed),
        fixture,
        settleScale: 0.1,
        capabilities: { discovery: true },
        targets: {
          ordinary: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
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

for (const [name, ids, discovery] of [
  [
    'masks the url and titles the tab with its host',
    every,
    onSeven((info) => ({ ...info, url: errorPage, title: failed(info).hostname })),
  ],
  ['shows the origin only', recover, undefined],
  [
    "masks the url and the title with Chrome's error page",
    recover,
    onSeven((info) => ({ ...info, url: errorPage, title: errorPage })),
  ],
  [
    'shows an empty url titled with the origin',
    recover,
    onSeven((info) => ({ ...info, url: '', title: failed(info).origin })),
  ],
  [
    'shows the origin titled with the host and port',
    recover,
    onSeven((info) => ({ ...info, url: failed(info).origin, title: failed(info).host })),
  ],
  [
    'shows the percent-encoded origin titled with the origin',
    recover,
    onSeven((info) => ({ ...info, url: upper(failed(info).origin), title: failed(info).origin })),
  ],
  [
    'leaves the url and the title out of one event and masks the next',
    recover,
    onSeven(({ url, title, ...info }) => [
      info,
      { ...info, url: errorPage, title: new URL(url).hostname },
    ]),
  ],
  [
    "shows the origin only after the client's own page was titled with its unescaped URL",
    recover,
    (info) =>
      seven(info)
        ? originOnly(info)
        : { ...info, title: decodeURIComponent(info.url.replace(/^http:\/\//, '')) },
  ],
  [
    "reduces the destination in the client's own page to the encoded origin and titles it with that URL",
    every,
    reduced((to) => to.origin),
  ],
  [
    "reduces the destination in the client's own page to the bare origin and keeps the page's title",
    recover,
    reduced((to) => to.origin, { encode: (to) => to, title: () => 'trigger' }),
  ],
  [
    "cuts the client's own page to its origin and titles it with its URL, the destination cut to the bare origin",
    every,
    cut(bare),
  ],
  [
    "cuts the client's own page to its origin and titles it with its URL, the destination cut to the encoded origin",
    recover,
    cut(cutTo((to) => upper(to.origin))),
  ],
  [
    "masks the client's own page and titles it with its URL, the destination cut to the bare origin",
    [all],
    cut(bare, { url: () => errorPage }),
  ],
  [
    "keeps the client's own page and titles it with its URL, the destination cut to the bare origin",
    recover,
    cut(bare, { url: (page) => page.href }),
  ],
  [
    "reduces the destination in the client's own page to the encoded origin after a tab",
    recover,
    reduced((to) => `\t${to.origin}`),
  ],
  [
    "reduces the destination in the client's own page to the bare origin after a control character",
    [all],
    reduced((to) => `\u0001${to.origin}`, { encode: (to) => to }),
  ],
  [
    "reduces the destination in the client's own page to the encoded origin and an accented path",
    recover,
    reduced((to) => `${to.origin}/\u00e9`),
  ],
  ['reports no event for the tab at all', every, () => []],
  ['reports nothing about the failed navigation', recover, onSeven(() => [])],
  [
    'leaves the url and the title out of every event',
    recover,
    onSeven(({ url, title, ...info }) => info),
  ],
  [
    "masks the client's own page and reports nothing about the failed navigation",
    [all],
    (info) => (seven(info) ? [] : { ...info, url: '', title: '' }),
  ],
  [
    "leaves the url and the title out of the client's own page and reports nothing about the failed navigation",
    [all],
    (info) => (seven(info) ? [] : (({ url, title, ...rest }) => rest)(info)),
  ],
])
  test(`a guard that ${name} in its discovery events during the error interval passes the error-page rows`, async () => {
    const execution = await rows(ids, discovery);
    assert.equal(execution.results.length, ids.length);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.deepEqual(row.errors, [], JSON.stringify(row));
      assert.equal(row.incomplete, undefined, JSON.stringify(row));
      assert.equal(row.observations.guarded.eventsRedacted, true, JSON.stringify(row));
      assert.equal(row.observations.control.eventsRedacted, false, JSON.stringify(row));
    }
    assert.equal(execution.summary().pass, true);
  });

for (const [name, ids, discovery] of [
  ['shows the failed URL', recover, (info) => info],
  [
    'shows the failed URL with a masked title',
    [all],
    onSeven((info) => ({ ...info, title: failed(info).hostname })),
  ],
  [
    'masks the url but titles the tab with the failed URL',
    [all],
    onSeven((info) => ({ ...info, url: errorPage, title: info.url })),
  ],
  [
    'puts the path in a masked url',
    [all],
    onSeven((info) => ({
      ...info,
      url: `chrome-error://chromewebdata${failed(info).pathname}`,
      title: '',
    })),
  ],
  [
    'puts the percent-encoded path in a masked url',
    [all],
    onSeven((info) => ({ ...info, url: `${errorPage}?p=${bytes(failed(info).pathname)}` })),
  ],
  [
    'titles a masked url with the host and the path',
    [all],
    onSeven((info) => ({
      ...info,
      url: errorPage,
      title: `${failed(info).host}${failed(info).pathname}`,
    })),
  ],
  [
    'titles a masked url with the query secret',
    [all, `${all}.query`],
    onSeven((info) => ({ ...info, url: errorPage, title: failed(info).search.slice(1) })),
  ],
  [
    "titles a masked url with the query secret's value alone",
    [all, `${all}.query`],
    onSeven((info) => ({
      ...info,
      url: errorPage,
      title: failed(info).searchParams.get('query-secret'),
    })),
  ],
  [
    "titles a masked url with the path's last segment and the query secret's value",
    [all],
    onSeven((info) => ({
      ...info,
      url: errorPage,
      title: `${failed(info).pathname.split('/').at(-1)} ${failed(info).searchParams.get('query-secret')}`,
    })),
  ],
  [
    'puts the fragment secret in a masked url',
    [all, `${all}.fragment`],
    onSeven((info) => ({ ...info, url: `${errorPage}${failed(info).hash}`, title: errorPage })),
  ],
  [
    'puts the encoded failed URL in a masked url',
    [all],
    onSeven((info) => ({ ...info, url: `${errorPage}?u=${encodeURIComponent(info.url)}` })),
  ],
  [
    'shows the origin with a trailing slash',
    [all],
    onSeven((info) => ({ ...info, url: `${failed(info).origin}/`, title: failed(info).origin })),
  ],
  [
    'shows an absent url, then the failed URL',
    [all],
    onSeven(({ url, title, ...info }) => [info, { ...info, url, title }]),
  ],
  [
    'shows an absent url, then the fragment secret in its title',
    [all, `${all}.fragment`],
    onSeven(({ url, title, ...info }) => [info, { ...info, title: new URL(url).hash }]),
  ],
  [
    "shows the client's own page titled with the failed URL, then masks the url",
    [all],
    ownPage((info, page) => [
      { ...info, url: page, title: info.url },
      { ...info, url: errorPage, title: failed(info).hostname },
    ]),
  ],
  [
    "leaves the url out of the client's own page, keeps its title, which carries the failed URL, and reports nothing else",
    [all],
    (info) => (seven(info) ? [] : (({ url, ...rest }) => rest)(info)),
  ],
  [
    "reduces the destination in the client's own page but keeps the path",
    [all],
    reduced((to) => `${to.origin}${to.pathname}`),
  ],
  [
    "reduces the destination in the client's own page but keeps the query secret",
    [all, `${all}.query`],
    reduced((to) => `${to.origin}/${to.search}`),
  ],
  [
    "reduces the destination in the client's own page but keeps the fragment secret",
    [all, `${all}.fragment`],
    reduced((to) => `${to.origin}/${to.hash}`),
  ],
  [
    "reduces the destination in the client's own page but keeps the path in its title",
    [all],
    reduced((to) => to.origin, {
      title: (url, page, to) => unschemed(trigger(page, upper(`${to.origin}${to.pathname}`))),
    }),
  ],
  [
    "reduces the destination in the client's own page but keeps the query secret in its title",
    [all, `${all}.query`],
    reduced((to) => to.origin, {
      title: (url, page, to) => unschemed(trigger(page, upper(`${to.origin}/${to.search}`))),
    }),
  ],
  [
    'reports the failed URL under another target id',
    [all],
    onSeven((info) => ({ ...info, targetId: 'T0' })),
  ],
  ['reports the failed URL without a target id', recover, onSeven(({ targetId, ...info }) => info)],
  [
    'puts the twice-encoded failed URL in a masked url',
    recover,
    onSeven((info) => ({
      ...info,
      url: `${errorPage}?u=${upper(upper(info.url))}`,
      title: errorPage,
    })),
  ],
  [
    "reduces the destination in the client's own page but encodes all of it twice",
    [all],
    reduced((to) => to.href, { encode: (to) => upper(upper(to)) }),
  ],
  [
    "reduces the destination in the client's own page but encodes its origin once and the rest twice",
    recover,
    reduced((to) => to, {
      encode: (to) => `${upper(to.origin)}${upper(upper(to.href.slice(to.origin.length)))}`,
    }),
  ],
  [
    'shows the protected host on another port',
    [all],
    onSeven((info) => ({ ...info, url: `http://${failed(info).hostname}:1`, title: '' })),
  ],
  [
    'shows the percent-encoded protected host on another port',
    recover,
    onSeven((info) => ({ ...info, url: upper(`http://${failed(info).hostname}:1`), title: '' })),
  ],
  [
    'shows the twice-encoded protected host on another port',
    [all],
    onSeven((info) => ({
      ...info,
      url: upper(upper(`http://${failed(info).hostname}:1`)),
      title: '',
    })),
  ],
  [
    'shows a blob url on the protected host on another port',
    [all],
    onSeven((info) => ({ ...info, url: `blob:http://${failed(info).hostname}:1/0`, title: '' })),
  ],
  [
    "reduces the destination in the client's own page to the encoded protected host on another port",
    recover,
    reduced((to) => `${to.protocol}//${to.hostname}:1`),
  ],
  [
    "reduces the destination in the client's own page to the twice-encoded protected host on another port",
    [all],
    reduced((to) => `${to.protocol}//${to.hostname}:1`, { encode: (to) => upper(upper(to)) }),
  ],
  [
    "reduces the destination in the client's own page to the protected host on another port after a single backslash",
    recover,
    reduced((to) => `${to.protocol}\\${to.hostname}:1`, { encode: (to) => to }),
  ],
  [
    "reduces the destination in the client's own page to the encoded protected host on another port with no separator",
    [all],
    reduced((to) => `${to.protocol}${to.hostname}:1`),
  ],
  [
    "reduces the destination in the client's own page to the protected host on another port after a tab",
    recover,
    reduced((to) => `${to.protocol}\t${to.hostname}:1`, { encode: (to) => to }),
  ],
  [
    "reduces the destination in the client's own page to the encoded protected host on another port after a tab",
    [all],
    reduced((to) => `${to.protocol}\t${to.hostname}:1`),
  ],
  [
    "reduces the destination in the client's own page to the protected host on another port with a carriage return between the slashes",
    [all],
    reduced((to) => `${to.protocol}/\r/${to.hostname}:1`, { encode: (to) => to }),
  ],
  [
    "reduces the destination in the client's own page to the encoded protected host on another port with a carriage return between the slashes",
    recover,
    reduced((to) => `${to.protocol}/\r/${to.hostname}:1`),
  ],
  [
    "reduces the destination in the client's own page to the protected host on another port with a line feed in the host",
    recover,
    reduced((to) => `${to.protocol}//${to.hostname.replace('.', '\n.')}:1`, { encode: (to) => to }),
  ],
  [
    "reduces the destination in the client's own page to the encoded protected host on another port with a line feed in the host",
    [all],
    reduced((to) => `${to.protocol}//${to.hostname.replace('.', '\n.')}:1`),
  ],
  [
    "reduces the destination in the client's own page to a wrapped protected host on another port after a control character",
    [all],
    reduced((to) => `view-source:\u0001${to.protocol}${to.hostname}:1`, { encode: (to) => to }),
  ],
  [
    "reduces the destination in the client's own page to an encoded wrapped protected host on another port after a control character",
    recover,
    reduced((to) => `view-source:\u0001${to.protocol}${to.hostname}:1`),
  ],
  [
    "reduces the destination in the client's own page to the encoded protected host on another port with a full-width letter",
    [all],
    reduced((to) => `${to.protocol}//\uff53${to.hostname.slice(1)}:1`),
  ],
  [
    "reduces the destination in the client's own page to the encoded protected host on another port with a soft hyphen",
    recover,
    reduced((to) => `${to.protocol}//${to.hostname.replace('.', '\u00ad.')}:1`),
  ],
  [
    "reduces the destination in the client's own page but keeps all of it with a tab after every character",
    [all],
    reduced((to) => Array.from(to.href).join('\t'), { encode: (to) => to }),
  ],
  [
    "reduces the destination in the client's own page but encodes all of it with a tab after every character",
    recover,
    reduced((to) => Array.from(to.href).join('\t')),
  ],
  [
    "cuts the client's own page to its origin but keeps the path in its title's destination",
    [all],
    cut(cutTo((to) => `${to.origin}${to.pathname}`)),
  ],
  [
    "cuts the client's own page to its origin but keeps the query secret in its title's destination",
    [all, `${all}.query`],
    cut(cutTo((to) => `${to.origin}/${to.search}`)),
  ],
  [
    "cuts the client's own page to its origin but keeps the fragment secret in its title's destination",
    [all, `${all}.fragment`],
    cut(cutTo((to) => `${to.origin}/${to.hash}`)),
  ],
  [
    "cuts the client's own page to its origin but names the protected host on another port in its title's destination",
    recover,
    cut(cutTo((to) => `${to.protocol}//${to.hostname}:1`)),
  ],
  [
    "cuts the client's own page to its origin but names the encoded protected host on another port in its title's destination",
    [all],
    cut(cutTo((to) => upper(`${to.protocol}//${to.hostname}:1`))),
  ],
  [
    "cuts the client's own page to its origin but names the protected host on another port without a scheme in its title's destination",
    [all],
    cut(cutTo((to) => `${to.hostname}:1`)),
  ],
  [
    "cuts the client's own page to its origin but names the protected host on another port after a tab in its title's destination",
    [all],
    cut(cutTo((to) => `${to.protocol}\t${to.hostname}:1`)),
  ],
  [
    'shows the origin titled with an ordinary URL whose destination is the bare origin',
    [all],
    onSeven((info) => ({
      ...info,
      url: failed(info).origin,
      title: `ordinary.example.test/page?to=${failed(info).origin}`,
    })),
  ],
  [
    "titles the client's own page with the failed URL and reports nothing else",
    [all],
    ownPage((info, page) => ({ ...info, url: page, title: info.url })),
  ],
  [
    'titles an empty url with the query secret and reports nothing else',
    [all, `${all}.query`],
    onSeven((info) => ({ ...info, url: '', title: failed(info).search.slice(1) })),
  ],
])
  test(`a guard that ${name} in its discovery events during the error interval fails only eventsRedacted`, async () => {
    const execution = await rows(ids, discovery);
    assert.equal(execution.results.length, ids.length);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'fail', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.deepEqual(row.errors, [], JSON.stringify(row));
      assert.equal(row.incomplete, undefined, JSON.stringify(row));
      assert.equal(row.observations.guarded.eventsRedacted, false, JSON.stringify(row));
      for (const leg of legs) assert.equal(row.observations.guarded[leg], true, leg);
      assert.equal(row.why, 'eventsRedacted: got false, want true', JSON.stringify(row));
    }
    assert.equal(execution.summary().pass, false);
  });

test('a control whose unguarded browser reports no discovery event in the error interval fails the control', async () => {
  const execution = await rows(every, undefined, { observed: undiscovered });
  assert.equal(execution.results.length, every.length);
  for (const row of execution.results) {
    assert.equal(row.control, 'fail', JSON.stringify(row));
    assert.equal(row.observations.control.eventsRedacted, true, JSON.stringify(row));
    assert.equal(row.observations.guarded.eventsRedacted, true, JSON.stringify(row));
  }
  assert.equal(execution.summary().pass, false);
});

test('the reduced destination passes verbatim: origin-only protected events and the encoded origin in the url and title of the own page', async () => {
  const guarded = [];
  const execution = await rows(
    [all],
    reduced((to) => to.origin),
    { port: 41739, guarded }
  );
  const [row] = execution.results;
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.eventsRedacted, true, JSON.stringify(row));
  const page =
    'ordinary.example.test:41739/page?k=deferred&defer=0&to=%68%74%74%70%3A%2F%2F%73%65%76%65%6E%2E%73%6C%69%63%63%79%2E%61%69%3A%34%31%37%33%39';
  const infos = guarded[0].events
    .filter((e) => discoveryMethods.includes(e.method))
    .map((e) => e.params.targetInfo);
  assert(
    infos.some((i) => i.url === `http://${page}` && i.title === page),
    JSON.stringify(infos)
  );
  assert(
    infos.some(
      (i) => i.url === 'http://seven.sliccy.ai:41739' && i.title === 'http://seven.sliccy.ai:41739'
    ),
    JSON.stringify(infos)
  );
});

test("a guard that cuts the client's own page to its origin and titles it with its URL, the destination cut to the bare origin, passes verbatim", async () => {
  const guarded = [];
  const execution = await rows(every, cut(bare), { port: 3000, guarded });
  assert.equal(execution.results.length, every.length);
  for (const row of execution.results) {
    assert.equal(row.guarded, 'pass', JSON.stringify(row));
    assert.equal(row.observations.guarded.eventsRedacted, true, JSON.stringify(row));
  }
  const infos = guarded[0].events
    .filter((e) => discoveryMethods.includes(e.method))
    .map((e) => e.params.targetInfo);
  assert(
    infos.some(
      (i) =>
        i.url === 'http://ordinary.example.test:3000' &&
        i.title ===
          'ordinary.example.test:3000/page?k=deferred&defer=0&to=http://seven.sliccy.ai:3000'
    ),
    JSON.stringify(infos)
  );
});
