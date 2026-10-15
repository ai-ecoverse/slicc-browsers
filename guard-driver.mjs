const q = JSON.stringify;

export const beacon = (log, tag) =>
  `try { navigator.sendBeacon(${q(log)} + '/beacon?tag=' + ${q(tag)} + '&origin=' + encodeURIComponent(location.origin)); } catch {}`;

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

export async function load(client, sessionId, url, ms = 20000) {
  const loaded = client.waitEvent(
    (e) => e.method === 'Page.loadEventFired' && e.sessionId === sessionId,
    ms
  );
  await client.send('Page.navigate', { url }, sessionId);
  await loaded;
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
  const skipped = Object.keys(want).filter((k) =>
    (vector.observe?.[k]?.dependsOn ?? []).some((d) => refused.includes(d))
  );
  const mismatches = Object.entries(want)
    .filter(([k, v]) => !skipped.includes(k) && !matches(v, observed?.[k]))
    .map(([k, v]) => `${k}: got ${q(observed?.[k])}, want ${q(v)}`);
  return { pass: mismatches.length === 0, refused, skipped, mismatches };
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
  const only = (a, b) => (a?.refused ?? []).filter((name) => !(b?.refused ?? []).includes(name));
  const why = [];
  let control = c?.pass ? 'pass' : 'fail';
  if (!c) why.push('no control');
  else if (c.refused.length > 0 && row.via !== 'guard') {
    control = 'fail';
    why.push('an unguarded control was refused');
  } else if (row.via === 'guard' && g && only(c, g).length > 0) {
    control = 'fail';
    why.push(`refused only on the control: ${only(c, g).join(', ')}`);
  } else why.push(...c.mismatches.map((m) => `control ${m}`));
  let guarded = g?.pass ? 'pass' : 'fail';
  if (!g) why.push('no guarded run');
  else if (row.via === 'guard' && only(g, c).length > 0) {
    guarded = 'fail';
    why.push(`refused only on the protected target: ${only(g, c).join(', ')}`);
  } else if (row.via === 'unguarded' && g.refused.length > 0 && !c?.pass) {
    guarded = 'fail';
    why.push('refused on the protected target without a passing control');
  } else why.push(...g.mismatches);
  const live = run.live === true ? 'pass' : 'fail';
  if (live === 'fail') why.push('not live');
  return { ...row, control, guarded, live, ...(why.length ? { why: why.join('; ') } : {}) };
}

const passed = (r) =>
  [r.control, r.guarded, r.live].every((s) => s === 'pass') ||
  [r.control, r.guarded, r.live].every((s) => s === 'skip') ||
  [r.control, r.guarded, r.live].every((s) => s === 'not-run');

export function summary({ guard, sha, set, results }) {
  const uniq = (k) => [...new Set(results.map((r) => r[k]))].sort();
  const pass = results.length > 0 && results.every(passed);
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
    pass,
    line: `${pass ? 'GUARD-PASS' : 'GUARD-FAIL'} ${guard}@${sha} (vectors ${name})`,
  };
}
