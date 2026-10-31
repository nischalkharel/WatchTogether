// HTTP + WebSocket server. Serves the app, handles Google sign-in and partner
// linking, and relays playback between the two people in a linked pair.
// Run with `npm start`; settings are environment variables (see README).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LIMITS, Rooms } from './rooms.js';
import { ApiError, TTL, openStore } from './db.js';
import { MESSAGES } from './errors.js';
import { createOidc } from './oidc.js';
import { loadConfig } from './config.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com",
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
  "img-src 'self' data: https://i.ytimg.com",
  "style-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const HEARTBEAT_MS = 20_000;
const MAX_MSG_BYTES = 2048;
const MAX_BODY_BYTES = 4096;
const WS_RATE = { burst: 40, perSec: 15 }; // messages per connection
const SAVE_EVERY_MS = 2000; // most often a room's playback is written to disk
const PURGE_EVERY_MS = 3600_000;
const SESSION_MAX_AGE_S = TTL.SESSION / 1000;


// ---------------------------------------------------------------- helpers

function loadStatic() {
  const files = new Map();
  for (const name of fs.readdirSync(PUBLIC_DIR)) {
    const full = path.join(PUBLIC_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    const ext = path.extname(name);
    const body = fs.readFileSync(full);
    const compressible = ext !== '.png';
    files.set(`/${name}`, {
      body,
      gz: compressible ? zlib.gzipSync(body, { level: 9 }) : null,
      br: compressible ? zlib.brotliCompressSync(body) : null,
      type: TYPES[ext] || 'application/octet-stream',
      etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`,
    });
  }
  return files;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// Same-site-only page to return to after sign-in (never another website).
export function safeReturnTo(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return '/';
  if (!/^\/[A-Za-z0-9/_\-?=&.~%]*$/.test(raw) || raw.startsWith('//')) return '/';
  return raw;
}

const csrfFor = (tokenHash) => crypto.createHash('sha256').update(`csrf:${tokenHash}`).digest('base64url');

function timingSafeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Token bucket per key (an IP address or an account).
class Limiter {
  constructor({ burst, perMin, now }) {
    this.burst = burst;
    this.perMs = perMin / 60_000;
    this.now = now;
    this.map = new Map();
  }
  take(key) {
    const t = this.now();
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size > 50_000) this.map.clear(); // memory guard
      b = { tokens: this.burst, at: t };
      this.map.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (t - b.at) * this.perMs);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

const peopleIn = (room) => new Set([...room.clients].map((c) => c.uid)).size;

// ---------------------------------------------------------------- server

export function createServer(opts = {}) {
  const config = opts.config || loadConfig();
  if (config.errors.length) throw new Error(`Can't start safely:\n- ${config.errors.join('\n- ')}`);
  const now = opts.now || Date.now;
  const holdMaxMs = opts.holdMaxMs ?? LIMITS.HOLD_MAX_MS;
  const store = opts.store || openStore({ file: path.join(config.dataDir, 'watch.db'), now });
  const oidc = config.signInReady
    ? createOidc({
        issuer: config.issuer,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.redirectUri,
        now,
      })
    : null;
  const files = loadStatic();
  const rooms = new Rooms(now);
  const boot = crypto.randomUUID().slice(0, 8); // lets clients notice a restart
  const userSockets = new Map(); // user id -> Set of open sockets
  const k = config.rateScale;
  const limits = {
    auth: new Limiter({ burst: 20 * k, perMin: 10 * k, now }), // per IP: sign-in, log-in, sign-up
    loginName: new Limiter({ burst: 10 * k, perMin: 3 * k, now }), // per username: password guessing
    signup: new Limiter({ burst: 5 * k, perMin: 1 * k, now }), // per IP: new accounts
    chat: new Limiter({ burst: 10 * k, perMin: 60 * k, now }), // per account: chat messages
    invite: new Limiter({ burst: 10 * k, perMin: 5 * k, now }), // per account: stops guessing invite links
    inviteIp: new Limiter({ burst: 20 * k, perMin: 10 * k, now }), // per address: same, across accounts
    write: new Limiter({ burst: 60 * k, perMin: 60 * k, now }), // per account: everything else
  };
  // __Host- cookies can only be set over https, for this exact site, path /.
  const cookieName = config.secure ? '__Host-wt_session' : 'wt_session';

  // ---------------------------------------------------------- responses

  function baseHeaders(extra = {}) {
    const h = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      ...extra,
    };
    if (config.secure) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    return h;
  }

  function sendJson(res, status, body, extra = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(
      status,
      baseHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        ...extra,
      })
    );
    res.end(data);
  }

  function sendError(res, status, code, extra = {}) {
    sendJson(res, status, { error: code, message: MESSAGES[code] || MESSAGES['bad-request'] }, extra);
  }

  function redirect(res, to, extra = {}) {
    res.writeHead(302, baseHeaders({ Location: to, 'Cache-Control': 'no-store', ...extra }));
    res.end();
  }

  function sessionCookie(token, maxAgeS) {
    const parts = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`];
    if (config.secure) parts.push('Secure');
    return parts.join('; ');
  }
  const clearCookie = () => sessionCookie('', 0);

  function serveStatic(req, res, pathname) {
    const f = files.get(pathname);
    if (!f) {
      res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain' })).end('Not found');
      return;
    }
    const headers = baseHeaders({
      'Content-Type': f.type,
      ETag: f.etag,
      'Cache-Control': 'no-cache',
      Vary: 'Accept-Encoding',
    });
    if (f.type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
    if (req.headers['if-none-match'] === f.etag) {
      res.writeHead(304, headers).end();
      return;
    }
    const accept = String(req.headers['accept-encoding'] || '');
    let body = f.body;
    if (f.br && /\bbr\b/.test(accept)) {
      body = f.br;
      headers['Content-Encoding'] = 'br';
    } else if (f.gz && /\bgzip\b/.test(accept)) {
      body = f.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ---------------------------------------------------------- request context

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || '?';
  }

  function sessionFrom(req) {
    const token = parseCookies(req.headers.cookie)[cookieName];
    return token ? store.getSession(token) : null;
  }

  // Changes must come from our own pages: right Origin plus a CSRF token tied
  // to the session. This stops other websites acting on someone's behalf.
  function checkWrite(req, sess) {
    if (req.headers.origin !== config.origin) throw new ApiError(403, 'bad-origin');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') throw new ApiError(403, 'bad-origin');
    if (!sess) throw new ApiError(401, 'sign-in-required');
    if (!timingSafeEq(req.headers['x-csrf-token'] || '', csrfFor(sess.tokenHash))) throw new ApiError(403, 'bad-csrf');
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        reject(new ApiError(415, 'bad-request'));
        return;
      }
      if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
        req.resume(); // discard it; the 413 is sent once it's drained
        reject(new ApiError(413, 'bad-request'));
        return;
      }
      let size = 0;
      let tooBig = false;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) tooBig = true; // keep draining, store nothing more
        else chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return reject(new ApiError(413, 'bad-request'));
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
          resolve(v);
        } catch {
          reject(new ApiError(400, 'bad-request'));
        }
      });
      req.on('error', reject);
    });
  }

  // ---------------------------------------------------------- live updates

  function track(uid, ws) {
    let set = userSockets.get(uid);
    if (!set) userSockets.set(uid, (set = new Set()));
    set.add(ws);
  }
  function untrack(uid, ws) {
    const set = userSockets.get(uid);
    if (!set) return;
    set.delete(ws);
    if (!set.size) userSockets.delete(uid);
  }
  // Tell someone's open pages their account changed; they re-fetch /api/me.
  function nudge(uid) {
    for (const ws of userSockets.get(uid) || []) if (ws.readyState === ws.OPEN) ws.send('{"type":"account"}');
  }
  // Send a message to every open page of both people in a pair.
  function tellPair(uid, msg) {
    const link = store.linkOf(uid);
    const data = JSON.stringify(msg);
    for (const id of link ? [uid, link.partner.id] : [uid]) {
      for (const ws of userSockets.get(id) || []) if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
  // The current suggestion as each person sees it ("mine" = I suggested it).
  function proposalFor(uid, p) {
    if (!p) return null;
    return { id: p.id, v: p.v, title: p.title, start: p.start, fromItem: !!p.itemId, mine: p.byUser === uid, expiresAt: p.expiresAt };
  }
  // Tell everyone in the pair's room about the current suggestion (or that there's none).
  function sendProposal(linkId) {
    const room = rooms.map.get(linkId);
    if (!room) return;
    const p = store.proposalOf(linkId);
    for (const c of room.clients) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify({ type: 'proposal', proposal: proposalFor(c.uid, p) }));
    }
  }

  // Close a user's live connections (unlinked, signed out, deleted).
  function disconnect(uid, reason) {
    for (const ws of [...(userSockets.get(uid) || [])]) ws.close(4001, reason);
  }
  function disconnectSession(tokenHash) {
    for (const set of userSockets.values()) {
      for (const ws of [...set]) if (ws.sessionHash === tokenHash) ws.close(4001, 'signed-out');
    }
  }

  function me(sess) {
    const uid = sess.user.id;
    const link = store.linkOf(uid);
    return {
      user: { name: sess.user.name, username: store.loginNameOf(uid), hasPassword: store.hasPassword(uid) },
      csrf: csrfFor(sess.tokenHash),
      partner: link ? { name: link.partner.name, since: link.since } : null,
      invite: store.inviteOf(uid),
      incoming: store.incomingRequests(uid),
      outgoing: store.outgoingRequest(uid),
    };
  }

  // ---------------------------------------------------------- routes

  async function handleAuthStart(req, res, url) {
    if (!oidc) return sendError(res, 503, 'unavailable');
    if (!limits.auth.take(clientIp(req))) return sendError(res, 429, 'too-many');
    const flow = store.createOAuthFlow(safeReturnTo(url.searchParams.get('next')));
    redirect(res, await oidc.authUrl(flow));
  }

  async function handleAuthCallback(req, res, url) {
    if (!oidc) return redirect(res, '/?signin=error');
    if (!limits.auth.take(clientIp(req))) return redirect(res, '/?signin=error');
    const flow = store.takeOAuthFlow(url.searchParams.get('state'));
    if (!flow) return redirect(res, '/?signin=expired');
    if (url.searchParams.get('error')) return redirect(res, '/?signin=cancelled');
    let ident;
    try {
      ident = await oidc.finish({ code: url.searchParams.get('code'), verifier: flow.verifier, nonce: flow.nonce });
    } catch (e) {
      console.warn('sign-in failed:', e.message);
      return redirect(res, '/?signin=error');
    }
    const user = store.upsertUser({ provider: 'google', subject: ident.subject, name: ident.name });
    // A fresh session on every sign-in; an older one on this browser is ended.
    const old = sessionFrom(req);
    if (old) store.deleteSessionHash(old.tokenHash);
    const token = store.createSession(user.id);
    redirect(res, flow.returnTo, { 'Set-Cookie': sessionCookie(token, SESSION_MAX_AGE_S) });
  }

  // Offline accounts. Same-site only, rate limited per address and per
  // username, and the same answer for "no such user" and "wrong password".
  async function handlePasswordAuth(req, res, pathname, sess) {
    if (req.headers.origin !== config.origin) throw new ApiError(403, 'bad-origin');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') throw new ApiError(403, 'bad-origin');
    const ip = clientIp(req);
    if (!limits.auth.take(ip)) throw new ApiError(429, 'too-many');
    const body = await readJson(req);
    let user;
    if (pathname === '/api/signup') {
      if (!limits.signup.take(ip)) throw new ApiError(429, 'too-many');
      user = await store.createLocalUser({ username: body.username, password: body.password, name: body.name });
    } else {
      const key = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 40) : '';
      if (!limits.loginName.take(key)) throw new ApiError(429, 'too-many');
      user = await store.checkLocalLogin(body.username, body.password);
      if (!user) throw new ApiError(401, 'bad-login');
    }
    // A fresh session; any older one on this browser is ended (no fixation).
    if (sess) store.deleteSessionHash(sess.tokenHash);
    const token = store.createSession(user.id);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_MAX_AGE_S) });
  }

  function playlistChanged(res, uid, result) {
    tellPair(uid, { type: 'playlists' });
    return sendJson(res, 200, result);
  }

  async function handleApi(req, res, pathname) {
    const sess = sessionFrom(req);
    const extra = sess && sess.refreshed ? { 'Set-Cookie': sessionCookie(sess.token, SESSION_MAX_AGE_S) } : {};

    if (req.method === 'GET' && pathname === '/api/me') {
      if (!sess) return sendJson(res, 200, { user: null, googleReady: !!oidc });
      return sendJson(res, 200, { ...me(sess), googleReady: !!oidc }, extra);
    }
    // Reads of the pair's shared things: signed in, and only from our own pages.
    const reads = {
      '/api/playlists': (uid) => ({ playlists: store.listPlaylists(uid) }),
      '/api/chat': (uid, q) => store.listMessages(uid, Number(q.get('before')) || undefined),
      '/api/history': (uid, q) => store.listHistory(uid, Number(q.get('before')) || undefined),
    };
    if (req.method === 'GET' && reads[pathname]) {
      if (!sess) throw new ApiError(401, 'sign-in-required');
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') throw new ApiError(403, 'bad-origin');
      return sendJson(res, 200, reads[pathname](sess.user.id, new URL(req.url, 'http://x').searchParams));
    }
    if (req.method === 'GET' && pathname === '/api/export') {
      if (!sess) throw new ApiError(401, 'sign-in-required');
      // Personal data: only to our own pages, never to another site.
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') throw new ApiError(403, 'bad-origin');
      const body = JSON.stringify(store.exportUser(sess.user.id), null, 2);
      res.writeHead(
        200,
        baseHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="watch-together-my-data.json"',
          'Cache-Control': 'no-store',
        })
      );
      return res.end(body);
    }
    if (req.method !== 'POST') throw new ApiError(404, 'not-found');

    if (pathname === '/api/signup' || pathname === '/api/login') return handlePasswordAuth(req, res, pathname, sess);

    checkWrite(req, sess);
    const uid = sess.user.id;
    // Endpoints that take an invite secret are limited per account AND per
    // address, so making extra accounts doesn't buy more guesses.
    const guessing = pathname === '/api/invite/peek' || pathname === '/api/invite/use';
    if (guessing ? !limits.invite.take(uid) || !limits.inviteIp.take(clientIp(req)) : !limits.write.take(uid)) {
      throw new ApiError(429, 'too-many');
    }
    const body = await readJson(req);

    switch (pathname) {
      case '/api/name': {
        const name = store.setName(uid, body.name);
        const link = store.linkOf(uid);
        if (link) nudge(link.partner.id);
        return sendJson(res, 200, { name });
      }
      case '/api/invite': {
        const inv = store.createInvite(uid);
        // The secret goes after # so it never reaches server logs or other sites.
        return sendJson(res, 200, { url: `${config.origin}/join#${inv.token}`, expiresAt: inv.expiresAt });
      }
      case '/api/invite/revoke':
        store.revokeInvite(uid);
        return sendJson(res, 200, { ok: true });
      case '/api/invite/peek':
        return sendJson(res, 200, store.peekInvite(uid, body.token));
      case '/api/invite/use': {
        const r = store.redeemInvite(uid, body.token);
        nudge(r.toUser);
        return sendJson(res, 200, { name: r.name, code: r.code });
      }
      case '/api/request/accept': {
        const r = store.acceptRequest(uid, body.id);
        nudge(r.partnerId);
        r.affected.forEach(nudge);
        return sendJson(res, 200, { ok: true });
      }
      case '/api/request/decline': {
        const other = store.declineRequest(uid, body.id);
        if (other) nudge(other);
        return sendJson(res, 200, { ok: true });
      }
      case '/api/request/cancel': {
        const other = store.cancelRequest(uid);
        if (other) nudge(other);
        return sendJson(res, 200, { ok: true });
      }
      // ---- shared playlists (only ever the caller's own pair's)
      case '/api/playlists/create':
        return playlistChanged(res, uid, store.createPlaylist(uid, body.name));
      case '/api/playlists/rename':
        return playlistChanged(res, uid, store.renamePlaylist(uid, body.id, body.name));
      case '/api/playlists/delete':
        store.deletePlaylist(uid, body.id);
        return playlistChanged(res, uid, { ok: true });
      case '/api/playlists/add':
        return playlistChanged(res, uid, store.addToPlaylist(uid, body.playlist, { v: body.v, title: body.title, start: body.start }));
      case '/api/playlists/remove':
        store.removeFromPlaylist(uid, body.item);
        return playlistChanged(res, uid, { ok: true });
      case '/api/playlists/title': {
        // Quietly fill in a title we now know; tell the pair only if something changed.
        if (store.fillTitle(uid, body.v, body.title)) {
          tellPair(uid, { type: 'playlists' });
          tellPair(uid, { type: 'history' });
        }
        return sendJson(res, 200, { ok: true });
      }
      case '/api/playlists/move':
        store.moveInPlaylist(uid, body.item, body.dir);
        return playlistChanged(res, uid, { ok: true });

      // ---- "watch this?" (a new video only starts once the other person accepts)
      case '/api/propose': {
        const { linkId, proposal } = store.propose(uid, { v: body.v, title: body.title, start: body.start, itemId: body.item });
        sendProposal(linkId);
        return sendJson(res, 200, { proposal: proposalFor(uid, proposal) });
      }
      case '/api/proposal/accept': {
        const { linkId, proposal } = store.closeProposal(uid, body.id, { accept: true });
        const room = rooms.map.get(linkId) || rooms.get(linkId, store.loadRoom(linkId));
        if (room && room.load(proposal.v, proposal.start)) broadcastState(room, null, 'load');
        sendProposal(linkId);
        store.recordWatched(linkId, { v: proposal.v, title: proposal.title, pickedBy: proposal.byUser });
        tellPair(uid, { type: 'history' });
        return sendJson(res, 200, { ok: true });
      }
      case '/api/proposal/decline': {
        const { linkId, proposal } = store.closeProposal(uid, body.id, { accept: false });
        sendProposal(linkId);
        // Each person hears it their way: "you"/"your partner" withdrew/declined.
        const withdrawn = proposal.byUser === uid;
        for (const id of [uid, store.linkOf(uid)?.partner.id]) {
          for (const ws of userSockets.get(id) || []) {
            if (ws.readyState !== ws.OPEN) continue;
            ws.send(JSON.stringify({ type: 'proposal-closed', withdrawn, byMe: id === uid, title: proposal.title }));
          }
        }
        return sendJson(res, 200, { ok: true });
      }

      // ---- chat and history (only ever the caller's own pair's)
      case '/api/chat/clear':
        store.clearChat(uid);
        tellPair(uid, { type: 'chat-cleared' });
        return sendJson(res, 200, { ok: true });
      case '/api/history/remove':
        store.removeHistory(uid, body.id);
        tellPair(uid, { type: 'history' });
        return sendJson(res, 200, { ok: true });
      case '/api/history/clear':
        store.clearHistory(uid);
        tellPair(uid, { type: 'history' });
        return sendJson(res, 200, { ok: true });

      case '/api/unlink': {
        const r = store.unlink(uid);
        if (r) {
          rooms.delete(r.linkId);
          disconnect(uid, 'unlinked');
          disconnect(r.partnerId, 'unlinked');
        }
        return sendJson(res, 200, { ok: true });
      }
      case '/api/password': {
        if (store.hasPassword(uid)) {
          await store.changePassword(uid, body.current, body.password);
        } else {
          // A Google account adding a username + password as a second way in.
          await store.addLocalLogin(uid, body.username, body.password);
        }
        // Everyone else holding this account is signed out; this device stays.
        store.deleteOtherSessions(uid, sess.tokenHash);
        for (const ws of [...(userSockets.get(uid) || [])]) if (ws.sessionHash !== sess.tokenHash) ws.close(4001, 'signed-out');
        return sendJson(res, 200, { ok: true });
      }
      case '/api/signout':
        store.deleteSessionHash(sess.tokenHash);
        disconnectSession(sess.tokenHash);
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
      case '/api/signout-all':
        store.deleteUserSessions(uid);
        disconnect(uid, 'signed-out');
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
      case '/api/delete': {
        if (body.confirm !== 'DELETE') throw new ApiError(400, 'confirm-mismatch');
        const link = store.linkOf(uid);
        const affected = store.deleteUser(uid);
        if (link) rooms.delete(link.linkId);
        disconnect(uid, 'deleted');
        for (const p of affected) {
          if (link && p === link.partner.id) disconnect(p, 'unlinked');
          else nudge(p);
        }
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
      }
      default:
        throw new ApiError(404, 'not-found');
    }
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const p = url.pathname;
    try {
      if (p === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
      } else if (p.startsWith('/api/')) {
        await handleApi(req, res, p);
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, baseHeaders({ Allow: 'GET, HEAD' })).end();
      } else if (p === '/auth/google') {
        await handleAuthStart(req, res, url);
      } else if (p === '/auth/google/callback') {
        await handleAuthCallback(req, res, url);
      } else if (p === '/' || p === '/join' || p === '/account' || p === '/privacy') {
        serveStatic(req, res, '/index.html');
      } else {
        serveStatic(req, res, p);
      }
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof ApiError) return sendError(res, e.status, e.code);
      console.error('request failed:', e);
      sendError(res, 500, 'bad-request');
    }
  });

  // ---------------------------------------------------------- watching together

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES, perMessageDeflate: false });

  function refuse(socket, status) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return refuse(socket, '400 Bad Request');
    }
    if (url.pathname !== '/ws') return refuse(socket, '404 Not Found');
    // Another website can't open this connection using someone's cookie.
    if (req.headers.origin !== config.origin) return refuse(socket, '403 Forbidden');
    const sess = sessionFrom(req);
    if (!sess) return refuse(socket, '401 Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, sess));
  });

  function saveSoon(room) {
    if (room.saveTimer) return;
    const wait = Math.max(0, SAVE_EVERY_MS - (now() - (room.savedAt || 0)));
    room.saveTimer = setTimeout(() => saveNow(room), wait);
    room.saveTimer.unref?.();
  }

  function saveNow(room) {
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
    const st = room.state;
    if (!st.v || room.gone) return;
    const pos = st.playing && !st.hold.length ? st.pos + Math.max(0, now() - st.at) / 1000 : st.pos;
    try {
      store.saveRoom(room.id, { v: st.v, playing: st.playing, pos });
      room.savedAt = now();
    } catch (e) {
      // e.g. the pair unlinked a moment ago and the row is gone: nothing to keep.
      if (!/FOREIGN KEY/.test(e.message)) console.error('could not save playback:', e.message);
    }
  }

  function broadcastState(room, by, kind) {
    const msg = JSON.stringify({ type: 'state', state: room.snapshot(), by, kind, n: peopleIn(room) });
    for (const c of room.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
    if (kind !== 'hold' && kind !== 'unhold') saveSoon(room);
  }

  function broadcastPresence(room) {
    const msg = JSON.stringify({ type: 'presence', n: peopleIn(room) });
    for (const c of room.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  }

  function onConnection(ws, sess) {
    const uid = sess.user.id;
    ws.sessionHash = sess.tokenHash;
    ws.isAlive = true;
    track(uid, ws);
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('close', () => {
      untrack(uid, ws);
      if (ws.client) leaveRoom(ws);
    });
    ws.on('error', () => {});

    const link = store.linkOf(uid);
    let room = null;
    if (link) {
      room = rooms.map.get(link.linkId) || rooms.get(link.linkId, store.loadRoom(link.linkId));
    }
    if (!room || room.clients.size >= LIMITS.MAX_CLIENTS_PER_ROOM) {
      // Signed in but not linked: the connection only carries account updates
      // to the page. The page never sends anything on it, so anything sent is refused.
      ws.send(JSON.stringify({ type: 'nolink' }));
      ws.on('message', () => ws.close(1008, 'not linked'));
      return;
    }
    joinRoom(ws, uid, room);
  }

  function joinRoom(ws, uid, room) {
    const client = { id: crypto.randomUUID().slice(0, 8), uid, ws, tokens: WS_RATE.burst, refillAt: now() };
    ws.client = client;
    ws.room = room;
    room.join(client);
    ws.send(
      JSON.stringify({
        type: 'welcome',
        id: client.id,
        boot,
        state: room.snapshot(),
        n: peopleIn(room),
        t: now(),
        proposal: proposalFor(uid, store.proposalOf(room.id)),
      })
    );
    broadcastPresence(room);

    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      const t = now();
      client.tokens = Math.min(WS_RATE.burst, client.tokens + ((t - client.refillAt) / 1000) * WS_RATE.perSec);
      client.refillAt = t;
      if (client.tokens < 1) return;
      client.tokens -= 1;
      if (isBinary) return;
      // The pair may have unlinked since this connection opened.
      if (room.gone) return ws.close(4001, 'unlinked');
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', c: msg.c, t: now() }));
      } else if (msg.type === 'chat') {
        sendChat(ws, client, msg);
      } else if (msg.type === 'action') {
        if (room.action(msg.action, msg.at)) broadcastState(room, client.id, msg.action.type);
      } else if (msg.type === 'buffer') {
        if (room.buffer(client.id, msg.on === true)) {
          if (msg.on === true) {
            const timer = setTimeout(() => {
              if (room.release(client.id)) broadcastState(room, client.id, 'unhold');
            }, holdMaxMs);
            room.setHoldTimer(client.id, () => clearTimeout(timer));
          }
          broadcastState(room, client.id, msg.on === true ? 'hold' : 'unhold');
        }
      }
    });
  }

  // A chat message: saved, then sent to every open page of both people.
  // The sender's own page gets it back with `ref`, so it can mark it as sent.
  function sendChat(ws, client, msg) {
    const reply = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const ref = typeof msg.ref === 'string' ? msg.ref.slice(0, 40) : null;
    if (!limits.chat.take(client.uid)) return reply({ type: 'chat-error', ref, error: 'too-many', message: MESSAGES['too-many'] });
    let saved;
    try {
      saved = store.sendMessage(client.uid, msg.text);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'bad-request';
      return reply({ type: 'chat-error', ref, error: code, message: MESSAGES[code] || MESSAGES['bad-request'] });
    }
    const { message } = saved;
    const link = store.linkOf(client.uid);
    for (const uid of [client.uid, link.partner.id]) {
      for (const s of userSockets.get(uid) || []) {
        if (s.readyState !== s.OPEN) continue;
        s.send(JSON.stringify({ type: 'chat', message: { id: message.id, text: message.text, at: message.at, mine: uid === client.uid }, ref: s === ws ? ref : undefined }));
      }
    }
  }

  function leaveRoom(ws) {
    const room = ws.room;
    const changed = room.leave(ws.client);
    if (room.gone) return;
    if (changed) broadcastState(room, ws.client.id, 'unhold');
    broadcastPresence(room);
    if (!room.clients.size) saveNow(room);
  }

  // ---------------------------------------------------------- upkeep

  // Drop connections that stopped answering (e.g. a phone lost signal), and
  // connections whose session has ended or expired.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function upkeep() {
    try {
      store.purgeExpired();
      rooms.sweep();
      for (const ws of wss.clients) {
        if (ws.sessionHash && !store.sessionExists(ws.sessionHash)) ws.close(4001, 'signed-out');
      }
    } catch (e) {
      console.error('cleanup failed:', e.message);
    }
  }
  const purge = setInterval(upkeep, PURGE_EVERY_MS);
  purge.unref();
  store.purgeExpired();

  async function backup() {
    try {
      const file = await store.backupTo(config.backupDir, config.backupKeep);
      console.log('backup saved:', path.basename(file));
      return file;
    } catch (e) {
      console.error('BACKUP FAILED:', e.message);
      return null;
    }
  }
  const backupTimer = config.backupEveryMs ? setInterval(backup, config.backupEveryMs) : null;
  backupTimer?.unref();

  // Stopping the server saves playback, drops live sockets, then closes the database.
  const httpClose = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(heartbeat);
    clearInterval(purge);
    clearInterval(backupTimer);
    for (const room of rooms.map.values()) if (room.saveTimer || room.clients.size) saveNow(room);
    for (const ws of wss.clients) ws.terminate();
    httpClose((err) => {
      if (!opts.store) store.close();
      cb?.(err);
    });
    server.closeAllConnections();
    return server;
  };

  return { server, wss, rooms, store, config, backup, upkeep };
}

// Start from environment settings and listen; used by `npm start`.
export function main() {
  let app;
  try {
    app = createServer();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { server, config } = app;
  server.listen(config.port, config.host, () => {
    console.log(`Watch Together running on ${config.origin}`);
    if (!config.signInReady) console.log('Google sign-in is off (no GOOGLE_CLIENT_ID). People sign in with a username and password.');
    if (config.backupEveryMs) {
      setTimeout(app.backup, 60_000).unref();
      fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
      if (fs.statSync(config.backupDir).dev === fs.statSync(config.dataDir).dev) {
        console.log('Note: backups are on the same disk as the data. Set BACKUP_DIR to another disk to survive a disk failure.');
      }
    } else {
      console.log('WARNING: automatic backups are turned off (BACKUP_EVERY_HOURS=0).');
    }
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
