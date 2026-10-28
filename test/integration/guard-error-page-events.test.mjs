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
const undiscovered = (info, method) => (discoveryMethods.includes(method) ? [] : info);

async function rows(ids, discovery, observed) {
  const fixture = await fixtureServer();
  try {
    const browser = chrome();
    const origin = (host) => `http://${host}:${fixture.port}`;
    return await run(
      { ...set, vectors: vectors.filter((v) => ids.includes(v.id)), variants: { prompt: 0 } },
      {
        client: quarantining(browser, { discovery }),
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
  const execution = await rows(every, undefined, undiscovered);
  assert.equal(execution.results.length, every.length);
  for (const row of execution.results) {
    assert.equal(row.control, 'fail', JSON.stringify(row));
    assert.equal(row.observations.control.eventsRedacted, true, JSON.stringify(row));
    assert.equal(row.observations.guarded.eventsRedacted, true, JSON.stringify(row));
  }
  assert.equal(execution.summary().pass, false);
});
