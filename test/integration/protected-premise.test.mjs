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

const spellings = [
  ['AbOuT:blank', true],
  ['about:', true],
  ['abouT:', true],
  ['about:\n', true],
  ['about://\n', true],
  ['about://\r', true],
  ['about://\t', true],
  ['about:blank ', true],
  ['about://x\u0000', true],
  ['about:%20', true],
  ['', false],
  ['null', false],
];
const spelled = (vector) =>
  Object.keys(vector).length === 3 &&
  vector.url === 'about:blank' &&
  spellings.some(([origin]) => vector.contextOrigin === origin);

test('each context origin spelling on about:blank has one row with its answer', () => {
  for (const [origin, expected] of spellings) {
    const rows = vectors.targets.filter(
      (vector) => spelled(vector) && vector.contextOrigin === origin
    );
    assert.equal(rows.length, 1, JSON.stringify(origin));
    assert.equal(rows[0].protected, expected, JSON.stringify(origin));
    assert.equal(match.target(rows[0]), expected, JSON.stringify(origin));
    assert.equal(
      match.target({ url: 'about:blank', contextOrigin: origin }),
      expected,
      JSON.stringify(origin)
    );
  }
});

const spellingMutants = [
  ['the context origin trimmed before the comparison', { failClosed: (o) => lookalike(o.trim()) }],
  [
    'the context origin parsed as a URL before the comparison',
    { failClosed: (o) => lookalike(URL.parse(o)?.href ?? o) },
  ],
  [
    'the context origin compared case-sensitively',
    { failClosed: (o) => o.startsWith('about:') && o !== 'about://' },
  ],
  [
    'an empty or null context origin fails closed',
    { failClosed: (o) => o === '' || o === 'null' || lookalike(o) },
  ],
];

for (const [name, options] of spellingMutants) {
  test(`mutant ${name} fails a context origin spelling row`, () => {
    assert.notDeepEqual(disagreements(model(options)).filter(spelled), [], name);
  });
}
