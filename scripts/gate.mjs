#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const at = args.indexOf('--expect');
const split = args.indexOf('--');
const file = args.indexOf('--in');
if (at < 0 || !args[at + 1] || (split < 0 && file < 0)) {
  process.stderr.write('usage: gate.mjs --expect <regex> (--in <file> | -- <command> [args...])\n');
  process.exit(2);
}
const expect = new RegExp(args[at + 1]);
const verdict = (text) => text.split(/\r?\n/).some((line) => expect.test(line));
const missing = () => {
  process.stderr.write(`gate: FAIL no line matching /${expect.source}/\n`);
  process.exit(1);
};

if (file >= 0) {
  let text = '';
  try {
    text = readFileSync(args[file + 1], 'utf8');
  } catch {
    missing();
  }
  if (!verdict(text)) missing();
  process.stdout.write(`gate: PASS /${expect.source}/ in ${args[file + 1]}\n`);
} else {
  const [command, ...rest] = args.slice(split + 1);
  if (!command) {
    process.stderr.write('gate: FAIL no command\n');
    process.exit(2);
  }
  const child = spawn(command, rest, { stdio: ['inherit', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    process.stdout.write(chunk);
  });
  child.on('error', (error) => {
    process.stderr.write(`gate: FAIL ${error.message}\n`);
    process.exit(1);
  });
  child.on('close', (code, signal) => {
    if (code !== 0) {
      process.stderr.write(`gate: FAIL ${command} exited ${signal ?? code}\n`);
      process.exit(code || 1);
    }
    if (!verdict(out)) missing();
  });
}
