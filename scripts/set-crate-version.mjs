#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2] ?? '';
if (
  !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
  version === '0.0.0'
) {
  process.stderr.write(`refusing to stamp crate version ${JSON.stringify(version)}\n`);
  process.exit(1);
}
const before = readFileSync('Cargo.toml', 'utf8');
const after = before.replace(/^version = "0\.0\.0"$/m, `version = "${version}"`);
if (after === before) {
  process.stderr.write('Cargo.toml has no version = "0.0.0" line\n');
  process.exit(1);
}
const guard = readFileSync('guard-vectors.json', 'utf8');
const stamped = guard.replace(/^ {2}"setVersion": "0\.0\.0",$/m, `  "setVersion": "${version}",`);
if (stamped === guard) {
  process.stderr.write('guard-vectors.json has no "setVersion": "0.0.0" line\n');
  process.exit(1);
}
writeFileSync('Cargo.toml', after);
writeFileSync('guard-vectors.json', stamped);
process.stdout.write(`Cargo.toml and guard-vectors.json are ${version}\n`);
