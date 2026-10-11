#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = bundle();
  if (process.argv.includes('--check')) {
    const have = existsSync(out) ? readFileSync(out, 'utf8') : '';
    if (have !== text) {
      process.stderr.write('corpus.json is out of date; run npm run corpus\n');
      process.exit(1);
    }
    process.stdout.write('corpus.json is up to date\n');
  } else {
    writeFileSync(out, text);
    process.stdout.write(`wrote corpus.json\n`);
  }
}
