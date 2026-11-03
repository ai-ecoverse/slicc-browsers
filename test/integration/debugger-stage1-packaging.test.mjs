import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = new URL('../../', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');
const data = JSON.parse(read('debugger-stage1.json'));
const schema = JSON.parse(read('schema/debugger-stage1.schema.json'));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

test('Stage1 data has a strict schema and malformed or unexpected fields are rejected', () => {
  assert.equal(validate(data), true, JSON.stringify(validate.errors));
  for (const mutate of [
    (value) => {
      value.schemaVersion = 2;
    },
    (value) => {
      value.extra = true;
    },
    (value) => {
      value.methods[0].admitted = 'true';
    },
    (value) => {
      value.methods[0].lifetime = 'invalid';
    },
    (value) => {
      value.rows[0].expected.released = 1;
    },
    (value) => {
      delete value.rows[0].requires;
    },
    (value) => {
      value.rescueEvidence.extra = true;
    },
  ]) {
    const invalid = structuredClone(data);
    mutate(invalid);
    assert.equal(validate(invalid), false);
  }
});

test('Stage1 data and schema ship in npm, Rust and Go with file-level documentation', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.exports['./debugger-stage1.json'], './debugger-stage1.json');
  assert.equal(
    pkg.exports['./schema/debugger-stage1.schema.json'],
    './schema/debugger-stage1.schema.json'
  );
  assert.ok(pkg.files.includes('debugger-stage1.json'));
  assert.ok(pkg.files.includes('schema'));
  assert.match(read('Cargo.toml'), /include = .*"\/debugger-stage1\.json"/);
  assert.match(read('Cargo.toml'), /"\/schema\/\*\.json"/);
  assert.match(
    read('src/lib.rs'),
    /DEBUGGER_STAGE1_SCHEMA: &str = include_str!\("\.\.\/schema\/debugger-stage1\.schema\.json"\)/
  );
  assert.match(
    read('src/lib.rs'),
    /DEBUGGER_STAGE1: &str = include_str!\("\.\.\/debugger-stage1\.json"\)/
  );
  assert.match(read('src/lib.rs'), /pub mod debugger_stage1;/);
  assert.match(read('debugger_stage1.go'), /\/\/go:embed debugger-stage1\.json/);
  assert.match(read('debugger_stage1.go'), /\/\/go:embed schema\/debugger-stage1\.schema\.json/);
  assert.match(
    read('scripts/validate.mjs'),
    /check\('debugger-stage1', read\('debugger-stage1\.json'\), 'debugger-stage1\.json'\)/
  );
  assert.match(read('README.md'), /\| \[`debugger-stage1\.json`\]/);
  assert.match(read('README.md'), /`\.\/debugger-stage1\.json`/);
});
