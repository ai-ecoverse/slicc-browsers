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
  copy = await mkdtemp(join(tmpdir(), 'slicc-validate-explicit-'));
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
  change(set.vectors.find.bind(set.vectors));
  await writeFile(join(copy, 'guard-vectors.json'), `${JSON.stringify(set, null, 2)}\n`);
  return spawnSync(process.execPath, ['scripts/validate.mjs'], { cwd: copy, encoding: 'utf8' });
}

const attach = (find) => find((vector) => vector.id === 'C3.tab-attach.explicit');
const guarded = (find) => find((vector) => vector.id === 'C3.tab-protected.explicit');
const step = (vector, as) => [...vector.setup, ...vector.trigger].find((entry) => entry.as === as);

test('the explicit rows validate unchanged', async () => {
  const run = await validate(() => {});
  assert.equal(run.status, 0, run.stderr);
});

const broken = {
  'an explicit row that requires autoAttach': [
    (find) => attach(find).requires.push('autoAttach'),
    /C3\.tab-attach\.explicit: an explicitAttach row is gated on autoAttach/,
  ],
  'an explicit step gated on stockSetup': [
    (find) => step(attach(find), 'listed').requires.push('stockSetup'),
    /C3\.tab-attach\.explicit: an explicitAttach row is gated on stockSetup/,
  ],
  'an explicit row that calls Target.setAutoAttach': [
    (find) =>
      attach(find).setup.push({
        cdp: 'Target.setAutoAttach',
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        session: 'browser',
        requires: ['explicitAttach', 'browserSession', 'discovery'],
      }),
    /C3\.tab-attach\.explicit: an explicitAttach row auto-attaches/,
  ],
  'an explicit row with a children step': [
    (find) =>
      attach(find).setup.push({ children: [{ cdp: 'Page.enable' }], requires: ['explicitAttach'] }),
    /C3\.tab-attach\.explicit: an explicitAttach row auto-attaches/,
  ],
  'an explicit row without discovery': [
    (find) => {
      const vector = guarded(find);
      vector.requires = ['explicitAttach', 'browserSession'];
      for (const entry of [...vector.setup, ...vector.trigger])
        if (entry.requires) entry.requires = entry.requires.filter((c) => c !== 'discovery');
    },
    /C3\.tab-protected\.explicit: an explicitAttach row needs discovery/,
  ],
  'an explicit row with a guarded control': [
    (find) => {
      guarded(find).control.via = 'guard';
    },
    /C3\.tab-protected\.explicit: an explicitAttach row needs an unguarded control/,
  ],
  'an explicit row without a rawTarget step': [
    (find) => {
      const vector = attach(find);
      vector.trigger = vector.trigger.filter((entry) => !entry.rawTarget);
    },
    /C3\.tab-attach\.explicit: an explicitAttach row has no rawTarget step/,
  ],
  'an explicit row that never binds the child session': [
    (find) => {
      delete step(attach(find), 'attach').bindSession;
    },
    /C3\.tab-attach\.explicit: an explicitAttach row binds the child session once/,
  ],
  'bindSession on a step that is not Target.attachToTarget': [
    (find) => {
      step(attach(find), 'listed').bindSession = 'child';
    },
    /C3\.tab-attach\.explicit: bindSession is only for Target\.attachToTarget/,
  ],
  'a rawTarget step outside an explicit row': [
    (find) => {
      find((vector) => vector.id === 'C3.tab-attach').trigger.push({
        rawTarget: { type: 'page', ms: 1000 },
        as: 'raw',
        requires: ['autoAttach'],
      });
    },
    /C3\.tab-attach: a rawTarget step needs an explicitAttach row/,
  ],
  'a refusable explicit attach that does not expect attachRefused true': [
    (find) => {
      guarded(find).expected.attachRefused = false;
    },
    /C3\.tab-protected\.explicit: a refusable explicit attach needs attachRefused true/,
  ],
  'an explicit child step without explicitAttach': [
    (find) => {
      step(attach(find), 'reach').requires = ['browserSession'];
    },
    /C3\.tab-attach\.explicit: a Runtime\.evaluate child step doesn't require explicitAttach/,
  ],
  'an explicit row that creates its target through the guarded client': [
    (find) => {
      const created = step(guarded(find), 'created');
      delete created.via;
      created.requires = ['explicitAttach', 'browserSession'];
    },
    /C3\.tab-protected\.explicit: an explicitAttach row creates or opens a target through the guarded client/,
  ],
  'an explicit row that opens a page through the guarded client': [
    (find) => {
      attach(find).trigger.unshift({ page: 'tab', url: '{ordinary}/blank' });
    },
    /C3\.tab-attach\.explicit: an explicitAttach row creates or opens a target through the guarded client/,
  ],
  'an observer step outside an explicit row': [
    (find) => {
      const created = find((vector) => vector.id === 'C3.tab-protected').trigger[0];
      created.via = 'unguarded';
    },
    /C3\.tab-protected: a via step needs an explicitAttach row/,
  ],
  'a rawTarget type the runner does not know': [
    (find) => {
      attach(find).trigger.find((entry) => entry.rawTarget).rawTarget.type = 'browser';
    },
    /guard-vectors\.json\/vectors\/\d+\/trigger\/2: must match exactly one schema in oneOf/,
  ],
};

for (const [name, [change, message]] of Object.entries(broken))
  test(`validate refuses ${name}`, async () => {
    const run = await validate(change);
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stderr, message);
  });
