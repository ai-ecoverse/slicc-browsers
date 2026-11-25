export const refusal = "slicc: refused: target is on seven's origin";
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

export function fakeBrowser({ guard = 'none', oopif = false, blindAX = false } = {}) {
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
