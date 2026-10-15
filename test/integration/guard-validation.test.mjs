import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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
