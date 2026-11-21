import { protectedOrigins } from '../../protected.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const refusal = (what) => new Error(`slicc: refused: ${what}`);
const autoAttach = ['Target.setAutoAttach', 'Target.autoAttachRelated'];
const discovery = ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.attachedToTarget'];
const blank = (url) => !url || url === 'about:blank';

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

function leaked(info, leak) {
  const parsed = new URL(info.url);
  if (leak === 'path')
    return { ...info, url: `${parsed.origin}${parsed.pathname}`, title: parsed.origin };
  if (leak === 'query')
    return { ...info, url: `${parsed.origin}/${parsed.search}`, title: parsed.origin };
  return { ...info, url: parsed.origin, title: decodeURIComponent(parsed.search) };
}

export function explicitAttachGuard(browser, options = {}) {
  const { client, unguarded } = browser;
  const mutant = options.explicitAttach === true ? {} : (options.explicitAttach ?? {});
  const catalog = protectedOrigins(options.protectedOrigins, options.extraOrigins ?? []);
  const known = new Set();
  const events = [];
  const waiters = new Set();
  let cursor = 0;
  let stopped = false;
  const protectedUrl = (url) => !blank(url) && catalog.url(url, { readOnly: true });
  const learn = (info) => {
    if (info?.targetId && protectedUrl(info.url)) known.add(info.targetId);
    return Boolean(info?.targetId && known.has(info.targetId));
  };
  const redact = (info) => {
    if (blank(info.url)) return info;
    if (mutant.leak) return leaked(info, mutant.leak);
    const origin = originOf(info.url);
    return { ...info, url: origin, title: origin };
  };
  const shown = (info, leak, where) => {
    if (!learn(info) || leak) return info;
    if (!mutant.redact) return undefined;
    return relabel(redact(info), where, info);
  };
  const relabel = (info, where, original) =>
    mutant.surrogate?.[where] ? surrogate(info, mutant.surrogate[where], original) : info;
  const surrogate = (info, shape, original) => {
    const origin = originOf(info.url) || info.url;
    const parsed = URL.canParse(origin) ? new URL(origin) : undefined;
    const port = parsed?.port ? `:${parsed.port}` : '';
    const at = (host) => (parsed ? `${parsed.protocol}//${host}/doc` : `${origin}/doc`);
    const leaks = {
      dot: at(`${parsed?.hostname}.${port}`),
      port: at(parsed?.hostname),
      mapped: at(`[::ffff:${parsed?.hostname}]${port}`),
      data: `data:text/plain,${origin}/doc`,
      javascript: `javascript:"${origin}/doc"`,
      fragment: 'about:blank#/doc',
      fragmentTag: `about:blank#/doc?n=${new URL(original.url).searchParams.get('n')}`,
      fragmentHost: `about:blank#${parsed?.hostname}${port}/doc`,
      filesystem: `filesystem:${origin}/persistent/doc`,
      embeddedQuery: `http://ordinary.test/?u=${origin}/doc`,
      embeddedFragment: `http://ordinary.test/#u=${origin}/doc`,
      ordinaryTab: 'http://ordinary.test/doc',
      embeddedOrigin: `http://ordinary.test/?u=${origin}/`,
      relativeUrl: `//${parsed?.hostname}${port}/doc`,
      relativeEmbedded: `http://ordinary.test/?u=//${parsed?.hostname}${port}/doc`,
      relativeBare: `//${parsed?.hostname}${port}`,
    };
    const host = `${parsed?.hostname}${port}`;
    const titles = {
      hostPath: `${parsed?.hostname}/doc`,
      hostPortPath: `${host}/doc`,
      defaultTitle: `${host}/doc?n=1#top`,
      spacedTitle: ` \t${host}/doc`,
      sentence: `a tab on ${host}`,
      bidiTitle: `\u200f${host}/doc`,
      userinfoTitle: `user@${host}/doc`,
      fullwidthTitle: `${host}\uff0fdoc`,
      userinfoBare: `user@${host}`,
      wordTitle: `${parsed?.hostname.split('.')[0]} wonders`,
      fullwidthOrdinary: '\u200f\uff4f\uff52\uff44\uff49\uff4e\uff41\uff52\uff59 page',
    };
    const fields =
      {
        url: { url: `${origin}/doc`, title: origin },
        title: { url: origin, title: `${origin}/doc` },
        bare: { url: origin, title: origin },
        relativeOther: { url: '//other.test/doc', title: 'an ordinary page' },
        tagged: {
          url: 'http://ordinary.test/',
          title: new URL(original.url).searchParams.get('n'),
        },
      }[shape] ??
      (titles[shape] ? { url: '', title: titles[shape] } : { url: leaks[shape], title: '' });
    return { ...info, targetId: 'surrogate', ...fields };
  };
  const protectedTarget = async (targetId) => {
    if (known.has(targetId)) return true;
    const read = await unguarded.send('Target.getTargetInfo', { targetId }).catch(() => undefined);
    return learn(read?.targetInfo);
  };
  const deliver = (event) => {
    events.push(event);
    for (const waiter of waiters)
      if (waiter.predicate(event)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
  };
  const watch = (async () => {
    while (!stopped) {
      for (const event of client.events.slice(cursor)) {
        cursor++;
        const info = event.params?.targetInfo;
        if (discovery.includes(event.method) && info) {
          if (blank(info.url)) await protectedTarget(info.targetId);
          const visible = shown(info, mutant.leakEvents, 'events');
          if (visible) deliver({ ...event, params: { ...event.params, targetInfo: visible } });
          continue;
        }
        deliver(event);
      }
      await pause(2);
    }
  })();
  const listed = async (params, sessionId) => {
    const reply = await client.send('Target.getTargets', params, sessionId);
    const infos = (reply.targetInfos ?? []).map((info) => shown(info, mutant.leakList, 'list'));
    return { ...reply, targetInfos: infos.filter(Boolean) };
  };
  const attach = async (params, sessionId) => {
    const { targetId } = params;
    const opened = async () =>
      !blank((await unguarded.send('Target.getTargetInfo', { targetId })).targetInfo.url);
    if (mutant.dropAttach && (await opened())) return new Promise(() => {});
    if (!mutant.allowAttach && (await protectedTarget(targetId))) throw refusal('protected target');
    const reply = await client.send('Target.attachToTarget', params, sessionId);
    if (mutant.cut && (await opened()))
      setTimeout(() => {
        client.send('Target.detachFromTarget', { sessionId: reply.sessionId }).catch(() => {});
      }, 0);
    return reply;
  };
  const send = async (method, params = {}, sessionId) => {
    if (autoAttach.includes(method)) throw refusal('explicit attach only');
    if (method === 'Target.setDiscoverTargets' && mutant.dropDiscover) return new Promise(() => {});
    if (method === 'Target.getTargets' && mutant.failList) throw new Error('Internal error');
    if (method === 'Target.getTargets') return listed(params, sessionId);
    if (method === 'Target.attachToTarget') return attach(params, sessionId);
    if (method === 'Target.getTargetInfo' && params.targetId && !mutant.leakInfo) {
      if (await protectedTarget(params.targetId)) {
        if (!mutant.redact) throw refusal('protected target');
        const reply = await client.send(method, params, sessionId);
        return { targetInfo: relabel(redact(reply.targetInfo), 'info', reply.targetInfo) };
      }
    }
    if (method === 'Target.createTarget' && mutant.refuseCreate) throw refusal('target creation');
    return client.send(method, params, sessionId);
  };
  return {
    client: {
      transport: client.transport ?? 'cdp',
      events,
      send,
      waitEvent: (predicate, ms = 10000) =>
        new Promise((resolve, reject) => {
          const found = events.find(predicate);
          if (found) return resolve(found);
          const waiter = { predicate, resolve };
          waiters.add(waiter);
          setTimeout(() => {
            if (waiters.delete(waiter)) reject(new Error('CDP event timed out'));
          }, ms);
        }),
    },
    stop: async () => {
      stopped = true;
      await watch;
    },
  };
}
