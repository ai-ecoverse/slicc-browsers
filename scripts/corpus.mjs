#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'corpus');
const out = join(root, 'corpus.json');

export function bundle() {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const cases = names.map((name) => {
    const read = (file) => {
      const path = join(dir, name, file);
      if (!existsSync(path)) throw new Error(`corpus/${name}/${file} is missing`);
      return JSON.parse(readFileSync(path, 'utf8'));
    };
    return { name, case: read('case.json'), expected: read('expected.json') };
  });
  return `${JSON.stringify({ schema: 1, cases }, null, 2)}\n`;
}

const main = (url) => {
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
};

if (process.argv[1] && main(import.meta.url)) {
  const text = bundle();
  const count = JSON.parse(text).cases.length;
  if (process.argv.includes('--check')) {
    const have = existsSync(out) ? readFileSync(out, 'utf8').replaceAll('\r\n', '\n') : '';
    if (have !== text) {
      process.stderr.write('corpus.json is out of date; run npm run corpus\n');
      process.exit(1);
    }
    process.stdout.write(`corpus: PASS ${count} cases\n`);
  } else {
    writeFileSync(out, text);
    process.stdout.write(`wrote corpus.json\n`);
  }
}
