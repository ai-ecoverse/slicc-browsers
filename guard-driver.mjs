const q = JSON.stringify;

export const originDefaults = {
  plain: 'ordinary',
  cross: 'client',
  log: 'ordinary',
  own: 'client',
};
export const knownOrigins = [
  'ordinary',
  'ordinary-same-site',
  'seven',
  'vault',
  'vault-x',
  'apex',
  'own',
  'client',
  'plain',
  'cross',
  'log',
];

export const beacon = (log, tag) =>
  `try { const u = ${q(log)} + '/beacon?tag=' + ${q(tag)} + '&origin=' + encodeURIComponent(location.origin); if (!navigator.sendBeacon(u)) fetch(u, { keepalive: true, mode: 'no-cors' }).catch(() => {}); } catch {}`;

export const probe = (log, tag) =>
  `(() => { ${beacon(log, tag)} const p = btoa(location.origin + location.pathname); if (window.probeBinding) window.probeBinding(p); console.log('probe:' + p); })()`;

const openCanary = `new Promise((resolve) => { const r = indexedDB.open('canary', 1); r.onupgradeneeded = () => r.result.createObjectStore('canary'); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); })`;

export const canary = {
  plant: (value) =>
    `(async () => { localStorage.setItem('canary', ${q(value)}); const db = await ${openCanary}; if (!db) return false; await new Promise((resolve) => { const t = db.transaction('canary', 'readwrite'); t.objectStore('canary').put(${q(value)}, 'canary'); t.oncomplete = resolve; t.onerror = resolve; }); db.close(); return true; })()`,
  read: () =>
    `(async () => { const db = await ${openCanary}; const record = db ? await new Promise((resolve) => { const g = db.transaction('canary').objectStore('canary').get('canary'); g.onsuccess = () => resolve(g.result ?? null); g.onerror = () => resolve(null); }) : null; db?.close(); return { localStorage: localStorage.getItem('canary'), indexedDB: record, marker: document.querySelector('[data-canary]')?.dataset.canary ?? null }; })()`,
  untouched: (value, read) =>
    read?.localStorage === value && read?.indexedDB === value && read?.marker === value,
};

export const hop = (hops, end) =>
  hops.reduceRight(
    (to, { origin, code }) => `${origin}/hop?code=${code}&to=${encodeURIComponent(to)}`,
    end
  );

export function expand(value, vars) {
  if (typeof value === 'string')
    return value.replace(/\{([A-Za-z][A-Za-z-]*)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(value)) return value.map((v) => expand(v, vars));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, vars)]));
  return value;
}

function named(list, n = { i: 0 }) {
  return list.map((s) => {
    const i = n.i++;
    const step = s.children ? { ...s, children: named(s.children, n) } : { ...s };
    if (s.refusable) step.refusal = { ...s.refusal, name: s.as ?? `refused.${i}` };
    if (s.page === 'tab') step.background = s.background ?? true;
    return step;
  });
}

const flatten = (list) => list.flatMap((s) => [s, ...flatten(s.children ?? [])]);

export const refusals = (vector) =>
  flatten(named([...(vector.setup ?? []), ...(vector.trigger ?? [])]))
    .filter((s) => s.refusable)
    .map((s) => s.refusal.name);

export function steps(vector, side, vars) {
  const pick = (list) =>
    list
      .filter((s) => !s.on || s.on === side)
      .map(({ on: _, ...s }) => (s.children ? { ...s, children: pick(s.children) } : s));
  const all = { ...vars, beacon: beacon(vars.log, vars.tag), probe: probe(vars.log, vars.tag) };
  const [setup, trigger] = [vector.setup, vector.trigger].map((list, k, both) =>
    named(list, { i: k === 0 ? 0 : flatten(both[0]).length })
  );
  return { setup: expand(pick(setup), all), trigger: expand(pick(trigger), all) };
}

export async function outcome(promise) {
  try {
    return { ok: true, result: await promise };
  } catch (error) {
    return { ok: false, error: error?.cdp ?? { message: String(error?.message ?? error) } };
  }
}

export const isRefusal = (out, step) =>
  Boolean(step?.refusal) &&
  !out.ok &&
  [out.error?.message, out.error?.code]
    .filter((v) => v !== undefined && v !== null)
    .some((v) => new RegExp(step.refusal.match).test(String(v)));

export function call(client, step, sessionId) {
  const target = step.session === 'browser' ? undefined : sessionId;
  return outcome(client.send(step.cdp, step.params ?? {}, target));
}

export async function instrument(client, sessionId, log, tag) {
  await client.send('Page.enable', {}, sessionId);
  await client.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: beacon(log, tag) },
    sessionId
  );
  await client.send('Page.setBypassCSP', { enabled: true }, sessionId);
}

export function loadedAfter(events, sessionId, loaderId) {
  const committed = events.findIndex(
    (e) =>
      e.method === 'Page.frameNavigated' &&
      e.sessionId === sessionId &&
      !e.params?.frame?.parentId &&
      e.params?.frame?.loaderId === loaderId
  );
  return (
    committed >= 0 &&
    events
      .slice(committed + 1)
      .some((e) => e.method === 'Page.loadEventFired' && e.sessionId === sessionId)
  );
}

export async function load(client, sessionId, url, ms = 20000) {
  const start = client.events.length;
  const { loaderId } = await client.send('Page.navigate', { url }, sessionId);
  if (!loaderId) return;
  if (!(await waitFor(() => loadedAfter(client.events.slice(start), sessionId, loaderId), ms)))
    throw new Error(`load of ${url} timed out`);
}

export async function waitFor(check, ms, step = 25) {
  const start = Date.now();
  const limit = start + ms + Math.max(ms * 4, 30000);
  let deadline = start + ms;
  let last = start;
  const beat = () => {
    const now = Date.now();
    const gap = now - last;
    if (gap > Math.max(step * 4, 1000)) deadline = Math.min(limit, deadline + gap - step);
    last = now;
  };
  let timer;
  const tick = () => {
    beat();
    timer = setTimeout(tick, step);
  };
  timer = setTimeout(tick, step);
  try {
    for (;;) {
      if (await check()) return true;
      beat();
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, step));
      beat();
    }
  } finally {
    clearTimeout(timer);
  }
}

export function popup(client, openerId, ms = 10000) {
  const isPopup = (e) =>
    (e.method === 'Target.targetCreated' || e.method === 'Target.attachedToTarget') &&
    e.params?.targetInfo?.openerId === openerId;
  const seen = client.events.find(isPopup);
  if (seen) return Promise.resolve(seen.params.targetInfo);
  return client.waitEvent(isPopup, ms).then(
    (e) => e.params.targetInfo,
    () => null
  );
}

const matches = (want, got) => (want === 'either' ? typeof got === 'boolean' : got === want);

export function judge(vector, side, observed) {
  const want = side === 'control' ? vector.control.expected : vector.expected;
  const refused = refusals(vector).filter((name) => observed?.[name] === true);
  if (typeof want === 'string') {
    const mismatches = observed === true ? [] : [want];
    return { pass: mismatches.length === 0, refused, skipped: [], mismatches };
  }
  const skipped = Object.keys(want).filter(
    (k) =>
      (observed?.[k] === 'not-supported' && vector.observe?.[k]?.requires?.length > 0) ||
      (vector.observe?.[k]?.dependsOn ?? []).some((d) => refused.includes(d))
  );
  const incomplete = Object.keys(want).filter(
    (k) => !skipped.includes(k) && observed?.[`${k}.either`] === 'incomplete'
  );
  const mismatches = Object.entries(want)
    .filter(
      ([k, v]) =>
        !skipped.includes(k) &&
        !incomplete.includes(k) &&
        !matches(observed?.[`${k}.either`] === true ? 'either' : v, observed?.[k])
    )
    .map(([k, v]) => `${k}: got ${q(observed?.[k])}, want ${q(v)}`);
  return { pass: mismatches.length === 0, refused, skipped, mismatches };
}

const ranOn = (observed, name) => typeof observed?.[name] === 'boolean';

const refusalRuns = (vector, control, guarded) =>
  Object.fromEntries(
    refusals(vector)
      .filter((name) => control && guarded && ranOn(control, name) !== ranOn(guarded, name))
      .map((name) => [name, ranOn(control, name) ? 'control-only' : 'guarded-only'])
  );

const protectedRefusals = (vector) =>
  new Set(
    flatten(named([...(vector.setup ?? []), ...(vector.trigger ?? [])]))
      .filter((step) => step.refusable && step.refusal.onlyProtected)
      .map((step) => step.refusal.name)
  );

function controlRefusal(c, g, via, only, onlyProtected) {
  if (!c) return 'no control';
  if (c.refused.length > 0 && via !== 'guard') return 'an unguarded control was refused';
  if (c.refused.some((name) => onlyProtected.has(name)))
    return 'a protected-only step was refused on the control';
  if (via === 'guard' && g && only(c, g).length > 0)
    return `refused only on the control: ${only(c, g).join(', ')}`;
  return null;
}

export function result(vector, run) {
  const row = {
    id: vector.id,
    target: run.target,
    variant: run.variant,
    transport: run.transport,
    via: run.via ?? vector.control.via,
  };
  if (vector.kind === 'text')
    return { ...row, control: 'not-run', guarded: 'not-run', live: 'not-run' };
  if (vector.skip?.target === run.target)
    return { ...row, control: 'skip', guarded: 'skip', live: 'skip', reason: vector.skip.reason };
  const missing = (vector.requires ?? []).find(
    (cap) => Array.isArray(run.capabilities) && !run.capabilities.includes(cap)
  );
  if (missing) {
    const reason = `not-supported:${missing}`;
    return { ...row, control: 'skip', guarded: 'skip', live: 'skip', reason };
  }
  const c = run.control ? judge(vector, 'control', run.control) : null;
  const g = run.guarded ? judge(vector, 'guarded', run.guarded) : null;
  const both = (name) => ranOn(run.control, name) && ranOn(run.guarded, name);
  const only = (a, b) =>
    (a?.refused ?? []).filter((name) => both(name) && !(b?.refused ?? []).includes(name));
  const ran = refusalRuns(vector, run.control, run.guarded);
  const onlyProtected = protectedRefusals(vector);
  const protectedOnly = only(g, c).filter((name) => !onlyProtected.has(name));
  const why = [];
  const refusal = controlRefusal(c, g, row.via, only, onlyProtected);
  const control = c?.pass && !refusal ? 'pass' : 'fail';
  if (refusal) why.push(refusal);
  else why.push(...c.mismatches.map((m) => `control ${m}`));
  let guarded = g?.pass ? 'pass' : 'fail';
  if (!g) why.push('no guarded run');
  else if (row.via === 'guard' && protectedOnly.length > 0) {
    guarded = 'fail';
    why.push(`refused only on the protected target: ${protectedOnly.join(', ')}`);
  } else if (row.via === 'unguarded' && g.refused.length > 0 && !c?.pass) {
    guarded = 'fail';
    why.push('refused on the protected target without a passing control');
  } else why.push(...g.mismatches);
  const live = run.live === true ? 'pass' : 'fail';
  if (live === 'fail') why.push(['not live', run.liveWhy].filter(Boolean).join(': '));
  return {
    ...row,
    control,
    guarded,
    live,
    ...(Object.keys(ran).length ? { ran } : {}),
    ...(Object.values(run.guarded ?? {}).includes('not-supported')
      ? {
          notSupported: Object.keys(run.guarded).filter(
            (name) => run.guarded[name] === 'not-supported'
          ),
        }
      : {}),
    ...(why.length ? { why: why.join('; ') } : {}),
  };
}

const passed = (r) =>
  [r.control, r.guarded, r.live].every((s) => s === 'pass') ||
  [r.control, r.guarded, r.live].every((s) => s === 'skip') ||
  [r.control, r.guarded, r.live].every((s) => s === 'not-run');

const capabilities = (value) =>
  Array.isArray(value)
    ? value.flatMap(capabilities)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, item]) =>
          key === 'requires' && Array.isArray(item) ? item : capabilities(item)
        )
      : [];

const originNames = (value) =>
  [...q(value ?? null).matchAll(/\{([A-Za-z][A-Za-z-]*)\}/g)]
    .map((match) => (match[1] === 'beacon' || match[1] === 'probe' ? 'log' : match[1]))
    .flatMap((name) => [name, originDefaults[name]]);

const checkOrigins = (check) => {
  if (!check || typeof check !== 'object') return [];
  if (check.any) return checkOrigins(check.any[0]);
  if (check.all || check.not) return (check.all ?? [check.not]).flatMap(checkOrigins);
  return originNames(check);
};

function originReason(vector, row, reason) {
  const origin = /^not-applicable:no-(.+)-origin$/.exec(reason)?.[1];
  if (!knownOrigins.includes(origin)) return false;
  const fixed = [
    row.target,
    '{plain}',
    vector?.control?.origin,
    vector?.setup,
    vector?.trigger,
  ].map((value) => (typeof value === 'string' && !value.startsWith('{') ? `{${value}}` : value));
  return [
    ...originNames(fixed),
    ...checkOrigins(vector?.liveCheck),
    ...Object.values(vector?.observe ?? {}).flatMap((observation) =>
      checkOrigins(observation?.check)
    ),
  ].includes(origin);
}

function skipWhy(vector, row, known) {
  const { reason } = row;
  if (typeof reason !== 'string' || reason === '') return 'skip without a reason';
  if (reason === 'not-applicable' || originReason(vector, row, reason)) return null;
  if (vector?.skip?.target === row.target && vector.skip.reason === reason) return null;
  if (reason.startsWith('not-supported:') && known.has(reason.slice('not-supported:'.length)))
    return null;
  return `skip with a reason the runner never gives: ${reason}`;
}

function forgeries(set, results) {
  const vectors = new Map(set.vectors.map((v) => [v.id, v]));
  const known = new Set([
    'browserSession',
    'unguarded-observer',
    ...capabilities(set.vectors).filter((c) => typeof c === 'string' && c !== ''),
  ]);
  return results.flatMap((row) => {
    const legs = [row.control, row.guarded, row.live];
    const vector = vectors.get(row.id);
    const why = [];
    if (legs.includes('not-run') && vector?.kind !== 'text')
      why.push('not-run on a vector that is not kind text');
    if (legs.includes('skip')) why.push(skipWhy(vector, row, known));
    const found = why.filter(Boolean);
    if (!found.length) return [];
    const { id, target, variant, transport } = row;
    return [{ id, target, variant, transport, why: found.join('; ') }];
  });
}

export function summary({ guard, sha, set, results }) {
  const uniq = (k) => [...new Set(results.map((r) => r[k]))].sort();
  const variants = [...new Set([...Object.keys(set.variants ?? {}), ...uniq('variant')])].sort();
  const has = new Set(results.map((r) => q([r.id, r.target, r.variant, r.transport])));
  const missing = set.vectors
    .filter((v) => v.scope === 'any' || v.scope === guard)
    .flatMap((v) => v.targets.map((target) => ({ id: v.id, target })))
    .flatMap((row) => variants.map((variant) => ({ ...row, variant })))
    .flatMap((row) => uniq('transport').map((transport) => ({ ...row, transport })))
    .filter((r) => !has.has(q([r.id, r.target, r.variant, r.transport])));
  const forged = forgeries(set, results);
  const pass =
    results.length > 0 && missing.length === 0 && forged.length === 0 && results.every(passed);
  const name = `@ai-ecoverse/slicc-browsers@${set.setVersion}`;
  return {
    set: name,
    schemaVersion: set.schemaVersion,
    guard,
    sha,
    variants: uniq('variant'),
    targets: uniq('target'),
    transports: uniq('transport'),
    results,
    skipped: results
      .filter((r) => r.control === 'skip')
      .map(({ id, target, reason }) => ({ id, target, reason })),
    notRun: [...new Set(results.filter((r) => r.control === 'not-run').map((r) => r.id))],
    missing,
    forged,
    pass,
    line: `${pass ? 'GUARD-PASS' : 'GUARD-FAIL'} ${guard}@${sha} (vectors ${name})${forged.length ? ` forged ${forged.length}` : ''}`,
  };
}

export function parseURL(value, base) {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

export const owned = (entries, tag) =>
  (entries ?? []).filter((entry) => typeof entry?.url === 'string' && entry.url.includes(tag));
