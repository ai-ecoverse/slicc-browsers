import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function leaseFixtureCookiePolicy(client, fixture, sessionId) {
  const { billing } = fixture.sites;
  if (new URL(billing).hostname !== 'billing.example.test') throw Error('not a fixture');
  const { cookies } = await client.send('Network.getCookies', { urls: [billing] }, sessionId);
  const matching = cookies.filter(
    (c) => c.name === '__Host-fixture' && c.domain === 'billing.example.test' && c.path === '/'
  );
  if (matching.length !== 1) throw Error('missing or ambiguous synthetic session');
  const { sameSite, secure, httpOnly } = matching[0];
  return { sameSite, secure, httpOnly };
}

export async function leasePageFixture({ sameSite = 'Strict' } = {}) {
  if (!['Strict', 'Lax'].includes(sameSite)) throw Error('invalid fixture cookie policy');
  const dir = await mkdtemp(join(tmpdir(), 'lease-page-tls-'));
  let tls;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-nodes',
        '-newkey',
        'rsa:2048',
        '-subj',
        '/CN=lease-fixture',
        '-days',
        '1',
        '-keyout',
        join(dir, 'key'),
        '-out',
        join(dir, 'cert'),
      ],
      { stdio: 'ignore' }
    );
    tls = { key: await readFile(join(dir, 'key')), cert: await readFile(join(dir, 'cert')) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const spki = createHash('sha256')
    .update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const session = randomBytes(24).toString('hex');
  const cookie = `__Host-fixture=${session}`;
  const assets = new Set();
  const font = await readFile(new URL('./lease-square.woff', import.meta.url));
  const sockets = new Set();
  let submitted = 0;
  let sites;
  const body = () =>
    `<!doctype html><html lang="en"><title>Billing fixture</title><link rel="stylesheet" href="${sites.cdn}/app.css"><h1>Invoices</h1><p id="invoice">Loading</p><p id="symbol">$</p><form method="post" action="/submit"><label>Note<input name="note"></label><button>Save</button></form><a href="${sites.receipt}/r/1042" target="_blank">View receipt</a><iframe title="Support" src="${sites.support}/chat"></iframe><script src="${sites.cdn}/app.js"></script>`;
  const script = () =>
    `window.invoiceReady=Promise.all([fetch('${sites.api}/data').then(r=>r.json()),document.fonts.load('16px Fixture','$'),new Promise((resolve,reject)=>{const ws=new WebSocket('${sites.push.replace('https:', 'wss:')}/live');ws.onmessage=e=>{resolve(e.data);ws.close()};ws.onerror=reject}),navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready)]).then(([invoice,fonts,update])=>{if(fonts.length!==1||fonts[0].status!=='loaded')throw Error('fixture font');document.querySelector('#invoice').textContent=invoice.name+' · '+update;history.replaceState(null,'','/invoices/1042?view=table#paid');return true})`;
  const server = createServer(tls, (req, res) => {
    const host = req.headers.host;
    const at = (site, path) => host === new URL(site).host && req.url === path;
    const send = (type, content) => {
      res.setHeader('content-type', type);
      res.end(content);
    };
    if (at(sites.billing, '/owner-session')) {
      res.writeHead(302, {
        'set-cookie': `${cookie}; Secure; HttpOnly; SameSite=${sameSite}; Path=/`,
        location: '/',
      });
      return res.end();
    }
    if (host === new URL(sites.billing).host) {
      if (req.headers.cookie !== cookie) {
        res.writeHead(401);
        return res.end('Synthetic session required');
      }
      if (req.url === '/sw.js') {
        assets.add('worker');
        return send(
          'text/javascript',
          "self.addEventListener('install', e=>e.waitUntil(self.skipWaiting()))"
        );
      }
      if (req.url === '/' || req.url.startsWith('/invoices/'))
        return send('text/html; charset=utf-8', body());
      if (req.method === 'POST' && req.url === '/submit') {
        submitted++;
        return send('text/html', '<title>Saved</title><p>Fixture note saved</p>');
      }
    }
    if (at(sites.cdn, '/app.js')) {
      assets.add('script');
      return send('text/javascript', script());
    }
    if (at(sites.cdn, '/app.css')) {
      assets.add('stylesheet');
      return send(
        'text/css',
        `@font-face{font-family:Fixture;src:url('${sites.cdn}/square.woff')}#symbol{font-family:Fixture}`
      );
    }
    if (at(sites.cdn, '/square.woff')) {
      assets.add('font');
      res.setHeader('access-control-allow-origin', sites.billing);
      return send('font/woff', font);
    }
    if (at(sites.api, '/data')) {
      assets.add('api');
      res.setHeader('access-control-allow-origin', sites.billing);
      return send('application/json', JSON.stringify({ name: 'Invoice 1042' }));
    }
    if (at(sites.support, '/sso'))
      return send(
        'text/html',
        `<title>Human handoff</title><a href="${sites.billing}/">Resume billing</a>`
      );
    if (at(sites.support, '/chat')) {
      assets.add('embed');
      return send('text/html', '<p>Support frame fixture only</p>');
    }
    if (at(sites.receipt, '/r/1042')) return send('text/html', '<p>Receipt 1042</p>');
    res.writeHead(404);
    res.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket) => {
    if (
      req.url !== '/live' ||
      req.headers.host !== new URL(sites.push).host ||
      req.headers.origin !== sites.billing ||
      !req.headers['sec-websocket-key']
    )
      return socket.destroy();
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.on('error', () => socket.destroy());
    socket.on('data', () => socket.end());
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.write(Buffer.concat([Buffer.from([129, 4]), Buffer.from('paid')]));
    assets.add('websocket');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  sites = Object.fromEntries(
    ['billing', 'cdn', 'api', 'push', 'support', 'receipt'].map((name) => [
      name,
      `https://${name === 'support' ? 'cross.test' : `${name}.example.test`}:${port}`,
    ])
  );
  return {
    port,
    sites,
    spki,
    assets,
    submitted: () => submitted,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        for (const socket of sockets) socket.destroy();
      }),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await leasePageFixture();
  process.stdout.write(
    `${JSON.stringify({ sites: f.sites, spki: f.spki, chromiumArgs: [`--ignore-certificate-errors-spki-list=${f.spki}`, `--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP cross.test 127.0.0.1`], ownerStart: `${f.sites.billing}/owner-session` }, null, 2)}\n`
  );
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void f.close());
}
