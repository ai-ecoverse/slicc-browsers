import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { run } from '../../guard-runner.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const refusal = "slicc: refused: target is on seven's origin";
const reads = [
  'Page.getFrameTree',
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.getOuterHTML',
  'DOMSnapshot.captureSnapshot',
];

function layoutOf(url) {
  const page = new URL(url);
  if (page.pathname !== '/framed') return undefined;
  const nest = new URL(page.searchParams.get('url'));
  const tag = nest.searchParams.get('n');
  return {
    top: url,
    origin: nest.origin,
    framed: `${nest.origin}/nest/path-secret-${tag}?query-secret=${tag}`,
    fragment: `#fragment-secret-${tag}`,
    child: nest.searchParams.get('kind') === 'srcdoc' ? 'about:srcdoc' : 'about:blank',
    marker: `frame-marker-${tag}`,
  };
}

function answer(method, params, frames, { oopif = false, blindAX = false } = {}) {
  const { marker } = frames;
  const paragraph = {
    nodeId: 21,
    backendNodeId: 21,
    nodeType: 1,
    nodeName: 'P',
    children: [
      { nodeId: 22, backendNodeId: 22, nodeType: 3, nodeName: '#text', nodeValue: marker },
    ],
  };
  const childDocument = {
    nodeId: 20,
    backendNodeId: 20,
    nodeType: 9,
    nodeName: '#document',
    documentURL: frames.child,
    children: [paragraph],
  };
  const protectedDocument = {
    nodeId: 10,
    backendNodeId: 10,
    nodeType: 9,
    nodeName: '#document',
    documentURL: `${frames.framed}${frames.fragment}`,
    children: [
      { nodeId: 11, backendNodeId: 11, nodeType: 3, nodeName: '#text', nodeValue: marker },
      {
        nodeId: 12,
        backendNodeId: 12,
        nodeType: 1,
        nodeName: 'IFRAME',
        frameId: 'F2',
        attributes: ['name', marker],
        contentDocument: childDocument,
      },
    ],
  };
  switch (method) {
    case 'Page.getFrameTree':
      return {
        frameTree: {
          frame: { id: 'F0', url: frames.top, securityOrigin: new URL(frames.top).origin },
          childFrames: oopif
            ? []
            : [
                {
                  frame: {
                    id: 'F1',
                    url: frames.framed,
                    urlFragment: frames.fragment,
                    securityOrigin: frames.origin,
                  },
                  childFrames: [{ frame: { id: 'F2', name: marker, url: frames.child } }],
                },
              ],
        },
      };
    case 'DOM.getDocument':
      return {
        root: {
          nodeId: 1,
          backendNodeId: 1,
          nodeType: 9,
          nodeName: '#document',
          documentURL: frames.top,
          children: [
            {
              nodeId: 2,
              backendNodeId: 2,
              nodeType: 1,
              nodeName: 'IFRAME',
              frameId: 'F1',
              attributes: ['src', `${frames.origin}/nest`],
              ...(oopif ? {} : { contentDocument: protectedDocument }),
            },
          ],
        },
      };
    case 'Accessibility.getFullAXTree':
      if (!['F1', 'F2'].includes(params.frameId))
        throw new Error('Frame with the given id was not found.');
      return {
        nodes: blindAX
          ? []
          : [{ nodeId: '1', role: { value: 'StaticText' }, name: { value: marker } }],
      };
    case 'Accessibility.getPartialAXTree':
      return { nodes: [{ nodeId: '1', role: { value: 'paragraph' }, name: { value: marker } }] };
    case 'DOM.describeNode':
      return { node: childDocument };
    case 'DOM.getOuterHTML':
      return { outerHTML: `<p>${marker}</p>` };
    case 'DOMSnapshot.captureSnapshot':
      return {
        documents: [{}, {}, {}],
        strings: [frames.top, frames.framed, frames.fragment, marker],
      };
    default:
      return {};
  }
}

const redacted = (method, params, frames) => {
  switch (method) {
    case 'Page.getFrameTree':
      return {
        frameTree: {
          frame: { id: 'F0', url: frames.top },
          childFrames: [{ frame: { id: 'F1', url: frames.origin, securityOrigin: frames.origin } }],
        },
      };
    case 'DOM.getDocument':
      return {
        root: {
          nodeId: 1,
          backendNodeId: 1,
          nodeType: 9,
          nodeName: '#document',
          documentURL: frames.top,
          children: [
            { nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'IFRAME', frameId: 'F1' },
          ],
        },
      };
    case 'Accessibility.getFullAXTree':
    case 'Accessibility.getPartialAXTree':
      return { nodes: [] };
    case 'DOMSnapshot.captureSnapshot':
      return { documents: [{}], strings: [frames.top, frames.origin] };
    default:
      throw new Error('No node with given id found');
  }
};

function fakeBrowser({ guard = 'none', oopif = false, blindAX = false } = {}) {
  const targets = new Map();
  const sessions = new Map();
  let next = 0;
  const raw = (kind) => ({
    events: [],
    messages: [],
    async send(method, params = {}, sessionId) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const target = targets.get(sessions.get(sessionId));
      if (method === 'Target.createTarget') {
        const targetId = `T${++next}`;
        targets.set(targetId, { url: params.url });
        return { targetId };
      }
      if (method === 'Target.getTargetInfo') {
        const url = targets.get(params.targetId)?.url ?? '';
        return { targetInfo: { targetId: params.targetId, type: 'page', url, title: url } };
      }
      if (method === 'Target.attachToTarget') {
        const sessionId = `S${++next}`;
        sessions.set(sessionId, params.targetId);
        return { sessionId };
      }
      if (method === 'Page.navigate' && target) {
        target.url = params.url;
        target.frames = layoutOf(params.url);
        return { frameId: 'F0' };
      }
      if (target?.frames)
        return answer(method, params, target.frames, {
          oopif,
          blindAX: blindAX && kind === 'observer',
        });
      if (method === 'Page.getFrameTree')
        return {
          frameTree: { frame: { id: 'F', loaderId: 'L', url: target?.url ?? 'about:blank' } },
        };
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'complete' } };
      return {};
    },
    waitEvent: () => new Promise(() => {}),
  });
  const unguarded = raw('observer');
  const inner = raw('client');
  const client = {
    ...inner,
    async send(method, params = {}, sessionId) {
      const frames = targets.get(sessions.get(sessionId))?.frames;
      if (
        guard === 'attach' &&
        method === 'Target.attachToTarget' &&
        targets.get(params.targetId)?.frames
      )
        throw new Error(refusal);
      if (!frames || !reads.includes(method) || guard === 'none')
        return inner.send(method, params, sessionId);
      if (guard === 'hang') throw new Error(`CDP timed out: ${method}`);
      if (guard === 'half' && method === 'Accessibility.getFullAXTree')
        if (params.frameId === 'F1') return inner.send(method, params, sessionId);
        else throw new Error(`CDP timed out: ${method}`);
      if (guard === 'half') throw new Error(refusal);
      if (guard === 'refuse') throw new Error(refusal);
      if (guard === 'show-ax' && method.startsWith('Accessibility.'))
        return inner.send(method, params, sessionId);
      if (guard === 'show-dom' && method === 'DOM.getDocument')
        return inner.send(method, params, sessionId);
      return redacted(method, params, frames);
    },
  };
  return { client, unguarded };
}

async function rows(ids, browser, capabilities) {
  const fixture = await fixtureServer();
  try {
    const origin = (host) => `http://${host}:${fixture.port}`;
    const execution = await run(
      { ...set, vectors: set.vectors.filter((v) => ids.includes(v.id)), variants: { prompt: 0 } },
      {
        ...browser,
        fixture,
        settleScale: 0.05,
        ...(capabilities ? { capabilities } : {}),
        targets: {
          ordinary: origin('ordinary.example.test'),
          'ordinary-same-site': origin('ordinary.sliccy.ai'),
          plain: origin('ordinary.example.test'),
          seven: origin('seven.sliccy.ai'),
          vault: origin('vault.sliccy.ai'),
          'vault-x': origin('vault-x.sliccy.ai'),
          apex: origin('sliccy.ai'),
          own: origin('client.example.test'),
          client: origin('client.example.test'),
          log: origin('log.example.test'),
        },
      }
    );
    return execution;
  } finally {
    await fixture.close();
  }
}

const same = ['C4.iframe-preattach.blank', 'C4.iframe-preattach.srcdoc'];
const shared = ['C4.iframe-preattach.blank.shared', 'C4.iframe-preattach.srcdoc.shared'];

for (const [guard, verdict, shown] of [
  [
    'none',
    'fail',
    [
      'frameTreeShown',
      'axFullShown',
      'axPartialShown',
      'documentShown',
      'nodeShown',
      'snapshotShown',
    ],
  ],
  ['show-ax', 'fail', ['axFullShown', 'axPartialShown']],
  ['show-dom', 'fail', ['documentShown']],
  ['refuse', 'pass', []],
  ['origin', 'pass', []],
  ['attach', 'pass', []],
])
  test(`pre-attached same-process child frames: a guard that answers ${guard} is ${verdict}`, async () => {
    const execution = await rows(same, fakeBrowser({ guard }));
    assert.equal(execution.results.length, 2);
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', JSON.stringify(row));
      assert.equal(row.live, 'pass', JSON.stringify(row));
      assert.equal(row.guarded, verdict, JSON.stringify(row));
      assert.deepEqual(
        Object.entries(row.observations.guarded)
          .filter(([, value]) => value === true)
          .map(([name]) => name)
          .filter((name) => name !== 'live'),
        shown
      );
    }
  });

test('the shared-process rows skip without siteIsolationOff and run with it', async () => {
  const without = await rows(shared, fakeBrowser({ guard: 'refuse' }), {
    autoAttach: true,
    browserSession: true,
  });
  assert.equal(without.results.length, 8);
  for (const row of without.results) {
    assert.equal(row.guarded, 'skip');
    assert.equal(row.reason, 'not-supported:siteIsolationOff');
  }
  assert.deepEqual(without.summary().forged, []);
  const showing = await rows(
    ['C4.iframe-preattach.srcdoc.shared'],
    fakeBrowser({ guard: 'show-ax' }),
    {
      siteIsolationOff: true,
    }
  );
  assert.deepEqual(
    showing.results.map((row) => [row.target, row.control, row.guarded]),
    ['seven', 'vault', 'vault-x', 'apex'].map((target) => [target, 'pass', 'fail'])
  );
  const refusing = await rows(
    ['C4.iframe-preattach.blank.shared'],
    fakeBrowser({ guard: 'origin' }),
    {
      siteIsolationOff: true,
    }
  );
  for (const row of refusing.results) assert.equal(row.guarded, 'pass', JSON.stringify(row));
});

test('a protected frame in another process is incomplete, never a pass', async () => {
  const execution = await rows(
    ['C4.iframe-preattach.blank'],
    fakeBrowser({ guard: 'refuse', oopif: true })
  );
  const [row] = execution.results;
  assert.equal(row.control, 'incomplete', JSON.stringify(row));
  assert.equal(row.guarded, 'incomplete', JSON.stringify(row));
  assert.equal(row.live, 'incomplete', JSON.stringify(row));
  assert.match(row.incomplete[0], /^control frameRead: frame-read: no about:blank child of /);
  assert.equal(execution.summary().pass, false);
});

test('a read the observer cannot show, or the guard never answers, is incomplete', async () => {
  const blind = (
    await rows(['C4.iframe-preattach.srcdoc'], fakeBrowser({ guard: 'refuse', blindAX: true }))
  ).results[0];
  assert.equal(blind.control, 'incomplete', JSON.stringify(blind));
  assert.equal(blind.guarded, 'incomplete', JSON.stringify(blind));
  assert.equal(blind.observations.guarded.axFullShown, 'incomplete');
  assert.match(blind.incomplete[0], /observer axFull did not show the frame's content/);
  const hung = (await rows(['C4.iframe-preattach.srcdoc'], fakeBrowser({ guard: 'hang' })))
    .results[0];
  assert.equal(hung.control, 'pass', JSON.stringify(hung));
  assert.equal(hung.guarded, 'incomplete', JSON.stringify(hung));
  assert.equal(hung.observations.guarded.documentShown, 'incomplete');
  assert.match(hung.incomplete[0], /^guarded frameRead: frame-read: frameTree unanswered/);
});

test('a grouped read that shows the marker before an unanswered call fails', async () => {
  const [row] = (await rows(['C4.iframe-preattach.blank'], fakeBrowser({ guard: 'half' }))).results;
  assert.equal(row.control, 'pass', JSON.stringify(row));
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.axFullShown, true);
});

test('a read the observer could not prove still fails when the guarded client sees the marker', async () => {
  const [row] = (
    await rows(['C4.iframe-preattach.srcdoc'], fakeBrowser({ guard: 'show-ax', blindAX: true }))
  ).results;
  assert.equal(row.guarded, 'fail', JSON.stringify(row));
  assert.equal(row.observations.guarded.axFullShown, true);
});
