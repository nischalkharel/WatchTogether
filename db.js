// Everything the app remembers lives in one SQLite file (DATA_DIR/watch.db).
// We keep as little as possible: no email addresses, no photos, and only
// hashes of secret tokens (a copy of the database can't be used to sign in).
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { isVideoId, clampPos, PLACEHOLDER_TITLE } from './public/sync.js';
import { ApiError } from './errors.js';
import { hashPassword, verifyPassword, verifyDummy, normalizeUsername, checkPassword } from './passwords.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const TTL = Object.freeze({
  SESSION: 30 * DAY, // signed out after 30 days without using the app
  SESSION_TOUCH: HOUR, // how often "last used" is updated
  OAUTH: 10 * MIN, // time allowed to finish signing in with Google
  INVITE: DAY,
  REQUEST: 7 * DAY,
  PROPOSAL: DAY, // a suggestion waits a day for the other person
});

export const PLAYLIST_LIMITS = Object.freeze({ LISTS: 50, ITEMS: 500 });
// Chat keeps the newest messages per pair; older ones are deleted for good.
export const CHAT = Object.freeze({ KEEP: 1000, MAX_CHARS: 500, PAGE: 50 });
export const HISTORY = Object.freeze({ KEEP: 2000, PAGE: 50 });
export { PLACEHOLDER_TITLE };

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const newId = () => crypto.randomBytes(12).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

export { ApiError };

// Names are shown to the partner: strip invisible/control characters, limit length.
export function cleanName(raw, max = 40) {
  if (typeof raw !== 'string') return '';
  const s = raw
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .trim();
  return [...s].slice(0, max).join('').trim();
}

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (provider, subject)
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE oauth_flows (
    state_hash TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    return_to TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  -- user_id is the primary key, so nobody can be in more than one link.
  CREATE TABLE link_members (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE
  );
  CREATE INDEX link_members_link ON link_members(link_id);
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX requests_to ON requests(to_user);
  CREATE TABLE room_state (
    link_id TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
    v TEXT,
    playing INTEGER NOT NULL,
    pos REAL NOT NULL,
    saved_at INTEGER NOT NULL
  );
  `,
  // v2: username + password sign-in, for any account (offline-only accounts,
  // or Google accounts that add a password). The hash lives in its own table
  // so ordinary user queries never touch it.
  `
  CREATE TABLE logins (
    username TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE passwords (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    hash TEXT NOT NULL,
    changed_at INTEGER NOT NULL
  );
  `,
  // v3: shared playlists per linked pair, and the "watch this?" proposal that
  // must be accepted before a new video starts. Everything goes if they unlink.
  `
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX playlists_link ON playlists(link_id);
  CREATE TABLE playlist_items (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    v TEXT NOT NULL,
    title TEXT NOT NULL,
    start REAL NOT NULL,
    added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    added_at INTEGER NOT NULL,
    position REAL NOT NULL,
    UNIQUE (playlist_id, v)
  );
  CREATE INDEX playlist_items_list ON playlist_items(playlist_id, position);
  CREATE TABLE proposals (
    link_id TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    v TEXT NOT NULL,
    title TEXT NOT NULL,
    start REAL NOT NULL,
    item_id TEXT,
    by_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  // v4: chat between the pair, and what they've watched together. Both belong
  // to the link, so unlinking (or deleting either account) removes them.
  `
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    from_user TEXT REFERENCES users(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX messages_link ON messages(link_id, id);
  CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    v TEXT NOT NULL,
    title TEXT NOT NULL,
    picked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    watched_at INTEGER NOT NULL
  );
  CREATE INDEX history_link ON history(link_id, id);
  `,
];

export function openStore({ file, now = Date.now }) {
  const onDisk = file !== ':memory:';
  if (onDisk) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  // WAL + FULL sync: a crash or power cut can't corrupt or lose committed data.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const check = db.prepare('PRAGMA quick_check').get();
  if (check.quick_check !== 'ok') {
    db.close();
    throw new Error(`Database ${file} is damaged. Restore the newest file from the backups folder.`);
  }

  const stmts = new Map();
  const q = (sql) => {
    let s = stmts.get(sql);
    if (!s) stmts.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const get = (sql, ...a) => q(sql).get(...a);
  const all = (sql, ...a) => q(sql).all(...a);
  const run = (sql, ...a) => q(sql).run(...a);

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // Schema upgrades. An existing database is copied aside before changing it.
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > MIGRATIONS.length) {
    db.close();
    throw new Error('This database was made by a newer version of the app.');
  }
  if (onDisk && version > 0 && version < MIGRATIONS.length) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(file, `${file}.before-v${MIGRATIONS.length}.bak`);
  }
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(() => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  if (onDisk) fs.chmodSync(file, 0o600);

  const iso = (t) => new Date(t).toISOString();
  const validToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

  // ---------------------------------------------------------------- users

  function upsertUser({ provider, subject, name }) {
    if (provider === 'local') throw new Error('use createLocalUser for offline accounts');
    if (typeof subject !== 'string' || !subject || subject.length > 255) throw new ApiError(400, 'bad-account');
    run(
      'INSERT INTO users (id, provider, subject, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, subject) DO NOTHING',
      newId(),
      provider,
      subject,
      cleanName(name) || 'Me',
      now()
    );
    return get('SELECT id, name FROM users WHERE provider = ? AND subject = ?', provider, subject);
  }

  function setName(uid, raw) {
    const name = cleanName(raw);
    if (!name) throw new ApiError(400, 'bad-name');
    run('UPDATE users SET name = ? WHERE id = ?', name, uid);
    return name;
  }

  // ---------------------------------------------------------------- offline accounts

  async function createLocalUser({ username, password, name }) {
    const login = normalizeUsername(username);
    if (!login) throw new ApiError(400, 'bad-username');
    checkPassword(password, login);
    const display = cleanName(name) || cleanName(username) || 'Me';
    const hash = await hashPassword(password); // slow on purpose; done before the transaction
    return tx(() => {
      if (get('SELECT 1 AS x FROM logins WHERE username = ?', login)) throw new ApiError(409, 'username-taken');
      const id = newId();
      run("INSERT INTO users (id, provider, subject, name, created_at) VALUES (?, 'local', ?, ?, ?)", id, id, display, now());
      run('INSERT INTO logins (username, user_id) VALUES (?, ?)', login, id);
      run('INSERT INTO passwords (user_id, hash, changed_at) VALUES (?, ?, ?)', id, hash, now());
      return { id, name: display };
    });
  }

  // A Google account adding a username + password as a second way in.
  async function addLocalLogin(uid, username, password) {
    const login = normalizeUsername(username);
    if (!login) throw new ApiError(400, 'bad-username');
    checkPassword(password, login);
    const hash = await hashPassword(password);
    tx(() => {
      if (get('SELECT 1 AS x FROM logins WHERE username = ?', login)) throw new ApiError(409, 'username-taken');
      if (get('SELECT 1 AS x FROM logins WHERE user_id = ?', uid)) throw new ApiError(409, 'username-taken');
      run('INSERT INTO logins (username, user_id) VALUES (?, ?)', login, uid);
      run('INSERT INTO passwords (user_id, hash, changed_at) VALUES (?, ?, ?)', uid, hash, now());
    });
  }

  // Returns the user, or null. Unknown usernames take as long as wrong
  // passwords, so timing doesn't reveal which usernames exist.
  async function checkLocalLogin(username, password) {
    const login = normalizeUsername(username);
    const row =
      login &&
      get(
        'SELECT u.id, u.name, p.hash FROM logins l JOIN users u ON u.id = l.user_id JOIN passwords p ON p.user_id = u.id WHERE l.username = ?',
        login
      );
    if (!row || typeof password !== 'string') {
      await verifyDummy(typeof password === 'string' ? password : '');
      return null;
    }
    return (await verifyPassword(password, row.hash)) ? { id: row.id, name: row.name } : null;
  }

  const hasPassword = (uid) => !!get('SELECT 1 AS x FROM passwords WHERE user_id = ?', uid);
  const loginNameOf = (uid) => {
    const r = get('SELECT username FROM logins WHERE user_id = ?', uid);
    return r ? r.username : null;
  };

  // Set a password without the old one (server-side reset only).
  async function setPassword(uid, next) {
    const row = get('SELECT username FROM logins WHERE user_id = ?', uid);
    if (!row) throw new ApiError(400, 'no-password');
    checkPassword(next, row.username);
    const hash = await hashPassword(next);
    run('UPDATE passwords SET hash = ?, changed_at = ? WHERE user_id = ?', hash, now(), uid);
  }

  async function changePassword(uid, current, next) {
    const row = get('SELECT p.hash, l.username FROM passwords p JOIN logins l ON l.user_id = p.user_id WHERE p.user_id = ?', uid);
    if (!row) throw new ApiError(400, 'no-password');
    if (!(await verifyPassword(typeof current === 'string' ? current : '', row.hash))) throw new ApiError(403, 'wrong-password');
    checkPassword(next, row.username);
    const hash = await hashPassword(next);
    run('UPDATE passwords SET hash = ?, changed_at = ? WHERE user_id = ?', hash, now(), uid);
  }

  // Returns the other people affected (partner, pending requests) so they can be told.
  function deleteUser(uid) {
    return tx(() => {
      const affected = new Set();
      const link = linkOf(uid);
      if (link) {
        affected.add(link.partner.id);
        run('DELETE FROM links WHERE id = ?', link.linkId);
      }
      for (const r of all('SELECT from_user AS u FROM requests WHERE to_user = ?', uid)) affected.add(r.u);
      const out = get('SELECT to_user AS u FROM requests WHERE from_user = ?', uid);
      if (out) affected.add(out.u);
      run('DELETE FROM users WHERE id = ?', uid);
      return [...affected];
    });
  }

  // ---------------------------------------------------------------- sessions

  function createSession(uid) {
    const token = randomToken(32);
    const t = now();
    run(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256(token),
      uid,
      t,
      t,
      t + TTL.SESSION
    );
    return token;
  }

  function getSession(token) {
    if (!validToken(token)) return null;
    const hash = sha256(token);
    const row = get(
      'SELECT s.user_id, s.last_seen, s.expires_at, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      hash
    );
    if (!row) return null;
    const t = now();
    if (row.expires_at <= t) {
      run('DELETE FROM sessions WHERE token_hash = ?', hash);
      return null;
    }
    let refreshed = false;
    if (t - row.last_seen >= TTL.SESSION_TOUCH) {
      run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?', t, t + TTL.SESSION, hash);
      refreshed = true;
    }
    return { user: { id: row.user_id, name: row.name }, token, tokenHash: hash, refreshed };
  }

  const sessionExists = (hash) => !!get('SELECT 1 AS x FROM sessions WHERE token_hash = ? AND expires_at > ?', hash, now());
  const deleteSession = (token) => validToken(token) && run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  const deleteSessionHash = (hash) => run('DELETE FROM sessions WHERE token_hash = ?', hash);
  const deleteUserSessions = (uid) => run('DELETE FROM sessions WHERE user_id = ?', uid);
  const deleteOtherSessions = (uid, keepHash) =>
    run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', uid, keepHash);

  // ---------------------------------------------------------------- sign-in flows

  function createOAuthFlow(returnTo) {
    const flow = {
      state: randomToken(32),
      nonce: randomToken(32),
      verifier: randomToken(32),
      returnTo,
    };
    run(
      'INSERT INTO oauth_flows (state_hash, verifier, nonce, return_to, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256(flow.state),
      flow.verifier,
      flow.nonce,
      returnTo,
      now() + TTL.OAUTH
    );
    return flow;
  }

  // Single use: the flow is deleted whether or not it is still valid.
  function takeOAuthFlow(state) {
    if (!validToken(state)) return null;
    const hash = sha256(state);
    const row = get('SELECT verifier, nonce, return_to, expires_at FROM oauth_flows WHERE state_hash = ?', hash);
    run('DELETE FROM oauth_flows WHERE state_hash = ?', hash);
    if (!row || row.expires_at <= now()) return null;
    return { verifier: row.verifier, nonce: row.nonce, returnTo: row.return_to };
  }

  // ---------------------------------------------------------------- linking

  function linkOf(uid) {
    const row = get(
      `SELECT m.link_id AS linkId, l.created_at AS since, u.id AS pid, u.name AS pname
       FROM link_members m
       JOIN links l ON l.id = m.link_id
       JOIN link_members m2 ON m2.link_id = m.link_id AND m2.user_id <> m.user_id
       JOIN users u ON u.id = m2.user_id
       WHERE m.user_id = ?`,
      uid
    );
    return row ? { linkId: row.linkId, since: row.since, partner: { id: row.pid, name: row.pname } } : null;
  }

  const isLinked = (uid) => !!get('SELECT 1 AS x FROM link_members WHERE user_id = ?', uid);

  function createInvite(uid) {
    return tx(() => {
      if (isLinked(uid)) throw new ApiError(409, 'already-linked');
      const token = randomToken(24);
      const expiresAt = now() + TTL.INVITE;
      run('DELETE FROM invites WHERE user_id = ?', uid); // only one link out at a time
      run('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), uid, expiresAt);
      return { token, expiresAt };
    });
  }

  const revokeInvite = (uid) => run('DELETE FROM invites WHERE user_id = ?', uid);

  function inviteOf(uid) {
    const row = get('SELECT expires_at FROM invites WHERE user_id = ? AND expires_at > ?', uid, now());
    return row ? { expiresAt: row.expires_at } : null;
  }

  function findInvite(token) {
    if (!validToken(token)) return null;
    return get(
      'SELECT i.token_hash, i.user_id, u.name FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ? AND i.expires_at > ?',
      sha256(token),
      now()
    );
  }

  function peekInvite(uid, token) {
    const inv = findInvite(token);
    if (!inv) throw new ApiError(404, 'invite-invalid');
    if (inv.user_id === uid) throw new ApiError(400, 'own-invite');
    return { name: inv.name };
  }

  // Using an invite sends a request; the inviter still has to accept it.
  function redeemInvite(uid, token) {
    return tx(() => {
      const inv = findInvite(token);
      if (!inv) throw new ApiError(404, 'invite-invalid');
      if (inv.user_id === uid) throw new ApiError(400, 'own-invite');
      if (isLinked(uid)) throw new ApiError(409, 'already-linked');
      run('DELETE FROM invites WHERE token_hash = ?', inv.token_hash); // works once
      if (isLinked(inv.user_id)) throw new ApiError(409, 'partner-linked');
      const req = {
        id: newId(),
        code: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
      };
      run('DELETE FROM requests WHERE from_user = ?', uid);
      run(
        'INSERT INTO requests (id, from_user, to_user, code, expires_at) VALUES (?, ?, ?, ?, ?)',
        req.id,
        uid,
        inv.user_id,
        req.code,
        now() + TTL.REQUEST
      );
      return { name: inv.name, code: req.code, toUser: inv.user_id };
    });
  }

  function incomingRequests(uid) {
    return all(
      'SELECT r.id, r.code, u.name FROM requests r JOIN users u ON u.id = r.from_user WHERE r.to_user = ? AND r.expires_at > ? ORDER BY r.expires_at',
      uid,
      now()
    ).map((r) => ({ id: r.id, name: r.name, code: r.code }));
  }

  function outgoingRequest(uid) {
    const r = get(
      'SELECT r.code, u.name FROM requests r JOIN users u ON u.id = r.to_user WHERE r.from_user = ? AND r.expires_at > ?',
      uid,
      now()
    );
    return r ? { name: r.name, code: r.code } : null;
  }

  function acceptRequest(uid, id) {
    return tx(() => {
      const r = typeof id === 'string' && get('SELECT from_user FROM requests WHERE id = ? AND to_user = ? AND expires_at > ?', id, uid, now());
      if (!r) throw new ApiError(404, 'request-invalid');
      const other = r.from_user;
      if (isLinked(uid) || isLinked(other)) {
        run('DELETE FROM requests WHERE id = ?', id);
        throw new ApiError(409, 'already-linked');
      }
      const linkId = newId();
      run('INSERT INTO links (id, created_at) VALUES (?, ?)', linkId, now());
      run('INSERT INTO link_members (user_id, link_id) VALUES (?, ?), (?, ?)', uid, linkId, other, linkId);
      const others = all(
        'SELECT from_user AS a, to_user AS b FROM requests WHERE from_user IN (?, ?) OR to_user IN (?, ?)',
        uid,
        other,
        uid,
        other
      );
      run('DELETE FROM requests WHERE from_user IN (?, ?) OR to_user IN (?, ?)', uid, other, uid, other);
      run('DELETE FROM invites WHERE user_id IN (?, ?)', uid, other);
      const affected = new Set(others.flatMap((x) => [x.a, x.b]));
      affected.delete(uid);
      affected.delete(other);
      return { linkId, partnerId: other, affected: [...affected] };
    });
  }

  function declineRequest(uid, id) {
    if (typeof id !== 'string') return null;
    const r = get('SELECT from_user FROM requests WHERE id = ? AND to_user = ?', id, uid);
    run('DELETE FROM requests WHERE id = ? AND to_user = ?', id, uid);
    return r ? r.from_user : null;
  }

  function cancelRequest(uid) {
    const r = get('SELECT to_user FROM requests WHERE from_user = ?', uid);
    run('DELETE FROM requests WHERE from_user = ?', uid);
    return r ? r.to_user : null;
  }

  function unlink(uid) {
    return tx(() => {
      const link = linkOf(uid);
      if (!link) return null;
      run('DELETE FROM links WHERE id = ?', link.linkId);
      return { linkId: link.linkId, partnerId: link.partner.id };
    });
  }

  // ---------------------------------------------------------------- playback

  function saveRoom(linkId, { v, playing, pos }) {
    run(
      `INSERT INTO room_state (link_id, v, playing, pos, saved_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (link_id) DO UPDATE SET v = excluded.v, playing = excluded.playing, pos = excluded.pos, saved_at = excluded.saved_at`,
      linkId,
      v || null,
      playing ? 1 : 0,
      pos,
      now()
    );
  }

  function loadRoom(linkId) {
    const r = get('SELECT v, playing, pos, saved_at FROM room_state WHERE link_id = ?', linkId);
    return r ? { v: r.v, playing: !!r.playing, pos: r.pos, savedAt: r.saved_at } : null;
  }

  // ---------------------------------------------------------------- playlists
  // Every call takes the caller's user id and only touches their own pair's
  // playlists: an id from another couple simply isn't found.

  const cleanTitle = (raw) => cleanName(raw, 150);

  function linkIdOf(uid) {
    const r = get('SELECT link_id FROM link_members WHERE user_id = ?', uid);
    if (!r) throw new ApiError(403, 'not-linked');
    return r.link_id;
  }

  function ownList(uid, playlistId) {
    const linkId = linkIdOf(uid);
    const pl = typeof playlistId === 'string' && get('SELECT id, name FROM playlists WHERE id = ? AND link_id = ?', playlistId, linkId);
    if (!pl) throw new ApiError(404, 'playlist-missing');
    return { ...pl, linkId };
  }

  function listPlaylists(uid) {
    const linkId = linkIdOf(uid);
    const lists = all('SELECT id, name, created_at FROM playlists WHERE link_id = ? ORDER BY created_at, id', linkId);
    const items = all(
      `SELECT i.id, i.playlist_id, i.v, i.title, i.start, i.added_at, u.name AS added_by_name, i.added_by
       FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
       LEFT JOIN users u ON u.id = i.added_by
       WHERE p.link_id = ? ORDER BY i.position, i.added_at`,
      linkId
    );
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      items: items
        .filter((i) => i.playlist_id === l.id)
        .map((i) => ({
          id: i.id,
          v: i.v,
          title: i.title,
          start: i.start,
          addedAt: i.added_at,
          addedBy: i.added_by === uid ? 'you' : i.added_by_name || 'partner',
        })),
    }));
  }

  function createPlaylist(uid, rawName) {
    const name = cleanName(rawName);
    if (!name) throw new ApiError(400, 'bad-playlist-name');
    const linkId = linkIdOf(uid);
    return tx(() => {
      if (get('SELECT COUNT(*) AS n FROM playlists WHERE link_id = ?', linkId).n >= PLAYLIST_LIMITS.LISTS) {
        throw new ApiError(400, 'too-many-playlists');
      }
      const id = newId();
      run('INSERT INTO playlists (id, link_id, name, created_at) VALUES (?, ?, ?, ?)', id, linkId, name, now());
      return { id, name };
    });
  }

  function renamePlaylist(uid, playlistId, rawName) {
    const pl = ownList(uid, playlistId);
    const name = cleanName(rawName);
    if (!name) throw new ApiError(400, 'bad-playlist-name');
    run('UPDATE playlists SET name = ? WHERE id = ?', name, pl.id);
    return { id: pl.id, name };
  }

  function deletePlaylist(uid, playlistId) {
    const pl = ownList(uid, playlistId);
    run('DELETE FROM playlists WHERE id = ?', pl.id);
  }

  function addToPlaylist(uid, playlistId, { v, title, start }) {
    if (!isVideoId(v)) throw new ApiError(400, 'bad-video');
    const pl = ownList(uid, playlistId);
    return tx(() => {
      const existing = get('SELECT id FROM playlist_items WHERE playlist_id = ? AND v = ?', pl.id, v);
      if (existing) throw new ApiError(409, 'already-in-playlist');
      if (get('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?', pl.id).n >= PLAYLIST_LIMITS.ITEMS) {
        throw new ApiError(400, 'playlist-full');
      }
      const last = get('SELECT MAX(position) AS p FROM playlist_items WHERE playlist_id = ?', pl.id).p;
      const id = newId();
      run(
        'INSERT INTO playlist_items (id, playlist_id, v, title, start, added_by, added_at, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        pl.id,
        v,
        cleanTitle(title) || PLACEHOLDER_TITLE,
        clampPos(start),
        uid,
        now(),
        (last ?? 0) + 1
      );
      return { id };
    });
  }

  // Fill in the real title once a player has seen it. Only replaces the
  // placeholder, never a title someone already has.
  function fillTitle(uid, v, title) {
    const t = cleanTitle(title);
    if (!isVideoId(v) || !t || t === PLACEHOLDER_TITLE) return 0;
    const linkId = linkIdOf(uid);
    const lists = run(
      'UPDATE playlist_items SET title = ? WHERE v = ? AND title = ? AND playlist_id IN (SELECT id FROM playlists WHERE link_id = ?)',
      t,
      v,
      PLACEHOLDER_TITLE,
      linkId
    ).changes;
    const hist = run('UPDATE history SET title = ? WHERE v = ? AND title = ? AND link_id = ?', t, v, PLACEHOLDER_TITLE, linkId).changes;
    return lists + hist;
  }

  // Look up one of our pair's saved videos.
  function ownItem(uid, itemId) {
    const linkId = linkIdOf(uid);
    const it =
      typeof itemId === 'string' &&
      get(
        'SELECT i.id, i.v, i.title, i.start, i.playlist_id FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id WHERE i.id = ? AND p.link_id = ?',
        itemId,
        linkId
      );
    if (!it) throw new ApiError(404, 'item-missing');
    return it;
  }

  function removeFromPlaylist(uid, itemId) {
    const it = ownItem(uid, itemId);
    run('DELETE FROM playlist_items WHERE id = ?', it.id);
  }

  // Move an item up (-1) or down (+1) within its playlist.
  function moveInPlaylist(uid, itemId, dir) {
    if (dir !== -1 && dir !== 1) throw new ApiError(400, 'bad-request');
    const it = ownItem(uid, itemId);
    tx(() => {
      const ids = all('SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position, added_at', it.playlist_id).map((r) => r.id);
      const i = ids.indexOf(it.id);
      const j = i + dir;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      ids.forEach((id, k) => run('UPDATE playlist_items SET position = ? WHERE id = ?', k + 1, id));
    });
  }

  // ---------------------------------------------------------------- proposals
  // One open "watch this?" per pair. A newer suggestion replaces the old one.

  function propose(uid, { v, title, start, itemId }) {
    const linkId = linkIdOf(uid);
    let video;
    if (itemId != null) {
      const it = ownItem(uid, itemId);
      video = { v: it.v, title: it.title, start: it.start, itemId: it.id };
    } else {
      if (!isVideoId(v)) throw new ApiError(400, 'bad-video');
      video = { v, title: cleanTitle(title) || '', start: clampPos(start), itemId: null };
    }
    const p = { id: newId(), ...video, byUser: uid, createdAt: now(), expiresAt: now() + TTL.PROPOSAL };
    run(
      `INSERT INTO proposals (link_id, id, v, title, start, item_id, by_user, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (link_id) DO UPDATE SET id = excluded.id, v = excluded.v, title = excluded.title, start = excluded.start,
         item_id = excluded.item_id, by_user = excluded.by_user, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      linkId,
      p.id,
      p.v,
      p.title,
      p.start,
      p.itemId,
      uid,
      p.createdAt,
      p.expiresAt
    );
    return { linkId, proposal: p };
  }

  function proposalOf(linkId) {
    const r = get('SELECT * FROM proposals WHERE link_id = ? AND expires_at > ?', linkId, now());
    return r
      ? { id: r.id, v: r.v, title: r.title, start: r.start, itemId: r.item_id, byUser: r.by_user, createdAt: r.created_at, expiresAt: r.expires_at }
      : null;
  }

  // Accept (only by the person who didn't suggest it) or withdraw/decline (either).
  // Returns the proposal that was closed.
  function closeProposal(uid, proposalId, { accept }) {
    const linkId = linkIdOf(uid);
    return tx(() => {
      const p = proposalOf(linkId);
      if (!p || p.id !== proposalId) throw new ApiError(404, 'proposal-gone');
      if (accept && p.byUser === uid) throw new ApiError(403, 'own-proposal');
      run('DELETE FROM proposals WHERE link_id = ?', linkId);
      return { linkId, proposal: p };
    });
  }

  // ---------------------------------------------------------------- chat
  // Messages belong to the pair's link: only the two of them can read them.

  function cleanMessage(raw) {
    if (typeof raw !== 'string') return '';
    // Keep line breaks (up to 2 in a row); drop other invisible/control characters.
    const s = raw
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' ? c : ''))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return s;
  }

  function sendMessage(uid, raw) {
    const text = cleanMessage(raw);
    if (!text) throw new ApiError(400, 'empty-message');
    if ([...text].length > CHAT.MAX_CHARS) throw new ApiError(400, 'long-message');
    const linkId = linkIdOf(uid);
    return tx(() => {
      const at = now();
      const id = Number(run('INSERT INTO messages (link_id, from_user, text, sent_at) VALUES (?, ?, ?, ?)', linkId, uid, text, at).lastInsertRowid);
      // Keep only the newest CHAT.KEEP for this pair.
      run(
        'DELETE FROM messages WHERE link_id = ? AND id <= (SELECT id FROM messages WHERE link_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
        linkId,
        linkId,
        CHAT.KEEP
      );
      return { linkId, message: { id, from: uid, text, at } };
    });
  }

  // Newest page of messages, or the page before `before` (an id).
  function listMessages(uid, before) {
    const linkId = linkIdOf(uid);
    const rows = all(
      `SELECT m.id, m.from_user, m.text, m.sent_at FROM messages m
       WHERE m.link_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
      linkId,
      Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER,
      CHAT.PAGE + 1
    );
    const more = rows.length > CHAT.PAGE;
    return {
      messages: rows.slice(0, CHAT.PAGE).reverse().map((r) => ({ id: r.id, mine: r.from_user === uid, text: r.text, at: r.sent_at })),
      more,
    };
  }

  function clearChat(uid) {
    run('DELETE FROM messages WHERE link_id = ?', linkIdOf(uid));
  }

  // ---------------------------------------------------------------- history

  // Called when a suggestion is accepted and the video starts for both.
  function recordWatched(linkId, { v, title, pickedBy }) {
    if (!isVideoId(v)) return;
    tx(() => {
      // Picking the same video again right away (e.g. restarting it) isn't a new entry.
      const last = get('SELECT id, v, watched_at FROM history WHERE link_id = ? ORDER BY id DESC LIMIT 1', linkId);
      if (last && last.v === v && now() - last.watched_at < 10 * MIN) {
        run('UPDATE history SET watched_at = ? WHERE id = ?', now(), last.id);
        return;
      }
      run(
        'INSERT INTO history (link_id, v, title, picked_by, watched_at) VALUES (?, ?, ?, ?, ?)',
        linkId,
        v,
        cleanTitle(title) || PLACEHOLDER_TITLE,
        pickedBy || null,
        now()
      );
      run(
        'DELETE FROM history WHERE link_id = ? AND id <= (SELECT id FROM history WHERE link_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
        linkId,
        linkId,
        HISTORY.KEEP
      );
    });
  }

  function listHistory(uid, before) {
    const linkId = linkIdOf(uid);
    const rows = all(
      `SELECT h.id, h.v, h.title, h.picked_by, h.watched_at, u.name AS picked_name FROM history h
       LEFT JOIN users u ON u.id = h.picked_by
       WHERE h.link_id = ? AND h.id < ? ORDER BY h.id DESC LIMIT ?`,
      linkId,
      Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER,
      HISTORY.PAGE + 1
    );
    return {
      items: rows.slice(0, HISTORY.PAGE).map((r) => ({
        id: r.id,
        v: r.v,
        title: r.title,
        at: r.watched_at,
        pickedBy: r.picked_by === uid ? 'you' : r.picked_name || 'partner',
      })),
      more: rows.length > HISTORY.PAGE,
    };
  }

  function removeHistory(uid, id) {
    const linkId = linkIdOf(uid);
    if (!Number.isSafeInteger(id) || !run('DELETE FROM history WHERE id = ? AND link_id = ?', id, linkId).changes) {
      throw new ApiError(404, 'history-missing');
    }
  }

  function clearHistory(uid) {
    run('DELETE FROM history WHERE link_id = ?', linkIdOf(uid));
  }

  // ---------------------------------------------------------------- your data

  function exportUser(uid) {
    const u = get('SELECT id, provider, subject, name, created_at FROM users WHERE id = ?', uid);
    if (!u) throw new ApiError(404, 'no-account');
    const link = linkOf(uid);
    const room = link && loadRoom(link.linkId);
    return {
      exportedAt: iso(now()),
      account: {
        id: u.id,
        name: u.name,
        createdAt: iso(u.created_at),
        ...(u.provider === 'google' ? { googleAccountId: u.subject } : {}),
        username: loginNameOf(uid),
        passwordLastChanged: hasPassword(uid)
          ? iso(get('SELECT changed_at FROM passwords WHERE user_id = ?', uid).changed_at)
          : null,
      },
      partner: link ? { name: link.partner.name, linkedSince: iso(link.since) } : null,
      signedInDevices: all('SELECT created_at, last_seen FROM sessions WHERE user_id = ?', uid).map((s) => ({
        signedIn: iso(s.created_at),
        lastUsed: iso(s.last_seen),
      })),
      activeInviteLink: (() => {
        const inv = inviteOf(uid);
        return inv ? { expires: iso(inv.expiresAt) } : null;
      })(),
      linkRequests: { incoming: incomingRequests(uid).map((r) => ({ from: r.name })), outgoing: outgoingRequest(uid) },
      currentVideo: room && room.v ? { youtubeId: room.v, position: Math.floor(room.pos), playing: room.playing } : null,
      playlists: link ? listPlaylists(uid).map((l) => ({ name: l.name, videos: l.items.map((i) => ({ youtubeId: i.v, title: i.title, addedBy: i.addedBy })) })) : [],
      chat: link
        ? all('SELECT from_user, text, sent_at FROM messages WHERE link_id = ? ORDER BY id', link.linkId).map((m) => ({
            from: m.from_user === uid ? 'you' : link.partner.name,
            text: m.text,
            sent: iso(m.sent_at),
          }))
        : [],
      watchedTogether: link
        ? all('SELECT v, title, picked_by, watched_at FROM history WHERE link_id = ? ORDER BY id', link.linkId).map((h) => ({
            youtubeId: h.v,
            title: h.title,
            pickedBy: h.picked_by === uid ? 'you' : link.partner.name,
            watched: iso(h.watched_at),
          }))
        : [],
      notStored: ['email address', 'profile photo', 'contacts', 'location', 'anything you watch alone'],
    };
  }

  // ---------------------------------------------------------------- upkeep

  function purgeExpired() {
    const t = now();
    run('DELETE FROM sessions WHERE expires_at <= ?', t);
    run('DELETE FROM oauth_flows WHERE expires_at <= ?', t);
    run('DELETE FROM invites WHERE expires_at <= ?', t);
    run('DELETE FROM requests WHERE expires_at <= ?', t);
    run('DELETE FROM proposals WHERE expires_at <= ?', t);
  }

  // Consistent copy of the live database, checked, keeping the newest `keep`.
  async function backupTo(dir, keep) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `watch-${stamp}.db`);
    await sqliteBackup(db, dest);
    fs.chmodSync(dest, 0o600);
    // Make the copy one self-contained file (no -wal/-shm side files), then check it.
    const copy = new DatabaseSync(dest);
    copy.exec('PRAGMA journal_mode = DELETE');
    const ok = copy.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
    copy.close();
    const removeCopy = (f) => ['', '-wal', '-shm', '-journal'].forEach((x) => fs.rmSync(f + x, { force: true }));
    if (!ok) {
      removeCopy(dest);
      throw new Error('backup failed its integrity check');
    }
    const files = fs.readdirSync(dir).filter((f) => /^watch-.*\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) removeCopy(path.join(dir, f));
    return dest;
  }

  return {
    db,
    upsertUser,
    createLocalUser,
    checkLocalLogin,
    hasPassword,
    loginNameOf,
    changePassword,
    setPassword,
    addLocalLogin,
    setName,
    deleteUser,
    createSession,
    getSession,
    sessionExists,
    deleteSession,
    deleteSessionHash,
    deleteUserSessions,
    deleteOtherSessions,
    createOAuthFlow,
    takeOAuthFlow,
    linkOf,
    createInvite,
    revokeInvite,
    inviteOf,
    peekInvite,
    redeemInvite,
    incomingRequests,
    outgoingRequest,
    acceptRequest,
    declineRequest,
    cancelRequest,
    unlink,
    saveRoom,
    loadRoom,
    linkIdOf,
    listPlaylists,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    moveInPlaylist,
    fillTitle,
    propose,
    proposalOf,
    closeProposal,
    sendMessage,
    listMessages,
    clearChat,
    recordWatched,
    listHistory,
    removeHistory,
    clearHistory,
    exportUser,
    purgeExpired,
    backupTo,
    close: () => db.close(),
  };
}
