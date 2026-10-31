import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { protectedOrigins } from '../../protected.mjs';

const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const vectors = JSON.parse(await readFile(new URL('../../protected.json', import.meta.url)));

test('the shared domain premise has no ordinary origin or page target', () => {
  const match = protectedOrigins(catalog.protectedOrigins, vectors.origins);
  const expected = [
    'sliccy.ai',
    'www.sliccy.ai',
    'seven.sliccy.ai',
    'vault.sliccy.ai',
    'arbitrary-premise.sliccy.ai',
  ].flatMap((host) => ['http', 'https'].map((scheme) => `${scheme}://${host}/cdp-premise`));
  for (const url of expected) {
    const origin = vectors.urls.find((vector) => vector.url === url);
    const target = vectors.targets.find((vector) => vector.url === url && vector.type === 'page');
    assert.equal(origin?.protected, true, url);
    assert.equal(target?.protected, true, url);
    assert.equal(match.url(url), true, url);
    assert.equal(match.target(target), true, url);
  }
});
