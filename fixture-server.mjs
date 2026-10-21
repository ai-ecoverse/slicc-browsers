import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { parseURL } from './guard-driver.mjs';

const tall = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const escape = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function document(url, html) {
  const p = url.searchParams;
  const csp = p.has('csp') || url.pathname === '/csp';
  const listener = p.has('listener')
    ? `<script src="/listener.js?n=${encodeURIComponent(p.get('n') ?? '')}"></script>`
    : '';
  return html(
    'doc',
    `<p>document ${escape(p.get('n') ?? '')}</p>${listener}${csp ? '<script>document.title="inline"; document.body.dataset.inline="true"</script>' : ''}`,
    csp ? { 'content-security-policy': "script-src 'none'" } : {}
  );
}

function trigger(p) {
  const kind = p.get('k') ?? '';
  const to = p.get('to') ?? '';
  const frame = kind === 'iframe' ? `<iframe src="${escape(to)}"></iframe>` : '';
  return `<p>trigger</p><button onclick="go()">Go</button>${frame}<script>const to=${JSON.stringify(to)};function go(){const k=${JSON.stringify(kind)};if(k==='href'||k==='deferred')location.href=to;if(k==='replace')location.replace(to);if(k==='popup')window.open(to);if(k==='form'){const u=new URL(to);const f=document.createElement('form');f.action=u.origin+u.pathname;for(const [name,value] of u.searchParams){const i=document.createElement('input');i.type='hidden';i.name=name;i.value=value;f.append(i);}document.body.append(f);f.submit();}return 'went';}${kind === 'deferred' ? `setTimeout(go,${Number(p.get('defer') ?? 3000)});` : ''}</script>`;
}

function nest(p) {
  const n = p.get('n') ?? '';
  const marker = escape(`frame-marker-${n}`);
  const child =
    p.get('kind') === 'srcdoc'
      ? `<iframe name="${marker}" srcdoc="${escape(`<p>${marker}</p>`)}"></iframe>`
      : `<iframe name="${marker}"></iframe><script>const f=document.querySelector('iframe');const p=f.contentDocument.createElement('p');p.textContent=f.name;f.contentDocument.body.append(p)</script>`;
  const tag = JSON.stringify(n).replaceAll('<', '\\u003c');
  return `<p>${marker}</p>${child}<script>const n=${tag};history.replaceState(null,'',location.pathname+'/path-'+'secret-'+n+'?query-'+'secret='+n+'#fragment-'+'secret-'+n)</script>`;
}

function route(req, url, send, html, redirects) {
  const secret =
    redirects.get(`${url.hostname}${url.pathname}${url.search ?? ''}`) ??
    redirects.get(`${url.hostname}${url.pathname}`) ??
    redirects.get(url.pathname);
  if (secret) {
    if (!secret.to) return send(200, secret.body, 'text/plain');
    return send(secret.code ?? 302, secret.body, 'text/plain', {
      location: secret.to,
      'content-location': secret.to,
      refresh: `0;url=${secret.to}`,
      link: `<${secret.to}>; rel=preconnect`,
    });
  }
  const p = url.searchParams;
  const routes = {
    '/beacon': () => send(204, ''),
    '/hop': () =>
      send(Number(p.get('code') ?? 302), 'moved', 'text/plain', { location: p.get('to') ?? '/' }),
    '/data': () => send(200, `real-${p.get('n') ?? ''}`, 'text/plain'),
    '/live': () => send(200, tall, 'image/png'),
    '/img': () => send(200, tall, 'image/png'),
    '/script': () =>
      send(
        200,
        `globalThis.vectorScript=${JSON.stringify(`real-${p.get('n') ?? ''}`)}`,
        'text/javascript'
      ),
    '/listener.js': () =>
      send(
        200,
        "addEventListener('load', function () { document.body.dataset.listened = 'true'; });",
        'text/javascript',
        { sourcemap: '/listener.js.map' }
      ),
    '/page': () => html('trigger', trigger(p)),
    '/api/cookies': () => send(200, req.headers.cookie ?? 'none', 'text/plain'),
    '/plant': () =>
      html('plant', '<script>localStorage.setItem("canary","planted")</script>', {
        'set-cookie': [`canary=planted-${url.hostname}; Path=/`, 'del=1; Path=/'],
      }),
    '/rewritten': () => html('rewritten', '<p>REWRITTEN</p>'),
    '/framed': () => {
      const to = p.get('url') ?? 'about:blank';
      const log = p.get('log') ?? url.origin;
      const pre = `${log}/live?tag=${encodeURIComponent(p.get('tag') ?? '')}&step=pre&to=${encodeURIComponent(to)}`;
      return html(
        'framed',
        `<script>navigator.sendBeacon(${JSON.stringify(pre)})</script><iframe src="${escape(to)}"></iframe>`
      );
    },
    '/bfcache': () => {
      const marker = JSON.stringify(`bfcache-marker-${p.get('n') ?? ''}`).replaceAll(
        '<',
        '\\u003c'
      );
      return html(
        'bfcache',
        `<p id="bfcache-marker"></p><script>globalThis.__bfcacheMarker=${marker};sessionStorage.setItem('bfcache-marker',globalThis.__bfcacheMarker);document.querySelector('p').textContent=globalThis.__bfcacheMarker;globalThis.__bfcachePersisted=false;addEventListener('pageshow',e=>{globalThis.__bfcachePersisted=e.persisted});addEventListener('keydown',()=>{globalThis.__bfcacheKeys=(globalThis.__bfcacheKeys||0)+1})</script>`
      );
    },
    '/doc': () => document(url, html),
    '/csp': () => document(url, html),
  };
  if (req.method === 'OPTIONS') return send(204, '');
  if (url.pathname.startsWith('/auth')) {
    if (req.headers.authorization === 'Basic dTpw') return send(200, 'authed', 'text/plain');
    return send(401, 'unauthorized', 'text/plain', {
      'www-authenticate': `Basic realm="${escape(url.pathname)}"`,
    });
  }
  if (url.pathname.startsWith('/canary'))
    return html(
      'canary',
      `<p data-canary="${escape(p.get('value') ?? 'planted')}">canary-marker ${escape(url.host)}</p>`
    );
  if (url.pathname.startsWith('/nest')) return html('nest', nest(p));
  const handler = routes[url.pathname];
  if (handler) return handler();
  return send(404, 'missing', 'text/plain');
}

function requestURL(req, scheme) {
  const origin = `${scheme}://${req.headers.host}`;
  const parsed = parseURL(req.url, origin);
  if (parsed) return parsed;
  const path =
    parseURL(req.url, `${scheme}://fixture.invalid`) ?? new URL(`${scheme}://fixture.invalid/`);
  return {
    pathname: path.pathname,
    searchParams: path.searchParams,
    href: `${origin}${path.pathname}${path.search}${path.hash}`,
    origin,
    host: req.headers.host,
    hostname: String(req.headers.host ?? '').replace(/:\d+$/, ''),
  };
}

export async function fixtureServer({ host = '127.0.0.1', port = 0, tls, latency } = {}) {
  let entries = [];
  const history = [];
  const redirects = new Map();
  const redirectSecret = async ({ path, host = '', search = '', remove, ...value }) => {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      (!remove && typeof value.body !== 'string')
    )
      throw new Error('invalid redirect registration');
    const key = `${host}${path}${search}`;
    if (remove) redirects.delete(key);
    else redirects.set(key, value);
  };
  const scheme = tls ? 'https' : 'http';
  const handler = async (req, res) => {
    const url = requestURL(req, scheme);
    const p = url.searchParams;
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    const send = (code, body, type = 'text/html', headers = {}) => {
      res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, ...cors, ...headers });
      res.end(body);
    };
    const html = (title, body = '', headers = {}) =>
      send(
        200,
        `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}<img hidden src="/live?tag=${encodeURIComponent(p.get('tag') ?? p.get('n') ?? p.get('case') ?? p.get('value') ?? '')}&to=${encodeURIComponent(url.href)}">`,
        'text/html',
        headers
      );
    if (req.method === 'GET' && url.pathname === '/log') {
      const from = Number(p.get('since') ?? 0);
      if (!Number.isInteger(from) || from < 0 || from > history.length)
        return send(400, 'invalid log cursor', 'text/plain');
      return send(200, JSON.stringify({ from, entries: history.slice(from) }), 'application/json');
    }
    if (req.method === 'POST' && url.pathname === '/redirect') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        await redirectSecret(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        return send(204, '', 'text/plain');
      } catch {
        return send(400, 'invalid redirect registration', 'text/plain');
      }
    }
    const entry = {
      url: url.href,
      method: req.method,
      headers: { ...req.headers },
      time: Date.now(),
    };
    entries.push(entry);
    history.push(entry);
    const wait = latency?.(url) ?? 0;
    if (wait > 0) setTimeout(() => route(req, url, send, html, redirects), wait);
    else route(req, url, send, html, redirects);
  };
  const server = tls ? createSecureServer(tls, handler) : createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    redirects,
    redirectSecret,
    port: address.port,
    origin: `${scheme}://${host}:${address.port}`,
    log: () => structuredClone(entries),
    reset: () => {
      entries = [];
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
