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

const scriptRows = [
  'E7.init-world-carry.script',
  'E7.init-world-bfcache.script',
  'E7.emulation-carry.script',
  'E7.isolated-foreign.script',
];

const skipped = {
  'E7.init-world-error.script':
    'parent expects the admitted world on the error page, so a script load still passes without a guard',
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

test('script-initiated carry variants exist, stay off drivable, and omit command refusal live', () => {
  for (const id of scriptRows) {
    const vector = byId[id];
    assert.ok(vector, id);
    assert.equal(drivable.has(id), false, id);
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
    assert.ok(live.includes('"blocked"') || live.includes('"history"'), id);
  }
  for (const [id, why] of Object.entries(skipped)) {
    assert.equal(byId[id], undefined, `${id}: ${why}`);
  }
});

test('script carry variants remain attack rows against an ungarded stock client', () => {
  for (const id of scriptRows) {
    const vector = byId[id];
    assert.ok(
      Object.entries(vector.expected).some(
        ([name, want]) => want === false && vector.control.expected[name] === true
      ),
      id
    );
  }
});
