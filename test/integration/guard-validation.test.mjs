import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { run } from '../../guard-runner.mjs';

const vectors = JSON.parse(
  await readFile(new URL('../../guard-vectors.json', import.meta.url), 'utf8')
);
const schema = JSON.parse(
  await readFile(new URL('../../schema/guard-vectors.schema.json', import.meta.url), 'utf8')
);
const validate = new Ajv2020({
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
}).compile(schema);

test('the exported schema requires observations, live checks and their observer kinds', () => {
  assert.equal(validate(vectors), true);
  const row = vectors.vectors.find((v) => v.kind === 'cdp');
  const name = Object.keys(row.observe)[0];
  const chain = structuredClone(vectors);
  const withHop = chain.vectors.find((v) => v.observe?.hopped);
  for (const step of [...withHop.setup, ...withHop.trigger]) delete step.hops;
  assert.equal(validate(chain), false);
  for (const mutate of [
    (v) => {
      v.liveCheck = { executed: 'trigger', observer: 'client' };
    },
    (v) => {
      v.liveCheck = { live: true, observer: 'unguarded' };
    },
    (v) => {
      v.liveCheck = { header: 'x-test', on: 'control', observer: 'fixture' };
    },
    (v) => {
      v.liveCheck = { any: [{ executed: 'trigger', observer: 'client' }], observer: 'client' };
    },
    (v) => {
      delete v.observe[name].check;
    },
    (v) => {
      delete v.liveCheck;
    },
    (v) => {
      delete v.observe[name].check.observer;
    },
    (v) => {
      v.observe[name].check = { beacon: '{target}', observer: 'client' };
    },
    (v) => {
      v.observe[name].check = { title: 'doc', via: 'unguarded', observer: 'fixture' };
    },
  ]) {
    const copy = structuredClone(vectors);
    mutate(copy.vectors.find((v) => v.id === row.id));
    assert.equal(validate(copy), false);
  }
});

test('auth refusal patterns are declared and malformed observation patterns fail validation', async () => {
  const auth = vectors.vectors.find((v) => v.id === 'C5.auth');
  assert.equal(auth.observe.refused.check.refusal.match, '^slicc: refused');
  const invalid = structuredClone(vectors);
  invalid.vectors.find((v) => v.id === auth.id).observe.refused.check.refusal = {};
  assert.equal(validate(invalid), false);
  const root = new URL('../../', import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), 'guard-validation-'));
  try {
    await cp(new URL('scripts/', root), join(directory, 'scripts'), { recursive: true });
    for (const name of [
      'schema',
      'corpus',
      'node_modules',
      'catalog.json',
      'corpus.json',
      'protected.json',
      'protected.mjs',
      'seven.mjs',
    ])
      await symlink(new URL(name, root).pathname, join(directory, name));
    const malformed = structuredClone(vectors);
    malformed.vectors.find((v) => v.id === auth.id).observe.refused.check.refusal.match = '[';
    await writeFile(join(directory, 'guard-vectors.json'), JSON.stringify(malformed));
    await assert.rejects(
      promisify(execFile)(process.execPath, [join(directory, 'scripts/validate.mjs')]),
      (error) => error.stderr.includes('C5.auth: observation refusal.match does not compile')
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a caller without the declared observer cannot obtain passing results', async () => {
  const selected = {
    ...vectors,
    vectors: vectors.vectors.filter((v) => ['C5.document', 'C6.getCookies'].includes(v.id)),
  };
  const execution = await run(selected, { fixture: { log: () => [] }, variant: 'prompt' });
  assert(execution.results.every((row) => row.control === 'skip' && row.guarded === 'skip'));
  assert.equal(execution.summary().pass, false);
  assert.equal(execution.summary().observerSkipped, execution.results.length);
  assert(execution.results.every((row) => row.reason === 'not-supported:unguarded-observer'));
});
