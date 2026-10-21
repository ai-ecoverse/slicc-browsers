import { outcome, parseURL, waitFor } from './guard-driver.mjs';
import { createObserverTarget } from './observer-target.mjs';

export const frameReads = ['frameTree', 'axFull', 'axPartial', 'document', 'node', 'snapshot'];

const unanswered = (out) => !out.ok && /timed out|closed/i.test(out.error?.message ?? '');

export function frameReadCalls(layout) {
  return {
    frameTree: [['Page.getFrameTree', {}]],
    axFull: [
      ['Accessibility.getFullAXTree', { frameId: layout.frame }],
      ['Accessibility.getFullAXTree', { frameId: layout.child }],
    ],
    axPartial: [
      ['Accessibility.getPartialAXTree', { backendNodeId: layout.marker, fetchRelatives: true }],
    ],
    document: [['DOM.getDocument', { depth: -1, pierce: true }]],
    node: [
      ['DOM.describeNode', { backendNodeId: layout.childDocument, depth: -1, pierce: true }],
      ['DOM.getOuterHTML', { backendNodeId: layout.marker }],
    ],
    snapshot: [['DOMSnapshot.captureSnapshot', { computedStyles: [] }]],
  };
}

export function frameNeedles(tag) {
  return [
    `frame-marker-${tag}`,
    `path-secret-${tag}`,
    `query-secret=${tag}`,
    `fragment-secret-${tag}`,
  ];
}

const shows = (value, needles) => {
  const text = JSON.stringify(value) ?? '';
  return needles.some((needle) => text.includes(needle));
};

function find(node, test) {
  if (!node) return undefined;
  if (test(node)) return node;
  for (const next of [
    ...(node.children ?? []),
    node.contentDocument,
    ...(node.shadowRoots ?? []),
  ]) {
    const hit = find(next, test);
    if (hit) return hit;
  }
  return undefined;
}

export async function frameLayout(reader, session, { framed, marker, kind }) {
  const { frameTree } = await reader.send('Page.getFrameTree', {}, session);
  const host = (frameTree.childFrames ?? []).find((node) => {
    const url = parseURL(node.frame.url);
    return url?.origin === parseURL(framed)?.origin && url.pathname.startsWith('/nest');
  });
  const child = (host?.childFrames ?? []).find((node) => node.frame.name === marker);
  if (!child || child.frame.url !== kind) return undefined;
  const { root } = await reader.send('DOM.getDocument', { depth: -1, pierce: true }, session);
  const owner = find(
    root,
    (node) =>
      node.nodeName === 'IFRAME' &&
      node.frameId === child.frame.id &&
      (node.attributes ?? []).includes(marker)
  );
  const text = find(
    owner?.contentDocument,
    (node) => node.nodeType === 3 && node.nodeValue === marker
  );
  const paragraph = find(owner?.contentDocument, (node) => (node.children ?? []).includes(text));
  if (!paragraph) return undefined;
  return {
    frame: host.frame.id,
    child: child.frame.id,
    childDocument: owner.contentDocument.backendNodeId,
    marker: paragraph.backendNodeId,
  };
}

async function read(client, session, calls, needles) {
  let shown = false;
  let silent = false;
  for (const [method, params] of calls) {
    const out = await outcome(client.send(method, params, session));
    shown ||= shows(out, needles);
    silent ||= unanswered(out);
  }
  return shown || (silent ? 'incomplete' : false);
}

async function enable(client, session) {
  for (const method of ['Page.enable', 'DOM.enable', 'Accessibility.enable'])
    await outcome(client.send(method, {}, session));
}

export async function frameRead({
  client,
  reader,
  top,
  framed,
  tag,
  mode,
  side,
  notes = [],
  budget = 5000,
}) {
  const kind = mode === 'srcdoc' ? 'about:srcdoc' : 'about:blank';
  const marker = `frame-marker-${tag}`;
  const needles = frameNeedles(tag);
  const nest = `${framed}/nest?n=${encodeURIComponent(tag)}&kind=${mode}`;
  const page = `${top}/framed?tag=${encodeURIComponent(tag)}&url=${encodeURIComponent(nest)}`;
  const result = {};
  const missing = [];
  const done = () =>
    missing.length ? { ...result, incomplete: `frame-read: ${missing.join('; ')}` } : result;
  const opened = await outcome(
    createObserverTarget(reader, { url: 'about:blank', background: true }, notes)
  );
  if (!opened.ok)
    return { incomplete: `frame-read: observer setup failed: ${opened.error.message}` };
  const { targetId } = opened.result;
  let session;
  try {
    const observer = (await reader.send('Target.attachToTarget', { targetId, flatten: true }))
      .sessionId;
    await enable(reader, observer);
    await reader.send('Page.navigate', { url: page }, observer);
    let layout;
    await waitFor(async () => {
      const out = await outcome(frameLayout(reader, observer, { framed, marker, kind }));
      layout = out.result;
      return Boolean(layout);
    }, budget);
    if (!layout) {
      await outcome(reader.send('Target.detachFromTarget', { sessionId: observer }));
      return {
        incomplete: `frame-read: no ${kind} child of ${framed} in the page's renderer within ${budget}ms`,
      };
    }
    result.live = true;
    const calls = frameReadCalls(layout);
    const proven = {};
    for (const name of frameReads) {
      proven[name] = (await read(reader, observer, calls[name], needles)) === true;
      if (!proven[name]) missing.push(`observer ${name} did not show the frame's content`);
    }
    await outcome(reader.send('Target.detachFromTarget', { sessionId: observer }));
    const start = client.events.length;
    const attached = await outcome(
      client.send('Target.attachToTarget', { targetId, flatten: true })
    );
    session = attached.result?.sessionId;
    result.attached = Boolean(session);
    if (!session && (unanswered(attached) || side === 'control')) {
      missing.push(`attach ${attached.error?.message ?? 'returned no session'}`);
      return done();
    }
    if (session) await enable(client, session);
    for (const name of frameReads) {
      const value = session ? await read(client, session, calls[name], needles) : false;
      if (value === 'incomplete') missing.push(`${name} unanswered`);
      result[`${name}Shown`] = value === true || proven[name] ? value : 'incomplete';
    }
    result.eventsShown = shows(
      client.events
        .slice(start)
        .filter(
          (event) => session && (event.sessionId === session || event.params?.sessionId === session)
        ),
      needles
    );
    return done();
  } finally {
    if (session) await outcome(client.send('Target.detachFromTarget', { sessionId: session }));
    await outcome(reader.send('Target.closeTarget', { targetId }));
  }
}
