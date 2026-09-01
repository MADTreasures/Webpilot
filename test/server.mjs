// Minimaler deterministischer Test-Webserver fuer webpilot.
//
//   GET  /                 Login-Formular (user/password/remember)
//   POST /login            302 -> /welcome?user=... bzw. /denied
//   GET  /welcome          Zielseite nach erfolgreichem Login
//   GET  /denied           Zielseite nach fehlgeschlagenem Login
//   GET  /about            statische Nebenseite
//   GET  /framed           Login im iframe, dessen src eine wechselnde Nonce traegt
//   GET  /frame/<nonce>    das eingebettete Login-Formular
//
// Zugangsdaten: demo / s3cr3t
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, 'pages');
const VALID = { user: 'demo', password: 's3cr3t' };

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function page(name) {
  return readFile(join(PAGES, name), 'utf8');
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export function createTestServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      if (req.method === 'POST' && path === '/login') {
        const form = new URLSearchParams(await readBody(req));
        const ok = form.get('user') === VALID.user && form.get('password') === VALID.password;
        const to = ok ? `/welcome?user=${encodeURIComponent(form.get('user') ?? '')}` : '/denied';
        res.writeHead(302, { location: to, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (req.method === 'POST' && path === '/logout') {
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (path === '/' || path === '/login') return send(res, 200, await page('login.html'));
      if (path === '/welcome') {
        const who = url.searchParams.get('user') ?? 'Gast';
        return send(res, 200, (await page('welcome.html')).replace('__USER__', escapeHtml(who)));
      }
      if (path === '/denied') return send(res, 200, await page('denied.html'));
      if (path === '/about') return send(res, 200, await page('about.html'));
      if (path === '/framed') {
        // Nonce wechselt bei jedem Aufruf -> Frame-URL ist zwischen Aufnahme und Replay verschieden.
        const nonce = Math.random().toString(36).slice(2, 10);
        return send(res, 200, (await page('framed.html')).replace('__SRC__', `/frame/${nonce}`));
      }
      if (path.startsWith('/frame/')) return send(res, 200, await page('login.html'));

      return send(res, 404, '<h1>404</h1>');
    } catch (err) {
      send(res, 500, `<h1>500</h1><pre>${escapeHtml(String(err))}</pre>`);
    }
  });
}

export function startTestServer(port = 0) {
  const server = createTestServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// Direkt gestartet: fester Port, damit aufgezeichnete Flows wiederholbar sind.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const { origin } = await startTestServer(port);
  console.error(`[testserver] ${origin}`);
}
