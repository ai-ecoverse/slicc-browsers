#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
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
for (const name of ['catalog', 'browsers', 'corpus'])
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
    t.chromium < t.electron
  )
) {
  fail('catalog.json: tiers must rise from sevenOpen to electron');
}
for (const pattern of [
  catalog.discovery.chromeMajorPattern,
  catalog.seven.originHostPattern,
  catalog.profiles.sixProfilePattern,
  catalog.profiles.namePattern,
]) {
  new RegExp(pattern);
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
      if ((e.tier === t.sevenOpen) !== open)
        fail(`${label}: ${e.id} tier disagrees with sevenOpen`);
    }
  }
  if (c.needs?.includes('installed') !== Array.isArray(c.installed))
    fail(`${label}: needs installed iff it has installed`);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(
  `ok: catalog.json (${ids.length} browsers) and ${corpus.cases.length} corpus cases\n`
);
