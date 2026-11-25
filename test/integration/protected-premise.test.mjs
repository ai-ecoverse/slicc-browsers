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

const match = protectedOrigins(catalog.protectedOrigins, vectors.origins);
const reported = vectors.targets.filter((vector) => 'contextOrigin' in vector);
const inherits = (url) => {
  const u = URL.parse(url);
  return (
    url === '' ||
    (u?.protocol === 'about:' &&
      catalog.protectedOrigins.inheriting.includes(`about:${u.pathname.toLowerCase()}`))
  );
};
const lookalike = (origin) => origin.toLowerCase().startsWith('about:') && origin !== 'about://';
const model =
  ({ failClosed = lookalike, missing = false, widen = false } = {}) =>
  (vector) => {
    const today = match.target({ ...vector, contextOrigin: undefined });
    const origin = vector.contextOrigin;
    if (widen && vector.url.startsWith('about:') && origin?.startsWith('about://'))
      return Boolean(vector.previous) || ['protected', 'unknown'].includes(vector.opener);
    if (!inherits(vector.url)) return today;
    if (origin === undefined) return today || missing;
    return today || failClosed(origin);
  };
const disagreements = (classify) =>
  vectors.targets.filter((vector) => classify(vector) !== vector.protected);

test('every target vector, with or without a context origin, gets its expected answer', () => {
  assert.ok(reported.some((vector) => vector.contextOrigin === '://'));
  assert.ok(reported.some((vector) => vector.contextOrigin === 'about://'));
  for (const vector of vectors.targets)
    assert.equal(match.target(vector), vector.protected, JSON.stringify(vector));
  assert.deepEqual(disagreements(model()), []);
  for (const vector of vectors.targets)
    assert.equal(model()(vector), match.target(vector), JSON.stringify(vector));
});

const mutants = [
  ['about:// is not the :// report', { failClosed: (o) => o.toLowerCase().startsWith('about:') }],
  [
    'about:// matched as a prefix',
    { failClosed: (o) => o.toLowerCase().startsWith('about:') && !o.startsWith('about://') },
  ],
  [
    'about:// matched without case',
    {
      failClosed: (o) => o.toLowerCase().startsWith('about:') && o.toLowerCase() !== 'about://',
    },
  ],
  ['the opaque report widened to internal about: pages', { widen: true }],
  ['a missing context origin fails closed', { missing: true }],
  ['an ordinary origin fails closed', { failClosed: (o) => o !== '://' && o !== 'about://' }],
  [':// fails closed', { failClosed: (o) => o === '://' || lookalike(o) }],
  ['the look-alike rule is not applied', { failClosed: () => false }],
];

for (const [name, options] of mutants) {
  test(`mutant ${name} fails a target vector`, () => {
    assert.notDeepEqual(disagreements(model(options)), [], name);
  });
}
