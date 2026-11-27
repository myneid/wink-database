// Development host: serves the app in a normal browser and stands in for
// Wink's `blink.database` bridge. Queries go through the same Swift MySQL
// client Wink and Blink use (built from a Wink checkout on first run).
//
//   node dev/mock-host.mjs            # http://127.0.0.1:8790
//   WINK_SOURCES=/path/to/wink PORT=9000 node dev/mock-host.mjs
//
// Connections (with passwords, in plain text — development only) are kept in
// dev/.connections.json. There are no SSH tunnels here; use Wink for those.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 8790);
const winkSources = path.resolve(process.env.WINK_SOURCES || path.resolve(root, '../wink'));
const helperPath = path.join(here, '.build', 'database-dev-helper');

function buildHelper() {
  const sources = ['tools/database-dev-helper.swift', 'Sources/DatabaseURL.swift', 'Sources/MySQLClient.swift', 'Sources/DatabaseBridge.swift']
    .map(f => path.join(winkSources, f));
  const missing = sources.find(f => !fs.existsSync(f));
  if (missing) throw new Error(`Wink sources not found (${missing}). Set WINK_SOURCES to a Wink checkout.`);
  const newest = Math.max(...sources.map(f => fs.statSync(f).mtimeMs));
  if (fs.existsSync(helperPath) && fs.statSync(helperPath).mtimeMs > newest) return;
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  console.log('Building the database helper from', winkSources, '…');
  execFileSync('swiftc', ['-O', '-suppress-warnings', '-parse-as-library', ...sources, '-o', helperPath], { stdio: 'inherit' });
}
buildHelper();
const storePath = path.join(here, '.connections.json');

const load = () => { try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { return []; } };
const save = list => fs.writeFileSync(storePath, JSON.stringify(list, null, 2), { mode: 0o600 });
const publicView = c => ({ ...c, password: undefined, hasPassword: !!c.password, title: c.name || `${c.database || c.user} on ${c.host}` });

function parseURL(text) {
  let t = text.trim().replace(/^[A-Z_][A-Z0-9_]*=/, '').replace(/^["']|["']$/g, '').replace(/^jdbc:/i, '');
  const m = /^(mysql|mariadb|mysql2):\/\/(?:(.*)@)?([^/?:]+)(?::(\d+))?(?:\/([^?]*))?(?:\?(.*))?$/i.exec(t);
  if (!m) throw new Error('Paste a URL such as mysql://user:password@host:3306/database.');
  const [user = '', password = ''] = (m[2] || '').split(/:(.*)/s).map(decodeURIComponent);
  const params = new URLSearchParams(m[6] || '');
  return {
    id: randomUUID(), name: params.get('name') || '', host: m[3], port: Number(m[4] || 3306), user, password,
    database: decodeURIComponent(m[5] || ''), ssh: params.get('ssh') || '', readOnly: /^(1|true)$/i.test(params.get('readonly') || ''),
    ssl: /^(1|true)$/i.test(params.get('ssl') || ''), environment: params.get('env') || '', color: '',
  };
}

// One helper process = one MySQL session, like a Wink tab.
let session = null;
function startHelper() {
  const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  const waiting = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      waiting.get(reply.id)?.(reply);
      waiting.delete(reply.id);
    }
  });
  child.stdin.on('error', () => {});
  child.on('exit', code => {
    if (code) console.error(`helper exited with status ${code}`);
    for (const resolve of waiting.values()) resolve({ error: 'The database helper stopped.' });
    waiting.clear();
    if (session?.child === child) session.child = null;
  });
  let id = 0;
  const send = request => new Promise(resolve => {
    const n = ++id;
    waiting.set(n, resolve);
    child.stdin.write(JSON.stringify({ ...request, id: n }) + '\n');
  }).then(reply => { if (reply.error) throw new Error(reply.error); delete reply.id; return reply; });
  return { child, send };
}

async function openSession(c, database = c.database) {
  session?.child?.kill();
  const helper = startHelper();
  const info = await helper.send({ op: 'connect', connection: { host: c.host, port: c.port, user: c.user, password: c.password, database, ssl: c.ssl, readOnly: c.readOnly } });
  session = { ...helper, c, thread: info.thread, database: info.database || '' };
  return info;
}

const methods = {
  connections: () => load().map(publicView),
  sshHosts: () => [],
  importURL: ({ url }) => { const c = parseURL(url); save([...load(), c]); return publicView(c); },
  edit: ({ id, url }) => {
    if (!url) return null;
    const list = load();
    const next = { ...parseURL(url), id: id || randomUUID() };
    save([...list.filter(c => c.id !== id), next]);
    return publicView(next);
  },
  duplicate: ({ id }) => { const c = load().find(x => x.id === id); const copy = { ...c, id: randomUUID(), name: (c.name || c.host) + ' copy' }; save([...load(), copy]); return publicView(copy); },
  remove: ({ id }) => { save(load().filter(c => c.id !== id)); return true; },
  copyURL: ({ id }) => { const c = load().find(x => x.id === id); return `mysql://${encodeURIComponent(c.user)}@${c.host}:${c.port}/${c.database}`; },
  open: async ({ id }) => {
    const c = load().find(x => x.id === id);
    if (!c) throw new Error('That connection no longer exists.');
    if (c.ssh) throw new Error('The development host has no SSH tunnels; open this connection in Wink.');
    const info = await openSession(c);
    c.lastUsed = Date.now(); save(load().map(x => x.id === c.id ? c : x));
    return { connection: publicView(c), version: info.version, database: info.database, thread: info.thread };
  },
  status: () => ({ connected: !!session }),
  disconnect: () => { session?.child?.kill(); session = null; return true; },
  query: async ({ sql, params, maxRows, maxCell }) => {
    if (!session) throw new Error('Open a connection first.');
    if (!session.child) await openSession(session.c, session.database);
    const reply = await session.send({ op: 'query', sql, params, maxRows, maxCell });
    if (/^\s*use\s/i.test(sql)) session.database = (await session.send({ op: 'query', sql: 'SELECT DATABASE()' })).rows[0][0];
    return reply;
  },
  execute: async ({ statements }) => {
    if (!session) throw new Error('Open a connection first.');
    if (!session.child) await openSession(session.c, session.database);
    return session.send({ op: 'execute', statements });
  },
  cancel: async () => {
    if (!session?.child) return true;
    const { ok } = await session.send({ op: 'kill' });
    if (!ok) session.child.kill();
    return true;
  },
};

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/bridge') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { method, args } = JSON.parse(body);
    try {
      if (!methods[method]) throw new Error('Unsupported database method.');
      const result = await methods[method](args || {});
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: result ?? null }));
    } catch (error) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('Not found'); return; }
  let data = fs.readFileSync(file);
  if (rel === 'index.html') data = Buffer.from(String(data).replace('<script src="sql.js"', '<script src="dev/shim.js"></script>\n<script src="sql.js"'));
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
}).listen(port, '127.0.0.1', () => console.log(`Database Workbench dev host: http://127.0.0.1:${port}  (helper: ${helperPath})`));
