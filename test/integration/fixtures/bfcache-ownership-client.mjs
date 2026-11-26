import { bfcacheClients } from './bfcache-client.mjs';

const refusal = 'slicc: refused: protected target';
const probeMethods = /^(Runtime\.|DOM\.|Accessibility\.|Input\.|Page\.captureScreenshot|IO\.read)/;
const held = () => new Promise(() => {});

export function bfcacheOwnershipClients({
  read = '{"depth":-1,"pierce":true}',
  release = true,
  releaseParams,
  releaseFirst = false,
  extra,
  forward = [],
  elsewhere = [],
  deliver,
  ledger = 'full',
  touch = false,
  trigger = 'refuse',
  before = [],
  after = [],
  late,
  lateReply = 'node',
} = {}) {
  const browser = bfcacheClients();
  const send = browser.client.send;
  const forwarded = new Set();
  const reported = [];
  const reads = [];
  let mark = 0;
  let gate;
  let opened = false;
  let probed = false;
  const toBrowser = (method, params, session) => {
    gate.commands.push(
      params === undefined ? { method } : { method, params: structuredClone(params) }
    );
    return send(method, params, session);
  };
  const pair = async (session) => {
    await toBrowser('DOM.getDocument', { depth: -1, pierce: true }, session);
    await toBrowser('DOM.disable', undefined, session);
  };
  const answerReads = () => {
    for (const { resolve, url } of reads.splice(0))
      resolve({ root: lateReply === 'origin' ? { documentURL: url } : { nodeId: 1 } });
  };
  const other = (session) =>
    [...browser.sessions].find(
      ([id, targetId]) => id !== session && targetId === browser.sessions.get(session)
    )?.[0];
  browser.client.send = async (method, params = {}, session) => {
    if (
      late === 'detach' &&
      method === 'Target.detachFromTarget' &&
      gate?.sessionId === params.sessionId
    )
      setTimeout(answerReads, 0);
    if (!gate || session !== gate.sessionId) return send(method, params, session);
    const target = browser.targets.get(browser.sessions.get(session));
    if (method === 'Page.navigateToHistoryEntry' && trigger === 'refuse') throw new Error(refusal);
    if (!(target?.state.persisted && probeMethods.test(method)))
      return toBrowser(method, params, session);
    if (!probed) {
      probed = true;
      for (const name of after)
        await toBrowser(
          name,
          name === 'Page.navigateToHistoryEntry'
            ? { entryId: target.history[target.index].id }
            : undefined,
          session
        );
    }
    if (method === 'DOM.getDocument') {
      if (releaseFirst && !opened) await toBrowser('DOM.disable', undefined, session);
      const answer = toBrowser(method, JSON.parse(read), session);
      forwarded.add(params);
      reported.push({ method, params: { depth: -1, pierce: true } });
      if (touch) target.state.touched = 1;
      if (extra && !opened) await toBrowser(extra, undefined, session);
      opened = true;
      if (release) {
        await toBrowser('DOM.disable', releaseParams, session);
        reported.push({ method: 'DOM.disable' });
      }
      if (deliver === 'marker') return answer;
      if (deliver === 'origin') {
        await answer;
        return { root: { documentURL: target.url } };
      }
      return new Promise((resolve) => reads.push({ resolve, url: target.url }));
    }
    if (forward.includes(method)) {
      forwarded.add(params);
      await toBrowser(method, params, session);
      return held();
    }
    if (elsewhere.includes(method)) return send(method, params, other(session));
    throw new Error(refusal);
  };
  const audited = (probes, commands, final) => {
    if (ledger === 'partial') return commands.slice(0, Math.ceil(commands.length / 2));
    if (ledger === 'restart' && probes.length > 0) return commands.slice(1);
    if (ledger === 'truncate' && final)
      return commands.filter((command, index) => index < mark - 2 || index >= mark);
    if (ledger === 'rewrite' && final) {
      const rewritten = [...commands];
      rewritten[rewritten.findIndex((command) => command.method === 'DOM.disable')] = {
        method: 'DOM.getDocument',
        params: { depth: -1, pierce: true },
      };
      return rewritten;
    }
    return [...commands];
  };
  const install = browser.client.inboundDelay;
  browser.client.inboundDelay = async (args) => {
    const installed = await install(args);
    if (args.side === 'control') return installed;
    gate = { sessionId: args.sessionId, commands: [] };
    opened = false;
    probed = false;
    reported.length = 0;
    reads.length = 0;
    const { commands } = gate;
    for (const name of before) await toBrowser(name, undefined, args.sessionId);
    return {
      ...installed,
      audit: async ({ probes, final }) => {
        if (['truncate', 'rewrite', 'extend'].includes(ledger) && probes.length > 0) {
          if (!final || ledger === 'extend') await pair(args.sessionId);
          if (!final) mark = commands.length;
        }
        if (late === 'grace' && final) setTimeout(answerReads, 0);
        return {
          complete: true,
          probes: probes.map((probe) => ({ id: probe.id, forwarded: forwarded.has(probe.params) })),
          ...(ledger === 'missing' ? {} : { commands: audited(probes, commands, final) }),
        };
      },
    };
  };
  browser.client.commands = reported;
  return browser;
}
