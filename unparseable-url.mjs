import { outcome, owned, parseURL } from './guard-driver.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refused = (out) => !out.ok && /^slicc: refused:/.test(out.error?.message ?? '');
const hosts = [
  ['exa mple.sliccy.ai', 'exa%20mple.sliccy.ai'],
  ['exa%20mple.sliccy.ai', 'exa%20mple.sliccy.ai'],
  ['\u200d.sliccy.ai', 'xn--1ug.sliccy.ai'],
  ['xn--1ug.sliccy.ai', 'xn--1ug.sliccy.ai'],
  ['xn--a.sliccy.ai', 'xn--a.sliccy.ai'],
];

export const rootURL = (root, host, path) =>
  `${root.protocol}//${host}${root.port ? `:${root.port}` : ''}${path}`;

export function canonicalURL(value) {
  if (typeof value !== 'string') return value;
  const direct = parseURL(value);
  if (direct) return direct.href;
  const match = /^(https?:)\/\/([^/?#]+)(.*)$/.exec(value);
  if (!match) return value;
  const [, protocol, authority, path] = match;
  const host = authority.replace(/:\d*$/, '').replaceAll(' ', '%20');
  const port = /:(\d*)$/.exec(authority)?.[1];
  const parsed = parseURL(`${protocol}//example.test${port ? `:${port}` : ''}${path}`);
  if (!parsed) return value;
  return rootURL(parsed, host, `${parsed.pathname}${parsed.search}${parsed.hash}`);
}

async function document(reader, targetId, expected, allowNativeRejection = false) {
  expected = canonicalURL(expected);
  const { sessionId } = await reader.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const deadline = Date.now() + 5000;
    let last;
    let targetURL;
    do {
      const { targetInfo } = await reader.send('Target.getTargetInfo', { targetId });
      targetURL = targetInfo.url;
      if (canonicalURL(targetInfo.url) !== expected) {
        last = { url: targetInfo.url, title: targetInfo.title };
        await pause(25);
        continue;
      }
      if (allowNativeRejection) {
        const { frameTree } = await reader.send('Page.getFrameTree', {}, sessionId);
        if (frameTree.frame.unreachableUrl || frameTree.frame.url.startsWith('chrome-error:'))
          return { nativeRejected: true, url: frameTree.frame.url };
      }
      const out = await outcome(
        reader.send(
          'Runtime.evaluate',
          {
            expression: '({ title: document.title, href: location.href, cookie: document.cookie })',
            returnByValue: true,
          },
          sessionId
        )
      );
      const value = out.result?.result?.value;
      last = value ?? out;
      if (out.ok && value?.title === 'doc' && canonicalURL(value.href) === expected) return value;
      await pause(25);
    } while (Date.now() < deadline);
    if (allowNativeRejection && ['', 'about:blank', 'about:blank#blocked'].includes(targetURL))
      return { nativeRejected: true, url: last?.url ?? '' };
    throw new Error(
      `unparseable: Chrome did not load a fixture document at ${expected}: ${JSON.stringify(last)}`
    );
  } finally {
    await outcome(reader.send('Target.detachFromTarget', { sessionId }));
  }
}

async function documentOutcome(reader, targetId, expected, out, strict) {
  if (refused(out)) return 'guard-refusal';
  if (!out.ok || out.result.errorText || !targetId) return 'native-rejection';
  const loaded = await document(reader, targetId, expected, !strict);
  return loaded.nativeRejected ? 'native-rejection' : 'document';
}

async function destinations({ client, reader, root, tag, targets, session, targetId }) {
  const result = {
    createRefused: true,
    navigateRefused: true,
    createAnswered: true,
    navigateAnswered: true,
    spaceCreated: true,
    spaceNavigated: true,
    responses: [],
  };
  const invalid = (out) =>
    out.error?.code === -32000 && /invalid URL/i.test(out.error?.message ?? '');
  for (const [index, [input, canonical]] of hosts.entries()) {
    const strict = canonical === 'exa%20mple.sliccy.ai';
    const base = rootURL(root, canonical, `/doc?n=${tag}`);
    const created = await outcome(
      client.send('Target.createTarget', {
        url: rootURL(root, input, `/doc?n=${tag}-create-${index}`),
        background: true,
      })
    );
    result.createRefused &&= refused(created);
    result.createAnswered &&= (created.ok && Boolean(created.result.targetId)) || invalid(created);
    if (created.result?.targetId) targets.add(created.result.targetId);
    const createOutcome = await documentOutcome(
      reader,
      created.result?.targetId,
      `${base}-create-${index}`,
      created,
      strict
    );
    const navigated = await outcome(
      client.send(
        'Page.navigate',
        { url: rootURL(root, input, `/doc?n=${tag}-navigate-${index}`) },
        session
      )
    );
    result.navigateRefused &&= refused(navigated);
    result.navigateAnswered &&= navigated.ok || invalid(navigated);
    const navigateOutcome = await documentOutcome(
      reader,
      targetId,
      `${base}-navigate-${index}`,
      navigated,
      strict
    );
    if (strict) {
      result.spaceCreated &&= createOutcome === 'document';
      result.spaceNavigated &&= navigateOutcome === 'document';
    }
    result.responses.push({ input, canonical, created, navigated, createOutcome, navigateOutcome });
    await outcome(
      client.send(
        'Page.navigate',
        { url: rootURL(root, root.hostname, `/doc?n=${tag}-ordinary-${index}`) },
        session
      )
    );
  }
  return result;
}

export async function unparseableURLs({
  client,
  reader,
  session,
  targetId,
  origin,
  tag,
  fixture,
  browserSession,
}) {
  const root = new URL(origin);
  const cookie = `seven-unparseable-${tag}`;
  const value = `secret-${tag}`;
  const targets = new Set();
  let observer;
  try {
    await reader.send('Storage.setCookies', {
      cookies: [{ name: cookie, value, domain: '.sliccy.ai', path: '/', secure: false }],
    });
    const url = rootURL(root, 'exa%20mple.sliccy.ai', `/doc?n=${tag}-observer`);
    const { targetId: probeId } = await reader.send('Target.createTarget', {
      url,
      background: true,
    });
    targets.add(probeId);
    const ground = await document(reader, probeId, url);
    observer = (await reader.send('Target.attachToTarget', { targetId: probeId, flatten: true }))
      .sessionId;
    const listed = browserSession
      ? await outcome(client.send('Target.getTargets', {}))
      : 'not-supported';
    const attached = await outcome(
      client.send('Target.attachToTarget', { targetId: probeId, flatten: true })
    );
    let readCookie = false;
    if (attached.ok) {
      const read = await outcome(
        client.send(
          'Runtime.evaluate',
          {
            expression: `document.cookie.includes(${JSON.stringify(`${cookie}=${value}`)})`,
            returnByValue: true,
          },
          attached.result.sessionId
        )
      );
      readCookie = read.ok && read.result.result?.value === true;
      await outcome(
        client.send('Target.detachFromTarget', { sessionId: attached.result.sessionId })
      );
    }
    const queried = await outcome(client.send('Network.getCookies', { urls: [url] }, session));
    const result = {
      browserVersion: (await reader.send('Browser.getVersion', {})).product,
      live: ground.cookie.includes(`${cookie}=${value}`),
      listed:
        listed === 'not-supported'
          ? listed
          : listed.ok && listed.result.targetInfos?.some((info) => info.targetId === probeId),
      attached: attached.ok,
      attachRefused: refused(attached),
      readCookie,
      cookieRefused: refused(queried),
      cookieDelivered:
        queried.ok &&
        queried.result.cookies?.some((entry) => entry.name === cookie && entry.value === value),
      ...(await destinations({ client, reader, root, tag, targets, session, targetId })),
    };
    await pause(100);
    const requests = await fixture.log();
    result.cookieRequest = owned(requests, tag).some((entry) =>
      entry.url.includes(`${tag}-create-`) || entry.url.includes(`${tag}-navigate-`)
        ? entry.headers.cookie?.includes(`${cookie}=${value}`)
        : false
    );
    return result;
  } finally {
    if (observer)
      await outcome(
        reader.send(
          'Network.deleteCookies',
          { name: cookie, domain: '.sliccy.ai', path: '/' },
          observer
        )
      );
    const listed = await outcome(reader.send('Target.getTargets', {}));
    for (const info of listed.result?.targetInfos ?? [])
      if (info.url.includes(tag)) targets.add(info.targetId);
    for (const targetId of targets) await outcome(reader.send('Target.closeTarget', { targetId }));
  }
}
