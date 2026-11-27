import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isSevenLabel } from '../../seven.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url)));
const { seven } = read('catalog.json');

const sevenOrigin = (href) => {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const match = url.hostname.match(new RegExp(seven.originHostPattern));
  if (
    url.protocol !== `${seven.originScheme}:` ||
    url.port !== '' ||
    !match ||
    !isSevenLabel(seven, match[1])
  )
    return null;
  return url.origin;
};

for (const c of read('corpus.json').cases) {
  if (!['seven-tabs', 'endpoint-tabs'].includes(c.name)) continue;
  for (const [host, server] of Object.entries(c.case.http ?? {})) {
    if (!Array.isArray(server.list)) continue;
    const entry = c.expected.entries.find((e) => e.id === `cdp:${host}`);
    if (!entry?.endpoint) continue;
    test(`${c.name} ${host} seven tabs match the catalog`, () => {
      const tabs = server.list.flatMap((target) => {
        if (target.type !== 'page') return [];
        const origin = sevenOrigin(target.url);
        return origin ? [{ id: target.id, url: origin, title: origin }] : [];
      });
      assert.deepEqual(entry.endpoint.sevenTabs, tabs);
      assert.equal(entry.endpoint.sevenOpen, tabs.length > 0);
      if (tabs.length > 0) assert.equal(entry.tier, 1);
    });
  }
}

const notSeven = [
  'https://lease-pilot.sliccy.ai',
  'https://lease-pilot.sliccy.ai/',
  'https://lease-pilot.sliccy.ai:443/',
  'HTTPS://LEASE-PILOT.SLICCY.AI/',
  'https://lease-pilot.sliccy.ai./',
  'https://lease-pilot.sliccy.ai:8443/',
  'http://lease-pilot.sliccy.ai/',
  'http://lease-pilot.sliccy.ai:443/',
  'https://lease-pilot.sliccy.ai/workspace?x=1#top',
  'https://seven.sliccy.ai:8443/',
  'http://seven.sliccy.ai/',
  'https://vault.sliccy.ai/',
  'https://vault-preview.sliccy.ai/',
  'https://vault-feature-x.sliccy.ai/',
  'https://get.sliccy.ai/',
  'https://mcpcat.sliccy.ai/',
  'https://echo.sliccy.ai/',
  'https://sliccy.ai/',
];

const isSeven = [
  ['https://seven.sliccy.ai/', 'https://seven.sliccy.ai'],
  ['https://www.sliccy.ai/', 'https://www.sliccy.ai'],
  ['https://link-websockets.sliccy.ai/', 'https://link-websockets.sliccy.ai'],
  ['https://lease.sliccy.ai/', 'https://lease.sliccy.ai'],
  ['https://pilot.sliccy.ai/', 'https://pilot.sliccy.ai'],
  ['https://lease-pilot2.sliccy.ai/', 'https://lease-pilot2.sliccy.ai'],
  ['https://my-lease-pilot.sliccy.ai/', 'https://my-lease-pilot.sliccy.ai'],
  ['https://lease-pilots.sliccy.ai/', 'https://lease-pilots.sliccy.ai'],
  ['https://lease--pilot.sliccy.ai/', 'https://lease--pilot.sliccy.ai'],
  ['https://pilot-lease.sliccy.ai/', 'https://pilot-lease.sliccy.ai'],
  ['https://lease-pilot-x.sliccy.ai/', 'https://lease-pilot-x.sliccy.ai'],
  ['https://lease-pilot2.sliccy.ai:443/', 'https://lease-pilot2.sliccy.ai'],
  ['HTTPS://LEASE-PILOT2.SLICCY.AI/', 'https://lease-pilot2.sliccy.ai'],
  ['https://lease-pilot-x.sliccy.ai/workspace?x=1#top', 'https://lease-pilot-x.sliccy.ai'],
];

for (const href of notSeven) {
  test(`${href} is not a seven origin`, () => {
    assert.equal(sevenOrigin(href), null);
  });
}

for (const [href, origin] of isSeven) {
  test(`${href} is the seven origin ${origin}`, () => {
    assert.equal(sevenOrigin(href), origin);
  });
}
