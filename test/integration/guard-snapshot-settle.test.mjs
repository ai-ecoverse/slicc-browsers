import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { run } from '../../guard-runner.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const targets = {
  ordinary: 'http://ordinary.example.test:5710',
  plain: 'http://plain.example.test:5710',
  'ordinary-same-site': 'http://ordinary.sliccy.ai:5710',
  seven: 'http://seven.sliccy.ai:5710',
  vault: 'http://vault.sliccy.ai:5710',
  client: 'http://client.example.test:5710',
};

async function delayedFrame(id, { commit = true, tree = true, leak = false } = {}) {
  const entries = [];
  const pages = new Map();
  const sessions = new Map();
  const reads = { control: 0, guarded: 0 };
  const first = {};
  let next = 0;
  const client = {
    events: [],
    async send(method, params = {}, sessionId) {
      if (/^Page\.(addScriptToEvaluateOnNewDocument|setBypassCSP)$/.test(method))
        throw new Error('slicc: refused: persistent instrumentation');
      const page = pages.get(sessions.get(sessionId));
      const spawn = (url) => {
        const side = url.startsWith(targets.seven) ? 'guarded' : 'control';
        page.side = side;
        page.destination = url;
        page.frame = { id: 'child', parentId: page.id, url: 'about:blank' };
        entries.push({ url });
        const tag = new URL(url).searchParams.get('n');
        entries.push({
          url: `${targets.ordinary}/live?tag=${tag}&step=pre&to=${encodeURIComponent(url)}`,
        });
        if (side === 'guarded') {
          page.frame.url = leak ? url : 'chrome-error://chromewebdata/';
          if (!leak) page.frame.unreachableUrl = url;
        }
        const childSession = `S${++next}`;
        sessions.set(childSession, page.id);
        client.events.push({
          method: 'Target.attachedToTarget',
          sessionId,
          params: {
            sessionId: childSession,
            waitingForDebugger: true,
            targetInfo: { targetId: `I${next}`, type: 'iframe', url: 'about:blank' },
          },
        });
      };
      if (method === 'Target.createTarget') {
        const targetId = `T${++next}`;
        pages.set(targetId, { id: targetId, url: params.url });
        return { targetId };
      }
      if (method === 'Target.getTargetInfo')
        return { targetInfo: { targetId: params.targetId, type: 'page' } };
      if (method === 'Target.attachToTarget') {
        const sessionId = `S${++next}`;
        sessions.set(sessionId, params.targetId);
        pages.get(params.targetId).session ??= sessionId;
        return { sessionId };
      }
      if (method === 'Page.navigate') {
        page.url = params.url;
        const url = new URL(params.url);
        if (url.pathname === '/framed') spawn(url.searchParams.get('url'));
        return { frameId: page.id };
      }
      if (method === 'Runtime.evaluate') {
        const source = params.expression.match(/f\.src=("[^"]+")/);
        if (source) spawn(JSON.parse(source[1]));
        return { result: { value: true } };
      }
      if (method === 'Page.getFrameTree') {
        if (page?.frame && sessionId === page.session) {
          reads[page.side]++;
          if (page.side === 'control' && reads.control >= 2 && commit)
            page.frame.url = page.destination;
          if (reads[page.side] === 1) first[page.side] = structuredClone(page.frame);
        }
        return {
          frameTree: {
            frame: { id: page?.id, url: page?.url },
            childFrames: page?.frame
              ? [
                  {
                    frame: {
                      id: page.frame.id,
                      parentId: page.frame.parentId,
                      url: tree || page.side === 'guarded' ? page.frame.url : 'about:blank',
                    },
                  },
                ]
              : [],
          },
        };
      }
      if (method === 'Target.getTargets')
        return {
          targetInfos: [...pages.values()].flatMap((page) => [
            { targetId: page.id, type: 'page', url: page.url },
            ...(page.frame ? [{ targetId: 'iframe', type: 'iframe', url: page.frame.url }] : []),
          ]),
        };
      if (method === 'Target.closeTarget') pages.delete(params.targetId);
      return {};
    },
  };
  const vector = { ...set.vectors.find((vector) => vector.id === id), targets: ['seven'] };
  const execution = await run(
    { ...set, vectors: [vector], variants: { prompt: 0 } },
    {
      client,
      unguarded: client,
      targets,
      fixture: { log: () => [...entries] },
      capabilities: { autoAttach: true, browserSession: true },
      settleScale: 0.01,
      refusalScale: 1,
    }
  );
  return { execution, row: execution.results[0], reads, first };
}

for (const id of [
  'C4.script-same-site',
  'C4.script-cross-site',
  'C4.static-same-site',
  'C4.static-cross-site',
])
  for (const tree of [true, false])
    test(`${id}: served precedes commit and the control waits for ${tree ? 'frame tree' : 'iframe target'} evidence`, async () => {
      const { row, reads, first } = await delayedFrame(id, { tree });
      assert.equal(first.control.url, 'about:blank');
      assert.equal(row.observations.control.loaded, true);
      assert.equal(row.observations.control.frameOnDest, true, JSON.stringify(row));
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, 'pass', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.equal(reads.control, 2);
      assert.equal(reads.guarded, 1);
      assert.deepEqual(row.errors, []);
    });

test('a served control document that never commits is incomplete within the observation bound', async () => {
  const { row, execution, reads } = await delayedFrame('C4.script-same-site', { commit: false });
  assert.equal(row.observations.control.loaded, true);
  assert.equal(row.observations.control.frameOnDest, 'incomplete');
  assert.equal(row.control, 'incomplete', JSON.stringify(row));
  assert.equal(row.guarded, 'pass', JSON.stringify(row));
  assert.equal(execution.summary().pass, false);
  assert.deepEqual(row.incomplete, [
    'control frameOnDest: snapshot evidence not observed within 50ms',
  ]);
  assert.ok(reads.control > 1);
  assert.equal(reads.guarded, 1);
});

test('a guard that exposes the destination still fails without control-style snapshot retries', async () => {
  const { row, reads } = await delayedFrame('C4.script-same-site', { leak: true });
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.observations.guarded.frameOnDest, true);
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(reads.control, 2);
});
