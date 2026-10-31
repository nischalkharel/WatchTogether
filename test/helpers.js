// Starts the real server against a fake Google, and drives it like a browser.
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from '../server.js';
import { loadConfig } from '../config.js';
import { startFakeGoogle } from './fake-google.js';

const CLIENT_ID = 'test-client.apps.example';
const CLIENT_SECRET = 'test-secret';

export function tmpDir(prefix = 'srv-') {
  const base = path.resolve('.e2e-env/tmp-tests');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

export async function startApp({ env = {}, holdMaxMs, dataDir } = {}) {
  const google = await startFakeGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const dir = dataDir || tmpDir();
  let app;
  let origin;
  const boot = async (port = 0) => {
    // PUBLIC_URL must match the real port, so pick it first.
    const probe = await import('node:net').then((net) =>
      new Promise((r) => {
        const s = net.createServer().listen(port, '127.0.0.1', () => {
          const p = s.address().port;
          s.close(() => r(p));
        });
      })
    );
    origin = `http://127.0.0.1:${probe}`;
    const config = loadConfig({
      PUBLIC_URL: origin,
      OIDC_ISSUER: google.issuer,
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      DATA_DIR: dir,
      BACKUP_EVERY_HOURS: '0',
      ...env,
    });
    app = createServer({ config, holdMaxMs });
    await new Promise((r) => app.server.listen(probe, '127.0.0.1', r));
    return app;
  };
  await boot();
  const h = {
    google,
    dir,
    get app() {
      return app;
    },
    get origin() {
      return origin;
    },
    // Stop and start again on the same port and data (like a deploy/crash restart).
    async restart() {
      const port = new URL(origin).port;
      await new Promise((r) => app.server.close(r));
      await boot(Number(port));
    },
    browser: () => new Browser(h),
    async signedIn(sub, name) {
      const b = new Browser(h);
      await b.signIn(sub, name);
      return b;
    },
    // Two people, signed in and linked.
    async couple(names = ['Alex', 'Bo']) {
      const a = await h.signedIn(`sub-${names[0]}-${Math.random()}`, names[0]);
      const b = await h.signedIn(`sub-${names[1]}-${Math.random()}`, names[1]);
      await linkPeople(a, b);
      return [a, b];
    },
    async close() {
      await new Promise((r) => app.server.close(r));
      await google.close();
      if (!dataDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

export async function linkPeople(a, b) {
  const inv = await a.post('/api/invite');
  const token = new URL(inv.body.url).hash.slice(1);
  const used = await b.post('/api/invite/use', { token });
  if (used.status !== 200) throw new Error(`invite failed: ${JSON.stringify(used.body)}`);
  const me = await a.get('/api/me');
  const r = await a.post('/api/request/accept', { id: me.body.incoming[0].id });
  if (r.status !== 200) throw new Error(`accept failed: ${JSON.stringify(r.body)}`);
}

// One person suggests a video and the other accepts: the only way a new
// video starts for the pair.
export async function agreeOn(proposer, accepter, v, start = 0) {
  const p = await proposer.post('/api/propose', { v, start });
  if (p.status !== 200) throw new Error(`propose failed: ${JSON.stringify(p.body)}`);
  const r = await accepter.post('/api/proposal/accept', { id: p.body.proposal.id });
  if (r.status !== 200) throw new Error(`accept failed: ${JSON.stringify(r.body)}`);
}

// A minimal browser: keeps cookies, sends Origin like a real one would.
export class Browser {
  constructor(h) {
    this.h = h;
    this.cookies = new Map();
    this.csrf = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  keepCookies(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const maxAge = attrs.map((a) => a.trim()).find((a) => /^max-age=/i.test(a));
      if (!value || (maxAge && Number(maxAge.split('=')[1]) <= 0)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async raw(pathOrUrl, init = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.h.origin + pathOrUrl;
    const headers = { ...(init.headers || {}) };
    if (url.startsWith(this.h.origin) && this.cookies.size) headers.cookie = this.cookieHeader();
    let res;
    try {
      res = await fetch(url, { ...init, headers, redirect: 'manual' });
    } catch (e) {
      // A kept-alive connection to a server that has since restarted: browsers
      // quietly retry on a new connection, so do the same.
      if (e.cause?.code !== 'UND_ERR_SOCKET') throw e;
      res = await fetch(url, { ...init, headers, redirect: 'manual' });
    }
    if (url.startsWith(this.h.origin)) this.keepCookies(res);
    return res;
  }

  async get(p, headers = {}) {
    const res = await this.raw(p, { headers });
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body, headers: res.headers };
  }

  async post(p, data = {}, { headers = {}, origin = this.h.origin, csrf = this.csrf } = {}) {
    if (csrf === null && this.cookies.size) {
      const me = await this.get('/api/me');
      csrf = this.csrf = me.body.csrf || '';
    }
    const res = await this.raw(p, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...headers,
      },
      body: typeof data === 'string' ? data : JSON.stringify(data),
    });
    const text = await res.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body, headers: res.headers };
  }

  // Full Google sign-in, following every redirect like a browser.
  async signIn(sub, name, next = '/') {
    this.h.google.nextUser = { sub, name, email: `${sub}@example.com` };
    let res = await this.raw(`/auth/google?next=${encodeURIComponent(next)}`);
    // Our server -> Google -> back to our callback, which redirects to a page.
    for (let i = 0; i < 2 && res.status === 302; i++) res = await this.raw(res.headers.get('location'));
    this.lastLocation = res.headers.get('location');
    this.csrf = null;
    return res;
  }

  ws() {
    return openSocket(this.h.origin, this.cookieHeader());
  }
}

// WebSocket with a message queue we can wait on.
export function openSocket(origin, cookie, { originHeader = origin } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, {
      headers: { ...(cookie ? { cookie } : {}), ...(originHeader ? { origin: originHeader } : {}) },
    });
    const queue = [];
    const waiters = [];
    const closed = new Promise((r) => ws.once('close', (code, reason) => r({ code, reason: String(reason) })));
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.on('open', () =>
      resolve({
        ws,
        closed,
        send: (m) => ws.send(JSON.stringify(m)),
        next(pred = () => true, ms = 2000) {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const w = { pred, resolve: (m) => (clearTimeout(t), res(m)) };
            const t = setTimeout(() => {
              waiters.splice(waiters.indexOf(w), 1);
              rej(new Error('timed out waiting for message'));
            }, ms);
            waiters.push(w);
          });
        },
        close: () => new Promise((r) => (ws.readyState === ws.CLOSED ? r() : (ws.once('close', r), ws.close()))),
      })
    );
  });
}
