import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isSevenLabel } from '../../seven.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url)));
const { seven } = read('catalog.json');

for (const c of read('corpus.json').cases) {
  if (!['seven-tabs', 'endpoint-tabs'].includes(c.name)) continue;
  for (const [host, server] of Object.entries(c.case.http ?? {})) {
    if (!Array.isArray(server.list)) continue;
    const entry = c.expected.entries.find((e) => e.id === `cdp:${host}`);
    if (!entry?.endpoint) continue;
    test(`${c.name} ${host} seven tabs match the catalog`, () => {
      const tabs = server.list.flatMap((target) => {
        if (target.type !== 'page') return [];
        let url;
        try {
          url = new URL(target.url);
        } catch {
          return [];
        }
        const match = url.hostname.match(new RegExp(seven.originHostPattern));
        if (url.protocol !== `${seven.originScheme}:` || !match || !isSevenLabel(seven, match[1]))
          return [];
        return [{ id: target.id, url: url.origin, title: url.origin }];
      });
      assert.deepEqual(entry.endpoint.sevenTabs, tabs);
      assert.equal(entry.endpoint.sevenOpen, tabs.length > 0);
      if (tabs.length > 0) assert.equal(entry.tier, 1);
    });
  }
}
