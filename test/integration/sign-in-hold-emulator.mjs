import { SIGN_IN_HOLD_CALLBACK, SIGN_IN_HOLD_MARK } from '../../sign-in-hold.mjs';

const CALLBACK_ORIGIN = 'https://www.sliccy.ai';

export function signInHoldUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith(`about:blank#${SIGN_IN_HOLD_MARK}`)) return true;
  if (!url.includes('redirect_uri=')) return false;
  if (url.includes(encodeURIComponent(SIGN_IN_HOLD_CALLBACK))) return true;
  if (url.includes(encodeURIComponent(encodeURIComponent(SIGN_IN_HOLD_CALLBACK)))) return true;
  if (url.includes(encodeURIComponent(CALLBACK_ORIGIN))) return true;
  if (
    url.includes(`redirect_uri=${CALLBACK_ORIGIN}`) ||
    url.includes('redirect_uri=https://www.sliccy.ai')
  )
    return true;
  try {
    const parsed = new URL(url);
    const redirect = parsed.searchParams.get('redirect_uri');
    if (!redirect) return false;
    if (redirect === SIGN_IN_HOLD_CALLBACK || redirect === CALLBACK_ORIGIN) return true;
    if (redirect === encodeURIComponent(SIGN_IN_HOLD_CALLBACK)) return true;
    return false;
  } catch {
    return false;
  }
}

export function createSignInHoldState(options = {}) {
  return {
    held: new Set(),
    announced: new Set(),
    options,
  };
}

export function noteSignInHoldTarget(state, info) {
  if (!state || !info?.targetId) return;
  if (state.options.holdMissing) return;
  if (signInHoldUrl(info.url) || state.held.has(info.targetId)) state.held.add(info.targetId);
}

export function isSignInHeld(state, targetId) {
  return Boolean(state?.held?.has(targetId));
}

export function filterSignInHoldInfos(state, infos) {
  if (!state || state.options.leakGetTargets) return infos;
  if (state.options.announceOnly) {
    return (infos ?? []).map((info) => {
      if (!isSignInHeld(state, info.targetId)) return info;
      state.announced.add(info.targetId);
      if (state.options.announceLeak) return info;
      return { ...info, url: '', title: '', openerId: undefined, openerFrameId: undefined };
    });
  }
  return (infos ?? []).filter((info) => !isSignInHeld(state, info.targetId));
}

export function filterSignInHoldJson(state, tabs) {
  if (!state || state.options.leakJsonList) return tabs;
  return (tabs ?? []).filter((tab) => !isSignInHeld(state, tab.id ?? tab.targetId));
}

export function signInHoldEventAction(state, event) {
  if (!state) return 'pass';
  const info = event.params?.targetInfo;
  if (info) noteSignInHoldTarget(state, info);
  if (event.method === 'Target.targetDestroyed' && isSignInHeld(state, event.params?.targetId)) {
    if (state.options.leakEvents) return 'pass';
    return 'skip';
  }
  if (
    !['Target.targetCreated', 'Target.targetInfoChanged', 'Target.attachedToTarget'].includes(
      event.method
    )
  )
    return 'pass';
  if (!info || !isSignInHeld(state, info.targetId)) return 'pass';
  if (state.options.leakEvents) return 'pass';
  if (state.options.announceOnly) {
    state.announced.add(info.targetId);
    if (state.options.announceLeak) return 'pass';
    return {
      action: 'rewrite',
      event: {
        ...event,
        params: {
          ...event.params,
          targetInfo: {
            ...info,
            url: '',
            title: '',
            openerId: undefined,
            openerFrameId: undefined,
          },
        },
      },
    };
  }
  return 'skip';
}

export function signInHoldAttach(state, targetId) {
  if (!state || !isSignInHeld(state, targetId)) return 'allow';
  if (state.options.allowAttach) return 'allow';
  if (state.options.announceOnly) return 'refuse';
  return 'refuse';
}

export function signInHoldRead(state, targetId) {
  if (!state || !isSignInHeld(state, targetId)) return 'allow';
  if (state.options.allowRead) return 'allow';
  return 'refuse';
}

export function applySignInHold(guard, browser, options = {}) {
  const state = createSignInHoldState(options);
  const unguarded = browser.unguarded;
  const track = async (targetId) => {
    if (!targetId || state.options.holdMissing) return;
    try {
      const { targetInfo } = await unguarded.send('Target.getTargetInfo', { targetId });
      noteSignInHoldTarget(state, targetInfo);
      if (isSignInHeld(state, targetId)) return;
      const listed = await unguarded.send('Target.getTargets');
      for (const info of listed?.targetInfos ?? []) noteSignInHoldTarget(state, info);
      if (
        targetInfo &&
        (signInHoldUrl(targetInfo.url) ||
          (targetInfo.openerId && state.held.has(targetInfo.openerId) === false))
      ) {
        const opener = (listed?.targetInfos ?? []).find(
          (info) => info.targetId === targetInfo.openerId
        );
        if (opener && signInHoldUrl(targetInfo.url)) state.held.add(targetId);
      }
    } catch {}
  };

  const watchUnguarded = () => {
    for (const event of unguarded.events ?? []) {
      const info = event.params?.targetInfo;
      if (info) noteSignInHoldTarget(state, info);
      if (
        event.method === 'Target.targetInfoChanged' &&
        info?.targetId &&
        state.held.has(info.targetId)
      )
        state.held.add(info.targetId);
    }
  };

  const refusal = () => {
    const error = new Error(
      'slicc: refused: seven’s own pages and the vault are out of reach of browser automation'
    );
    error.cdp = { code: -32000, message: error.message };
    throw error;
  };

  const sessions = new Map();
  const baseSend = (...args) => guard.send(...args);
  const send = async (method, params = {}, sessionId) => {
    watchUnguarded();
    if (method === 'Target.attachToTarget') {
      await track(params.targetId);
      const decision = signInHoldAttach(state, params.targetId);
      if (decision === 'refuse') refusal();
    }
    if (sessionId && sessions.has(sessionId)) {
      const targetId = sessions.get(sessionId);
      if (
        signInHoldRead(state, targetId) === 'refuse' &&
        ['Runtime.evaluate', 'Runtime.enable', 'Page.getFrameTree', 'DOM.getDocument'].includes(
          method
        )
      )
        refusal();
    }
    if (method === 'Target.getTargets') {
      const result = await baseSend(method, params, sessionId);
      for (const info of result?.targetInfos ?? []) noteSignInHoldTarget(state, info);
      return {
        ...result,
        targetInfos: filterSignInHoldInfos(state, result?.targetInfos),
      };
    }
    if (method === 'Target.getTargetInfo') {
      const targetId = params.targetId ?? sessions.get(sessionId);
      await track(targetId);
      if (isSignInHeld(state, targetId) && !options.leakGetTargets && !options.announceOnly)
        refusal();
      const result = await baseSend(method, params, sessionId);
      if (
        result?.targetInfo &&
        isSignInHeld(state, result.targetInfo.targetId) &&
        options.announceOnly &&
        !options.announceLeak
      ) {
        return {
          ...result,
          targetInfo: { ...result.targetInfo, url: '', title: '' },
        };
      }
      return result;
    }
    const result = await baseSend(method, params, sessionId);
    if (method === 'Target.attachToTarget' && result?.sessionId) {
      sessions.set(result.sessionId, params.targetId);
      if (options.announceOnly && isSignInHeld(state, params.targetId) && !options.allowAttach) {
        sessions.delete(result.sessionId);
        refusal();
      }
    }
    return result;
  };

  const events = guard.events;
  const push = events.push.bind(events);
  events.push = (...items) => {
    const kept = [];
    for (const event of items) {
      const action = signInHoldEventAction(state, event);
      if (action === 'skip') continue;
      if (action === 'pass') kept.push(event);
      else if (action?.action === 'rewrite') kept.push(action.event);
      else kept.push(event);
    }
    return push(...kept);
  };

  const client = {
    ...guard,
    events,
    send,
    jsonList: async () => {
      watchUnguarded();
      const listed = await unguarded.send('Target.getTargets');
      for (const info of listed?.targetInfos ?? []) noteSignInHoldTarget(state, info);
      const tabs = (listed?.targetInfos ?? []).map((info) => ({
        id: info.targetId,
        type: info.type,
        url: info.url,
        title: info.title,
      }));
      return filterSignInHoldJson(state, tabs);
    },
  };
  return client;
}
