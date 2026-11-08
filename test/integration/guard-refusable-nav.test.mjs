import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { drivable } from './guard-sweep.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const byId = Object.fromEntries(set.vectors.map((vector) => [vector.id, vector]));

const commandRows = [
  'E7.init-world-carry',
  'E7.init-world-bfcache',
  'E7.emulation-carry',
  'E7.init-world-error',
  'E7.isolated-foreign',
  'C3.tab-protected',
  'C3.tab-protected.synthetic',
];

const attackScriptRows = [
  'E7.init-world-carry.script',
  'E7.init-world-bfcache.script',
  'E7.emulation-carry.script',
  'E7.isolated-foreign.script',
];

const positiveScriptRows = ['E7.init-world-error.script'];

const skipped = {
  'C3.tab-protected.script':
    'createTarget with tab auto-attach has no script-initiated command analogue that keeps the same attach contract',
  'C3.tab-protected.synthetic.script':
    'same as C3.tab-protected.script for the synthetic auto-attach filter',
};

test('protected client navigations on the carry and tab-protected rows are refusable commands', () => {
  for (const id of commandRows) {
    const vector = byId[id];
    assert.ok(vector, id);
    const steps = [...vector.setup, ...vector.trigger];
    const refused = steps.filter((step) => step.refusable);
    assert.ok(refused.length > 0, id);
    if (id.startsWith('C3.tab-protected')) {
      assert.ok(
        refused.some(
          (step) =>
            step.cdp === 'Target.createTarget' &&
            String(step.params?.url ?? '').includes('{target}')
        ),
        id
      );
    } else {
      assert.ok(
        refused.some(
          (step) =>
            step.page === 'navigate' &&
            String(step.url ?? '').includes('{target}') &&
            step.as === 'nav' &&
            step.refusal?.match === 'refused'
        ),
        id
      );
    }
    assert.ok(
      JSON.stringify(vector.liveCheck).includes('"refused"'),
      `${id} liveCheck includes refused`
    );
  }
});

test('script-initiated variants exist with the right live shape', () => {
  for (const id of [...attackScriptRows, ...positiveScriptRows]) {
    const vector = byId[id];
    assert.ok(vector, id);
    const steps = [...vector.setup, ...vector.trigger];
    assert.equal(
      steps.some((step) => step.page === 'navigate' && String(step.url ?? '').includes('{target}')),
      false,
      id
    );
    assert.ok(
      steps.some((step) => step.page === 'href' && String(step.url ?? '').includes('{target}')),
      id
    );
    const live = JSON.stringify(vector.liveCheck);
    assert.equal(live.includes('"registration"'), false, id);
    assert.ok(live.includes('"loaded"') || live.includes('"pre"'), id);
  }
  for (const id of attackScriptRows) assert.equal(drivable.has(id), false, id);
  for (const id of positiveScriptRows) assert.equal(drivable.has(id), true, id);
  for (const [id, why] of Object.entries(skipped)) {
    assert.equal(byId[id], undefined, `${id}: ${why}`);
  }
});

test('script carry variants remain attack rows against an ungarded stock client', () => {
  for (const id of attackScriptRows) {
    const vector = byId[id];
    assert.ok(
      Object.entries(vector.expected).some(
        ([name, want]) => want === false && vector.control.expected[name] === true
      ),
      id
    );
  }
});

test('E7.init-world-error.script proves the admitted world on the error page without a command refusal', () => {
  const vector = byId['E7.init-world-error.script'];
  assert.equal(vector.expected.worldOnError, true);
  assert.equal(Object.hasOwn(vector.observe.worldOnError, 'dependsOn'), false);
  assert.ok([...vector.setup, ...vector.trigger].some((step) => step.observer === 'fail'));
});

const effectOnRefusal = {
  'E7.init-world-carry': ['worldOnProtected'],
  'E7.init-world-bfcache': ['worldOnProtected', 'beacon'],
  'E7.emulation-carry': ['exposed', 'beacon'],
  'E7.isolated-foreign': ['world'],
  'E7.isolated-foreign.script': ['world'],
  'C3.tab-protected': ['pageAttached', 'beacon'],
  'C3.tab-protected.synthetic': ['pageAttached', 'beacon'],
};

const keptDependsOn = {
  'E7.init-world-error': ['worldOnError'],
  'C3.tab-protected': ['tab', 'driven'],
  'C3.tab-protected.synthetic': ['tab', 'driven'],
  'E7.isolated-foreign': ['noContext'],
  'E7.isolated-foreign.script': ['noContext'],
};

test('false-by-construction effect checks run on a refused navigation, not only when it loads', () => {
  for (const [id, names] of Object.entries(effectOnRefusal)) {
    const vector = byId[id];
    for (const name of names) {
      assert.equal(
        Object.hasOwn(vector.observe[name], 'dependsOn'),
        false,
        `${id}.${name} must run after a refused command`
      );
      assert.equal(vector.expected[name], false, `${id}.${name}`);
    }
  }
  for (const [id, names] of Object.entries(keptDependsOn)) {
    const vector = byId[id];
    for (const name of names) {
      assert.ok(
        (vector.observe[name].dependsOn ?? []).length > 0,
        `${id}.${name} still needs the load`
      );
    }
  }
  assert.equal(byId['E7.isolated-foreign'].observe.world.check.origin, '{target}');
  assert.equal(byId['E7.isolated-foreign.script'].observe.world.check.origin, '{target}');
});
