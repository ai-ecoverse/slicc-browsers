const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

const titleOf = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith('http') ? parsed.pathname.slice(1) || url : url;
  } catch {
    return url;
  }
};

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

export function explicitBrowser({
  record = () => {},
  unguardedAttach = true,
  observerBlind = false,
  listBlind = false,
  loseRaw = false,
} = {}) {
  let count = 0;
  const next = (prefix) => `${prefix}${++count}`;
  const targets = new Map();
  const sessions = new Map();
  const connections = [];
  const sent = [];
  const info = (target) => ({
    targetId: target.targetId,
    type: target.type,
    title: target.title,
    url: target.url,
    attached: [...sessions.values()].some((session) => session.targetId === target.targetId),
    canAccessOpener: false,
    browserContextId: target.browserContextId,
  });
  const announce = (method, target) => {
    for (const connection of connections)
      if (connection.discover) connection.emit(method, { targetInfo: info(target) });
  };
  const navigate = (page, url) => {
    const tab = targets.get(page.tabId);
    for (const target of [page, tab].filter(Boolean)) {
      target.url = url;
      target.title = titleOf(url);
    }
    record(url);
    const loaderId = next('LOADER');
    for (const [sessionId, session] of sessions)
      if (session.targetId === page.targetId && session.page) {
        session.connection.emit(
          'Page.frameNavigated',
          { frame: { id: page.targetId, loaderId, url, securityOrigin: originOf(url) } },
          sessionId
        );
        session.connection.emit('Page.loadEventFired', { timestamp: 0 }, sessionId);
      }
    announce('Target.targetInfoChanged', page);
    if (tab) announce('Target.targetInfoChanged', tab);
    return loaderId;
  };
  const create = ({ url, browserContextId = 'DEFAULT' }) => {
    const tab = {
      targetId: next('TAB'),
      type: 'tab',
      url: 'about:blank',
      title: 'about:blank',
      browserContextId,
    };
    const page = {
      targetId: next('PAGE'),
      type: 'page',
      url: 'about:blank',
      title: 'about:blank',
      browserContextId,
      tabId: tab.targetId,
    };
    targets.set(tab.targetId, tab);
    targets.set(page.targetId, page);
    announce('Target.targetCreated', tab);
    announce('Target.targetCreated', page);
    if (url && url !== 'about:blank') navigate(page, url);
    return page;
  };
  const close = (targetId) => {
    const page = targets.get(targetId);
    if (!page) return false;
    for (const target of [page, targets.get(page.tabId)].filter(Boolean)) {
      targets.delete(target.targetId);
      for (const [sessionId, session] of sessions)
        if (session.targetId === target.targetId) {
          sessions.delete(sessionId);
          session.connection.emit('Target.detachedFromTarget', {
            sessionId,
            targetId: target.targetId,
          });
        }
      for (const connection of connections)
        if (connection.discover)
          connection.emit('Target.targetDestroyed', { targetId: target.targetId });
    }
    return true;
  };
  const known = (targetId) => {
    const target = targets.get(targetId);
    if (!target) throw new Error('No target with given id found');
    return target;
  };
  const evaluate = (target, expression) => {
    if (/^(self\.)?location\.href$/.test(expression.trim()))
      return { result: { type: 'string', value: target.url } };
    if (expression.trim() === 'document.title')
      return { result: { type: 'string', value: target.title } };
    return { result: { type: 'undefined' } };
  };
  const listing = (filter) => {
    const all = Array.isArray(filter) && filter.length === 1 && Object.keys(filter[0]).length === 0;
    return [...targets.values()].filter((target) => all || target.type !== 'tab').map(info);
  };
  const browserCommand = (connection, method, params) => {
    switch (method) {
      case 'Target.setDiscoverTargets':
        connection.discover = Boolean(params.discover);
        if (connection.discover)
          for (const target of targets.values())
            connection.emit('Target.targetCreated', { targetInfo: info(target) });
        return {};
      case 'Target.getTargets': {
        const all = Array.isArray(params.filter);
        const blind = connection.name === 'unguarded' && (observerBlind || (listBlind && !all));
        const targetInfos = blind ? [] : listing(params.filter);
        if (loseRaw && all && connection.name === 'unguarded')
          setTimeout(() => {
            for (const info of targetInfos)
              if (info.type === 'page' && info.url !== 'about:blank') close(info.targetId);
          }, 0);
        return { targetInfos };
      }
      case 'Target.getTargetInfo':
        return { targetInfo: info(known(params.targetId)) };
      case 'Target.createBrowserContext':
        return { browserContextId: next('CONTEXT') };
      case 'Target.disposeBrowserContext':
        for (const target of [...targets.values()])
          if (target.browserContextId === params.browserContextId && target.type === 'page')
            close(target.targetId);
        return {};
      case 'Target.createTarget':
        return { targetId: create(params).targetId };
      case 'Target.closeTarget':
        return { success: close(params.targetId) };
      case 'Target.attachToTarget': {
        const target = known(params.targetId);
        if (!unguardedAttach && connection.name === 'unguarded' && target.url !== 'about:blank')
          throw new Error('Target attach failed');
        const sessionId = next('SESSION');
        sessions.set(sessionId, { connection, targetId: target.targetId, page: false });
        connection.emit('Target.attachedToTarget', {
          sessionId,
          targetInfo: info(target),
          waitingForDebugger: false,
        });
        return { sessionId };
      }
      case 'Target.detachFromTarget': {
        const session = sessions.get(params.sessionId);
        if (!session) throw new Error('No session with given id');
        sessions.delete(params.sessionId);
        connection.emit('Target.detachedFromTarget', {
          sessionId: params.sessionId,
          targetId: session.targetId,
        });
        return {};
      }
      case 'Target.setAutoAttach':
        return {};
      default:
        throw new Error(`'${method}' wasn't found`);
    }
  };
  const sessionCommand = (connection, method, params, sessionId) => {
    const session = sessions.get(sessionId);
    if (!session || session.connection !== connection)
      throw new Error('Session with given id not found.');
    const target = known(session.targetId);
    switch (method) {
      case 'Page.enable':
        session.page = true;
        return {};
      case 'Runtime.enable':
      case 'Network.enable':
      case 'Runtime.runIfWaitingForDebugger':
        return {};
      case 'Page.navigate':
        return { frameId: target.targetId, loaderId: navigate(target, params.url) };
      case 'Runtime.evaluate':
        return evaluate(target, params.expression ?? '');
      default:
        throw new Error(`'${method}' wasn't found`);
    }
  };
  const connection = (name) => {
    const self = { name, transport: 'cdp', events: [], discover: false };
    self.emit = (method, params, sessionId) =>
      self.events.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    self.waitEvent = async (predicate, ms = 10000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = self.events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('CDP event timed out');
        await tick();
      }
    };
    self.send = async (method, params = {}, sessionId) => {
      sent.push({ connection: name, method, params, sessionId });
      await tick();
      return sessionId
        ? sessionCommand(self, method, params, sessionId)
        : browserCommand(self, method, params);
    };
    connections.push(self);
    return self;
  };
  const client = connection('client');
  const unguarded = connection('unguarded');
  return { client, unguarded, sent, targets, close: async () => {} };
}
