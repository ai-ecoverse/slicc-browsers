#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { protectedOrigins } from '../protected.mjs';
import { isSevenLabel } from '../seven.mjs';
import { bundle } from './corpus.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const problems = [];
const fail = (message) => problems.push(message);

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
});
addFormats(ajv);
for (const name of ['catalog', 'browsers', 'corpus', 'protected', 'guard-vectors'])
  ajv.addSchema(read(`schema/${name}.schema.json`));
const schemaURL = (name) =>
  `https://github.com/ai-ecoverse/slicc-browsers/schema/${name}.schema.json`;

function check(name, data, label) {
  const validate = ajv.getSchema(schemaURL(name));
  if (!validate(data)) {
    for (const e of validate.errors) fail(`${label}${e.instancePath}: ${e.message}`);
  }
}

const catalog = read('catalog.json');
check('catalog', catalog, 'catalog.json');

function unique(label, values) {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) fail(`catalog.json: duplicate ${label} ${v}`);
    seen.add(v);
  }
}

const ids = catalog.browsers.map((b) => b.id);
unique('browser id', ids);
unique('bundle id', [
  ...catalog.browsers.map((b) => b.macos.bundleId),
  ...catalog.electron.macosApps.map((a) => a.bundleId),
]);
unique(
  'name',
  catalog.browsers.map((b) => b.name)
);
const roots = new Set(Object.keys(catalog.platforms.windows.roots));
for (const b of catalog.browsers) {
  for (const r of [...(b.windows?.roots ?? []), b.windows?.dataRoot].filter(Boolean)) {
    if (!roots.has(r)) fail(`catalog.json: ${b.id} uses unknown Windows root ${r}`);
  }
}
if (!ids.includes(catalog.rank.chromeId))
  fail(`catalog.json: rank.chromeId ${catalog.rank.chromeId} is not a browser`);
const t = catalog.rank.tiers;
if (
  !(
    t.sevenOpen < t.endpoint &&
    t.endpoint < t.chrome &&
    t.chrome < t.chromium &&
    t.chromium < t.electron &&
    t.electron < t.six
  )
) {
  fail('catalog.json: tiers must rise from sevenOpen to six');
}
const six = catalog.profiles.six;
if (!new RegExp(catalog.profiles.sixProfilePattern, 'i').test(six.defaultName))
  fail('catalog.json: profiles.six.defaultName does not match sixProfilePattern');
if (
  !new RegExp(catalog.profiles.sixProfilePattern, 'i').test(
    `${six.defaultName}${six.portSuffix.replace('{port}', '5711')}`
  )
)
  fail('catalog.json: a six port variant does not match sixProfilePattern');
for (const pattern of [
  catalog.discovery.chromeMajorPattern,
  catalog.seven.originHostPattern,
  catalog.profiles.sixProfilePattern,
  catalog.profiles.namePattern,
]) {
  new RegExp(pattern);
}

const sevenLabelsTrue = ['seven', 'link-websockets'];
const sevenLabelsFalse = [
  '',
  'www',
  'vault',
  'vault-preview',
  'get',
  'mcpcat',
  'echo',
  'vault-feature-x',
];
for (const label of sevenLabelsTrue) {
  if (!isSevenLabel(catalog.seven, label))
    fail(`isSevenLabel(${JSON.stringify(label)}) should be true`);
}
for (const label of sevenLabelsFalse) {
  if (isSevenLabel(catalog.seven, label))
    fail(`isSevenLabel(${JSON.stringify(label)}) should be false`);
}

let text = '';
try {
  text = bundle();
} catch (e) {
  fail(e.message);
}
if (text && text !== readFileSync(join(root, 'corpus.json'), 'utf8').replaceAll('\r\n', '\n')) {
  fail('corpus.json is out of date; run npm run corpus');
}
const corpus = read('corpus.json');
check('corpus', corpus, 'corpus.json');

const reserved = /(?::|--remote-debugging-port[= ])922[2-9](?!\d)/;
const token = /\{(userData:[a-z0-9-]+)\}/g;
for (const { name, case: c, expected } of corpus.cases ?? []) {
  const label = `corpus/${name}`;
  const inputs = JSON.stringify(c);
  if (reserved.test(inputs) || reserved.test(JSON.stringify(expected))) {
    fail(`${label}: never use ports 9222-9229 in the corpus`);
  }
  for (const [, tok] of `${inputs}${JSON.stringify(expected)}`.matchAll(token)) {
    if (!ids.includes(tok.slice('userData:'.length))) fail(`${label}: unknown token {${tok}}`);
  }
  if (expected.minChromium !== catalog.minChromiumMajor)
    fail(`${label}: minChromium is not ${catalog.minChromiumMajor}`);
  let tier = 0;
  for (const e of expected.entries) {
    if (e.tier < tier) fail(`${label}: ${e.id} is out of tier order`);
    tier = e.tier;
    if (e.endpoint) {
      const open = e.endpoint.sevenTabs.length > 0;
      if (e.endpoint.sevenOpen !== open)
        fail(`${label}: ${e.id} sevenOpen disagrees with sevenTabs`);
      if (e.endpoint.tabs?.some((tab) => e.endpoint.sevenTabs.some((seven) => seven.id === tab.id)))
        fail(`${label}: ${e.id} lists a seven tab in tabs`);
      if (e.endpoint.six) {
        if (e.tier !== t.six) fail(`${label}: ${e.id} is six's but not in tier ${t.six}`);
      } else if ((e.tier === t.sevenOpen) !== open) {
        fail(`${label}: ${e.id} tier disagrees with sevenOpen`);
      }
    } else if (e.tier === t.six) {
      fail(`${label}: ${e.id} is in tier ${t.six} but not six's`);
    }
  }
  const needsSix = c.needs?.includes('six') ?? false;
  if (needsSix !== Object.hasOwn(c, 'auto')) fail(`${label}: needs six iff it has auto`);
  if (!needsSix && expected.entries.some((e) => e.endpoint?.six))
    fail(`${label}: lists six's endpoints without needing six`);
  if (needsSix) {
    const first = expected.entries.find((e) => !e.endpoint?.six);
    if (c.auto !== (first?.id ?? null))
      fail(
        `${label}: auto is ${c.auto}, not the first entry that isn't six's (${first?.id ?? null})`
      );
  }
  if (c.needs?.includes('installed') !== Array.isArray(c.installed))
    fail(`${label}: needs installed iff it has installed`);
}

const vectors = read('protected.json');
check('protected', vectors, 'protected.json');
const po = catalog.protectedOrigins;
if (vectors.unparseable !== po.unparseable || vectors.unparseableRefusal !== po.unparseableRefusal)
  fail('protected.json: unparseable rule and refusal must match catalog.json');
if (!po.domains.every((d) => po.domains.every((x) => d === x || !d.endsWith(`.${x}`))))
  fail('catalog.json: protectedOrigins.domains lists a domain under another');
const m = protectedOrigins(po, vectors.origins);
const byName = protectedOrigins({ ...po, domains: [] });
for (const h of po.hosts) {
  if (!byName.url(`https://${h}/`) || !byName.cookieDomain(h))
    fail(`catalog.json: ${h} in protectedOrigins.hosts isn't protected without domains`);
  if (
    !vectors.urls.some((v) => {
      try {
        return v.protected && new URL(v.url).hostname === h;
      } catch {
        return false;
      }
    })
  )
    fail(`protected.json: no vector for ${h}`);
}
const vectorChecks = [
  ['urls', (v) => m.url(v.url), (v) => v.url],
  ['targets', (v) => m.target(v), (v) => JSON.stringify(v)],
  ['cookieDomains', (v) => m.cookieDomain(v.domain), (v) => v.domain],
  ['storageKeys', (v) => m.storageKey(v.key), (v) => v.key],
];
for (const [field, run, label] of vectorChecks) {
  for (const v of vectors[field] ?? []) {
    if (run(v) !== v.protected)
      fail(`protected.json: ${field} ${JSON.stringify(label(v))} should be ${v.protected}`);
  }
}
if (reserved.test(JSON.stringify(vectors))) fail('protected.json: never use ports 9222-9229');

const guard = read('guard-vectors.json');
check('guard-vectors', guard, 'guard-vectors.json');
const gv = (message) => fail(`guard-vectors.json: ${message}`);
const flat = (list) => (list ?? []).flatMap((st) => [st, ...flat(st.children)]);
const methods = (list, side) =>
  flat(list)
    .filter((st) => st.cdp && (!st.on || st.on === side))
    .map((st) => st.cdp);
const placeholders = new Set(Object.keys(guard.placeholders ?? {}));
const strings = (value) =>
  typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(strings)
      : [];
const checkRefusals = (check, id) => {
  if (check?.refusal) {
    try {
      new RegExp(check.refusal.match);
    } catch {
      gv(`${id}: observation refusal.match does not compile`);
    }
  }
  for (const child of [
    ...(check?.all ?? []),
    ...(check?.any ?? []),
    ...(check?.not ? [check.not] : []),
  ])
    checkRefusals(child, id);
};
const guardIds = new Set();
for (const v of guard.vectors ?? []) {
  if (guardIds.has(v.id)) gv(`duplicate id ${v.id}`);
  guardIds.add(v.id);
  for (const [key, value] of Object.entries(typeof v.expected === 'object' ? v.expected : {})) {
    if (value === 'either' && !(v.designDependent ?? []).includes(key))
      gv(`${v.id} expects either for ${key}, which isn't in designDependent`);
  }
  const blank = (e) =>
    e === undefined || e === '' || (typeof e === 'object' && Object.keys(e).length === 0);
  if (v.control?.origin !== 'ordinary' || blank(v.control.expected))
    gv(`${v.id} has no control on an ordinary origin`);
  if (v.liveCheck?.on === 'control') gv(`${v.id}: liveCheck applies only to the guarded leg`);
  if (blank(v.expected)) gv(`${v.id} has no expected`);
  if (v.kind === 'cdp' && !v.liveCheck) gv(`${v.id} lacks liveCheck`);
  checkRefusals(v.liveCheck, v.id);
  if (v.family !== v.id[0]) gv(`${v.id} is not in family ${v.family}`);
  if (v.skip && !v.targets.includes(v.skip.target))
    gv(`${v.id} skips ${v.skip.target}, which it doesn't target`);
  if (v.skip && v.targets.every((t) => t === v.skip.target)) gv(`${v.id} skips every target`);
  const steps = flat([...(v.setup ?? []), ...(v.trigger ?? [])]);
  if (v.observe?.hopped && !steps.some((step) => step.hops))
    gv(`${v.id}: hopped requires a hops step`);
  const runnable = steps.some((st) => st.cdp || st.page || st.extensionWorld || st.unparseable);
  if (v.kind === 'cdp' && !runnable) gv(`${v.id} is kind cdp with no cdp or page step`);
  if (v.kind === 'text' && runnable) gv(`${v.id} is kind text with a cdp or page step`);
  const all = [...(v.setup ?? []), ...(v.trigger ?? [])];
  const control = methods(all, 'control');
  for (const m of new Set(methods(all, 'guarded'))) {
    if (!control.includes(m)) gv(`${v.id} calls ${m} on the guarded leg but not on the control`);
  }
  for (const st of steps) {
    if (st.refusal) {
      try {
        new RegExp(st.refusal.match);
      } catch {
        gv(`${v.id}: refusal.match ${st.refusal.match} doesn't compile`);
      }
    }
  }
  const refusals = steps.flatMap((st, i) => (st.refusable ? [st.as ?? `refused.${i}`] : []));
  const first = steps.findIndex((st) => st.refusable);
  const before = new Set(first < 0 ? [] : steps.slice(0, first).flatMap((st) => st.as ?? []));
  for (const [name, o] of Object.entries(v.observe ?? {})) {
    if (!o.check) gv(`${v.id}: ${name} lacks a check`);
    checkRefusals(o.check, v.id);
    if (first >= 0 && !before.has(name) && !o.dependsOn)
      gv(`${v.id} observes ${name} after a refusable step without dependsOn`);
    for (const d of o.dependsOn ?? []) {
      if (!refusals.includes(d))
        gv(`${v.id}: ${name} depends on ${d}, which isn't a refusable step`);
    }
  }
  const optional = new Set(Object.values(v.observe ?? {}).flatMap((o) => o.requires ?? []));
  const needs = new Set();
  const top = [...(v.setup ?? []), ...(v.trigger ?? [])];
  for (const st of flat(top)) {
    const want = [];
    if (
      top.includes(st) &&
      (st.cdp === 'Target.setAutoAttach' || st.children || st.session === 'child')
    )
      want.push('autoAttach');
    if (st.session === 'browser') want.push('browserSession');
    if (st.cdp === 'Target.createBrowserContext' || st.cdp === 'Target.disposeBrowserContext')
      want.push('browserContexts');
    for (const c of want) {
      if (!(st.requires ?? []).includes(c))
        gv(`${v.id}: a ${st.cdp ?? st.page ?? 'children'} step doesn't require ${c}`);
    }
    for (const c of st.requires ?? []) needs.add(c);
  }
  const requires = new Set(v.requires ?? []);
  if (
    [...requires].some((c) => !needs.has(c) && !optional.has(c)) ||
    [...needs].some((c) => !requires.has(c))
  )
    gv(
      `${v.id} requires ${[...requires].join(', ') || 'nothing'}, not ${[...needs].join(', ') || 'nothing'}`
    );
  if (v.observe) {
    for (const want of [v.control?.expected, v.expected]) {
      for (const k of typeof want === 'object' ? Object.keys(want) : []) {
        if (!Object.hasOwn(v.observe, k)) gv(`${v.id} doesn't define ${k} in observe`);
      }
    }
  }
  for (const text of strings(v)) {
    for (const [, name] of text.matchAll(/\{([A-Za-z][A-Za-z-]*)\}/g)) {
      if (!placeholders.has(name)) gv(`${v.id} uses {${name}}, which placeholders doesn't list`);
    }
  }
}
for (const text of strings(guard.placeholders)) {
  for (const [, name] of text.matchAll(/\{([A-Za-z][A-Za-z-]*)\}/g)) {
    if (!placeholders.has(name)) gv(`placeholders uses {${name}}, which it doesn't list`);
  }
}
const ports = /:922[2-9](?!\d)/;
for (const u of strings(guard)) {
  if (reserved.test(u) || ports.test(u)) gv(`never use ports 9222-9229 (${u})`);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exit(1);
}
const observerNeeded = (check) => {
  if (check?.observer === 'unguarded') return true;
  if (check?.all) return check.all.some(observerNeeded);
  if (check?.any) return check.any.every(observerNeeded);
  return check?.not ? observerNeeded(check.not) : false;
};
const observerRows = guard.vectors.filter(
  (v) =>
    v.kind === 'cdp' &&
    (v.control.via === 'unguarded' ||
      observerNeeded(v.liveCheck) ||
      Object.values(v.observe ?? {}).some((o) => observerNeeded(o.check)))
).length;
process.stdout.write(`guard observers: ${observerRows} runnable vectors require unguarded CDP\n`);
process.stdout.write(
  `validate: PASS catalog.json (${ids.length} browsers), ${corpus.cases.length} corpus cases, the protected-origin vectors and ${guardIds.size} guard vectors\n`
);
