#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));

const exercises = {
  'protected.mjs': ({ protectedOrigins }) => {
    const p = protectedOrigins(catalog.protectedOrigins, ['http://127.0.0.1:5710']);
    return (
      p.url('https://seven.sliccy.ai/') &&
      !p.url('https://example.com/') &&
      p.url('http://127.0.0.1:5710/') &&
      p.unparseable('http://exa%20mple.sliccy.ai/') &&
      !p.unparseable('https://example.com/')
    );
  },
  'seven.mjs': ({ isSevenLabel }) =>
    isSevenLabel(catalog.seven, 'seven') && !isSevenLabel(catalog.seven, 'www'),
};

export async function check(path) {
  const name = basename(path);
  if (!vm.SourceTextModule)
    throw new Error('self-contained: run node with --experimental-vm-modules');
  const source = readFileSync(path, 'utf8');
  const problems = [];
  const fail = (message) => problems.push(`${name}: ${message}`);
  if (/^\s*import\b(?!\s*\()/m.test(source)) fail('has an import statement');
  if (/\bimport\s*\(/.test(source)) fail('has a dynamic import()');
  if (/\bimport\.meta\b/.test(source)) fail('uses import.meta');
  if (/^\s*export\b[^;]*\bfrom\s*['"]/m.test(source)) fail('has an export-from statement');
  const context = vm.createContext({ URL: globalThis.URL });
  let module;
  try {
    module = new vm.SourceTextModule(source, { context, identifier: name });
  } catch (error) {
    fail(`does not compile as a module: ${error.message}`);
    return problems;
  }
  const requests = (module.moduleRequests ?? []).map((r) => r.specifier);
  if (requests.length > 0) fail(`imports ${requests.join(', ')}`);
  try {
    await module.link((specifier) => {
      throw new Error(`no linker resolution allowed (${specifier})`);
    });
    await module.evaluate();
  } catch (error) {
    fail(`does not load with only globalThis.URL: ${error.message}`);
    return problems;
  }
  const exercise = exercises[name];
  try {
    if (exercise && !exercise(module.namespace)) fail('gives wrong answers in isolation');
  } catch (error) {
    fail(`fails in isolation: ${error.message}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  const problems = (await Promise.all(files.map((f) => check(resolve(f))))).flat();
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`self-contained: PASS ${files.map((f) => basename(f)).join(', ')}\n`);
}
