import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skipped = new Set(['node_modules', '.git', 'target', 'test', 'artifacts', 'coverage', 'src']);
let copy;
let published;

before(async () => {
  copy = await mkdtemp(join(tmpdir(), 'slicc-validate-'));
  await cp(root, copy, {
    recursive: true,
    filter: (source) => !skipped.has(source.slice(root.length).split('/')[0]),
  });
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
  published = await readFile(join(root, 'guard-vectors.json'), 'utf8');
});

after(async () => {
  if (copy) await rm(copy, { recursive: true, force: true });
});

async function validate(change) {
  const set = JSON.parse(published);
  change(set.vectors.find.bind(set.vectors), set);
  await writeFile(join(copy, 'guard-vectors.json'), `${JSON.stringify(set, null, 2)}\n`);
  return spawnSync(process.execPath, ['scripts/validate.mjs'], { cwd: copy, encoding: 'utf8' });
}

const row = (find, id) => find((vector) => vector.id === id);
const step = (vector, as) => [...vector.setup, ...vector.trigger].find((entry) => entry.as === as);

test('the copied files validate unchanged', async () => {
  const run = await validate(() => {});
  assert.equal(run.status, 0, run.stderr);
});

const broken = {
  'a reference to a step no earlier step names': [
    (find) => {
      step(row(find, 'E7.init-script'), 'removeWorld').params.identifier.$result = 'later';
    },
    /E7\.init-script: Page\.removeScriptToEvaluateOnNewDocument references later, which no earlier step names/,
  ],
  'a reference without a path': [
    (find) => {
      delete step(row(find, 'E7.binding'), 'byId').params.executionContextId.path;
    },
    /E7\.binding: a reference in Runtime\.addBinding has no path/,
  ],
  'an event reference that is not a CDP event': [
    (find) => {
      step(row(find, 'E7.binding'), 'byId').params.executionContextId = {
        $event: 'not an event',
        path: 'params.context.id',
      };
    },
    /E7\.binding: Runtime\.addBinding references not an event, which isn't a CDP event/,
  ],
  'a watched check without an observer step': [
    (find) => {
      const vector = row(find, 'E7.init-script');
      vector.setup = vector.setup.filter((entry) => !entry.observer);
    },
    /E7\.init-script: playwrightWorld reads the observer's watch without an observer step/,
  ],
  'an observer result no isolatedWorld step produced': [
    (find) => {
      row(find, 'E7.binding').observe.namedExposed.check.result = 'named';
    },
    /E7\.binding: namedExposed credits named to the observer, but no isolatedWorld step names it/,
  ],
  'a stockSetup row on a protected target': [
    (find) => {
      row(find, 'E7.emulation').targets = ['seven'];
    },
    /E7\.emulation: a stockSetup row targets ordinary only, with an unguarded control/,
  ],
  'a stockSetup row with a guarded control': [
    (find) => {
      row(find, 'E7.emulation').control.via = 'guard';
    },
    /E7\.emulation: a stockSetup row targets ordinary only, with an unguarded control/,
  ],
  'a synthetic auto-attach step that requires neither attach capability': [
    (find) => {
      const vector = row(find, 'C3.tab-attach.synthetic');
      step(vector, 'tabs').requires = ['browserSession', 'stockSetup'];
    },
    /C3\.tab-attach\.synthetic: a Target\.setAutoAttach step doesn't require autoAttach/,
  ],
  'an observer fail step without a url': [
    (find) => {
      const vector = row(find, 'E7.init-script');
      vector.setup.find((entry) => entry.observer).observer = 'fail';
    },
    /guard-vectors\.json\/vectors\/\d+\/setup\/1: must match exactly one schema in oneOf/,
  ],
};

for (const [name, [change, message]] of Object.entries(broken))
  test(`validate refuses ${name}`, async () => {
    const run = await validate(change);
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stderr, message);
  });
