import { credentialOrigins, protectedOrigins } from './protected.mjs';

function httpsURL(text) {
  if (typeof text !== 'string' || !/^https:\/\/[^/?#]+/i.test(text)) return null;
  if (/[\p{Cc}\s\\]/u.test(text) || /%(?![0-9a-f]{2})/i.test(text)) return null;
  const authority = text.slice(8).split(/[/?#]/, 1)[0];
  if (/[@*%]/.test(authority)) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function ambiguousPath(text) {
  const path = text
    .slice(8)
    .replace(/^[^/?#]*/, '')
    .split(/[?#]/, 1)[0];
  return /%(?:2f|5c)/i.test(path) || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(path);
}

export function parseLeaseAllow(catalog, input, extraProtectedOrigins = []) {
  const u = httpsURL(input);
  if (!u) return null;
  let rule;
  if (/^https:\/\/[^/?#]+$/i.test(input)) {
    rule = { kind: 'origin', url: u.origin };
  } else if (input.endsWith('/**') && !/[?#]/.test(input)) {
    if (ambiguousPath(input) || u.pathname.endsWith('//**')) return null;
    rule = { kind: 'path-prefix', url: u.origin + (u.pathname.slice(0, -3) || '/') };
  } else {
    if (ambiguousPath(input)) return null;
    rule = { kind: 'exact', url: u.href };
  }
  return leaseScope(catalog, [rule], extraProtectedOrigins) ? rule : null;
}

export function leaseScope(catalog, allow, extraProtectedOrigins = []) {
  if (!Array.isArray(allow) || !allow.length || allow.length > 64) return null;
  const hard = protectedOrigins(catalog.protectedOrigins, extraProtectedOrigins);
  const credential = credentialOrigins(catalog.credentialOrigins);
  const forbidden = (url) => hard.url(url) || credential.url(url);
  const checks = [];
  const seen = new Set();
  for (const rule of allow) {
    if (
      !rule ||
      Object.keys(rule).length !== 2 ||
      !Object.hasOwn(rule, 'kind') ||
      !Object.hasOwn(rule, 'url')
    )
      return null;
    const { kind, url } = rule;
    const u = httpsURL(url);
    if (!u || url.length > 8192 || url.includes('*') || forbidden(url)) return null;
    const key = `${kind}:${url}`;
    if (seen.has(key)) return null;
    seen.add(key);
    switch (kind) {
      case 'origin':
        if (u.origin !== url) return null;
        checks.push((candidate) => candidate.origin === url);
        break;
      case 'exact':
        if (u.href !== url || ambiguousPath(url)) return null;
        checks.push((candidate, raw) => !ambiguousPath(raw) && candidate.href === url);
        break;
      case 'path-prefix': {
        const path = u.pathname;
        if (url !== u.origin + path || ambiguousPath(url) || (path !== '/' && path.endsWith('/')))
          return null;
        checks.push(
          (candidate, raw) =>
            !ambiguousPath(raw) &&
            candidate.origin === u.origin &&
            (candidate.pathname === path ||
              candidate.pathname.startsWith(path === '/' ? '/' : `${path}/`))
        );
        break;
      }
      default:
        return null;
    }
  }
  return (raw) => {
    const candidate = httpsURL(raw);
    return (
      !!candidate && !forbidden(candidate.href) && checks.some((check) => check(candidate, raw))
    );
  };
}
