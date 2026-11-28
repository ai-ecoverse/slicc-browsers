import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { protectedOrigins } from '../../protected.mjs';

const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const vectors = JSON.parse(await readFile(new URL('../../protected.json', import.meta.url)));
const po = catalog.protectedOrigins;
const pilot = 'https://lease-pilot.sliccy.ai';
const reference = (rules) => protectedOrigins(rules, vectors.origins);

const inherits = (url) => {
  const u = URL.parse(url);
  return (
    url === '' ||
    (u?.protocol === 'about:' && po.inheriting.includes(`about:${u.pathname.toLowerCase()}`))
  );
};

const authority = (text) => /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]*)/i.exec(text)?.[1];
const beforeAt = (text) => /^[a-z][a-z0-9+.-]*:\/\/([^:@/?#]*)/i.exec(text)?.[1];

const model = (rules, o = {}) => {
  const listed = rules.keptOrigins?.length ? rules.keptOrigins : o.fallback ? [pilot] : [];
  const hosts = listed.map((origin) => new URL(origin).hostname);
  const host = (u, text) => {
    let h = u.hostname;
    if (o.caseSensitive) h = authority(text) ?? '';
    if (o.userinfoHost) h = beforeAt(text) ?? '';
    return !o.keepDot && h.endsWith('.') ? h.slice(0, -1) : h;
  };
  const kept = (text) => {
    if (o.prefix) return listed.some((origin) => text.toLowerCase().startsWith(origin));
    let u = URL.parse(text);
    if (o.unwrap && u && ['blob:', 'view-source:'].includes(u.protocol))
      u = URL.parse(text.slice(u.protocol.length));
    if (!u) return false;
    if (u.protocol !== 'https:' && !(o.http && u.protocol === 'http:')) return false;
    if (u.port !== '' && !o.anyPort) return false;
    if (o.noUserinfo && (u.username !== '' || u.password !== '')) return false;
    const h = host(u, text);
    return hosts.some((k) => h === k || (o.subdomains && h.endsWith(`.${k}`)));
  };
  const contextKept = (origin, v) => {
    if (origin === undefined) return o.openerFallback ? v.opener === 'protected' : false;
    if (o.anyContext) return true;
    if (o.aboutContext && origin.toLowerCase().startsWith('about:')) return true;
    if (o.parseContext) return kept(origin);
    if (o.needsOpener && !v.previous && v.opener !== 'protected') return false;
    return listed.includes(origin);
  };
  const keptTarget = (v) => {
    if (o.everyContext && v.contextOrigin !== undefined)
      return contextKept(v.contextOrigin, v) || kept(v.url);
    return inherits(v.url) ? contextKept(v.contextOrigin, v) : kept(v.url);
  };
  return { kept, keptTarget };
};

const variant =
  (o = {}) =>
  (rules) => {
    const base = reference(rules);
    const m = model(rules, o);
    if (!o.relax) return { ...base, ...m };
    return {
      ...base,
      ...m,
      url: (text) => base.url(text) && !m.kept(text),
      target: (v) => base.target(v) && !m.keptTarget(v),
    };
  };

const { keptOrigins: _, ...withoutKept } = po;

const failures = (factory) => {
  const out = [];
  const j = factory(po);
  for (const v of vectors.kept) {
    const got = j.kept(v.url);
    if (got !== v.kept) out.push(`kept ${v.url}: ${got}`);
    if (got && !j.url(v.url)) out.push(`kept ${v.url} is not protected`);
  }
  for (const v of vectors.keptTargets) {
    const got = j.keptTarget(v);
    if (got !== v.kept) out.push(`keptTarget ${JSON.stringify(v)}: ${got}`);
    const document = inherits(v.url) ? j.url(v.contextOrigin ?? '') : j.target(v);
    if (got && !document) out.push(`keptTarget ${JSON.stringify(v)} is not protected`);
  }
  for (const v of vectors.urls)
    if (j.url(v.url) !== v.protected) out.push(`url ${v.url} changed protection`);
  for (const v of vectors.targets)
    if (j.target(v) !== v.protected) out.push(`target ${JSON.stringify(v)} changed protection`);
  for (const rules of [{ ...po, keptOrigins: [] }, withoutKept]) {
    const e = factory(rules);
    for (const v of vectors.kept) if (e.kept(v.url)) out.push(`kept ${v.url} without keptOrigins`);
    for (const v of vectors.keptTargets)
      if (e.keptTarget(v)) out.push(`keptTarget ${JSON.stringify(v)} without keptOrigins`);
  }
  return out;
};

test('the catalog keeps exactly the pilot origin, and it is a protected origin', () => {
  assert.deepEqual(po.keptOrigins, [pilot]);
  const match = protectedOrigins(po);
  for (const origin of po.keptOrigins) {
    assert.equal(match.url(origin), true, origin);
    assert.equal(match.url(`${origin}/`), true, origin);
  }
});

test('every kept row gets its expected answer from kept()', () => {
  const match = reference(po);
  assert.ok(vectors.kept.some((v) => v.kept));
  assert.ok(vectors.kept.some((v) => !v.kept));
  for (const v of vectors.kept) assert.equal(match.kept(v.url), v.kept, v.url);
});

test('every keptTargets row gets its expected answer from keptTarget()', () => {
  const match = reference(po);
  assert.ok(vectors.keptTargets.some((v) => v.kept));
  assert.ok(vectors.keptTargets.some((v) => !v.kept));
  for (const v of vectors.keptTargets) assert.equal(match.keptTarget(v), v.kept, JSON.stringify(v));
});

test('every kept row is protected, and no protected answer changes', () => {
  const match = reference(po);
  for (const v of vectors.kept.filter((row) => row.kept))
    assert.equal(match.url(v.url), true, v.url);
  for (const v of vectors.keptTargets.filter((row) => row.kept)) {
    if (inherits(v.url)) assert.equal(match.url(v.contextOrigin), true, JSON.stringify(v));
    else assert.equal(match.target(v), true, JSON.stringify(v));
  }
  const without = reference(withoutKept);
  for (const v of vectors.urls) {
    assert.equal(match.url(v.url), v.protected, v.url);
    assert.equal(without.url(v.url), v.protected, v.url);
  }
  for (const v of vectors.targets) {
    assert.equal(match.target(v), v.protected, JSON.stringify(v));
    assert.equal(without.target(v), v.protected, JSON.stringify(v));
  }
  for (const v of [...vectors.kept, ...vectors.keptTargets]) {
    assert.equal(without.url(v.url), match.url(v.url), v.url);
    assert.equal(without.target(v), match.target(v), JSON.stringify(v));
  }
});

test('an empty or missing keptOrigins keeps nothing', () => {
  for (const rules of [{ ...po, keptOrigins: [] }, withoutKept]) {
    const match = reference(rules);
    for (const v of vectors.kept) assert.equal(match.kept(v.url), false, v.url);
    for (const v of vectors.keptTargets)
      assert.equal(match.keptTarget(v), false, JSON.stringify(v));
  }
});

test('the reference and its model pass every check', () => {
  assert.deepEqual(failures(reference), []);
  assert.deepEqual(failures(variant()), []);
  for (const v of vectors.kept)
    assert.equal(model(po).kept(v.url), reference(po).kept(v.url), v.url);
  for (const v of vectors.keptTargets)
    assert.equal(model(po).keptTarget(v), reference(po).keptTarget(v), JSON.stringify(v));
});

const keptRows = [
  [`${pilot}/`, true],
  [pilot, true],
  [`${pilot}/os/x`, true],
  [`${pilot}/auth/callback`, true],
  [`${pilot}/os/x/y/z/deep/path/index.html`, true],
  [`${pilot}/?x=1&y=2`, true],
  [`${pilot}/#x`, true],
  ['HTTPS://LEASE-PILOT.SLICCY.AI/', true],
  ['https://lease-pilot.sliccy.ai./', true],
  ['https://user:secret@lease-pilot.sliccy.ai/', true],
  ['https://lease-pilot.sliccy.ai:443/', true],
  ['https://lease-pilot%2Esliccy.ai/', true],
  ['https://\uff4c\uff45\uff41\uff53\uff45-\uff50\uff49\uff4c\uff4f\uff54.sliccy.ai/', true],
  ['https://lease-pilot.sliccy.ai:8443/', false],
  ['https://lease-pilot.sliccy.ai:80/', false],
  ['http://lease-pilot.sliccy.ai/', false],
  ['http://lease-pilot.sliccy.ai:80/', false],
  ['https://a.lease-pilot.sliccy.ai/', false],
  ['https://a.b.lease-pilot.sliccy.ai/', false],
  ['https://lease-pilot.sliccy.ai.example/', false],
  ['https://lease-pilot-sliccy.ai/', false],
  ['https://notsliccy.ai/', false],
  ['https://lease-pilot.sliccy.aix/', false],
  ['https://lease-pilot.sliccy.ai@example.com/', false],
  ['wss://lease-pilot.sliccy.ai/', false],
  ['ftp://lease-pilot.sliccy.ai/', false],
  ['https://sliccy.ai/', false],
  ['https://seven.sliccy.ai/', false],
  ['https://www.sliccy.ai/', false],
  ['https://vault.sliccy.ai/', false],
  ['blob:https://lease-pilot.sliccy.ai/x', false],
  ['view-source:https://lease-pilot.sliccy.ai/', false],
  ['https://lease-pilot.sliccy.ai:99999/', false],
];

const keptTargetRows = [
  [{ url: 'about:blank', contextOrigin: pilot }, true],
  [{ url: 'about:blank', contextOrigin: pilot, opener: 'protected' }, true],
  [{ url: 'about:blank', contextOrigin: pilot, opener: 'unprotected' }, true],
  [{ url: 'about:blank', contextOrigin: pilot, previous: true }, true],
  [{ url: 'about:blank', contextOrigin: 'https://lease-pilot.sliccy.ai:8443' }, false],
  [{ url: 'about:blank', contextOrigin: 'http://lease-pilot.sliccy.ai' }, false],
  [{ url: 'about:blank', contextOrigin: 'https://a.lease-pilot.sliccy.ai' }, false],
  [{ url: 'about:blank', contextOrigin: 'https://seven.sliccy.ai' }, false],
  [{ url: 'about:blank', contextOrigin: 'https://example.com' }, false],
  [{ url: 'about:blank', contextOrigin: `${pilot}/` }, false],
  [{ url: 'about:blank', contextOrigin: 'HTTPS://LEASE-PILOT.SLICCY.AI' }, false],
  [{ url: 'about:blank', contextOrigin: 'about://' }, false],
  [{ url: 'about:blank', contextOrigin: '://' }, false],
  [{ url: 'about:blank' }, false],
  [{ url: 'about:blank', previous: true }, false],
  [{ url: 'about:blank', opener: 'protected' }, false],
  [{ url: `${pilot}/` }, true],
  [{ url: `${pilot}/os/x`, opener: 'unprotected' }, true],
  [{ url: 'https://seven.sliccy.ai/', contextOrigin: pilot }, false],
  [{ url: 'blob:https://lease-pilot.sliccy.ai/x' }, false],
  [{ url: 'view-source:https://lease-pilot.sliccy.ai/' }, false],
];

test('each named kept row is in protected.json once with its answer', () => {
  assert.equal(vectors.kept.length, keptRows.length);
  for (const [url, kept] of keptRows) {
    const rows = vectors.kept.filter((v) => v.url === url);
    assert.deepEqual(rows, [{ url, kept }], url);
  }
});

test('each named keptTargets row is in protected.json once with its answer', () => {
  assert.equal(vectors.keptTargets.length, keptTargetRows.length);
  for (const [row, kept] of keptTargetRows) {
    const rows = vectors.keptTargets.filter(({ kept: _, ...rest }) => isDeepStrictEqual(rest, row));
    assert.deepEqual(rows, [{ ...row, kept }], JSON.stringify(row));
  }
});

const mutants = [
  ['kept ignores the port rule', { anyPort: true }],
  ['kept accepts http', { http: true }],
  ['kept accepts subdomains', { subdomains: true }],
  ['kept compares the host case-sensitively', { caseSensitive: true }],
  ['kept keeps the trailing dot', { keepDot: true }],
  ['kept refuses a URL with userinfo', { noUserinfo: true }],
  ['kept takes the userinfo as the host', { userinfoHost: true }],
  ['kept matches the origin as a text prefix', { prefix: true }],
  ['kept unwraps blob: and view-source:', { unwrap: true }],
  ['keptTarget accepts any context origin', { anyContext: true }],
  ['keptTarget accepts an about: context origin', { aboutContext: true }],
  ['keptTarget normalises the context origin', { parseContext: true }],
  ['keptTarget needs a protected opener or previous', { needsOpener: true }],
  ['keptTarget falls back to the opener without a context origin', { openerFallback: true }],
  ['keptTarget judges the context origin of any URL', { everyContext: true }],
  ['kept relaxes protection', { relax: true }],
  ['an empty keptOrigins still keeps the pilot origin', { fallback: true }],
];

for (const [name, options] of mutants) {
  test(`mutant ${name} fails a row`, () => {
    assert.notDeepEqual(failures(variant(options)), [], name);
  });
}
