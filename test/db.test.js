import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApiError, TTL, cleanName, openStore, sha256 } from '../db.js';
import { restore } from '../scripts/restore.js';

function clock(t = 1_700_000_000_000) {
  const c = () => c.t;
  c.t = t;
  return c;
}

function setup() {
  const now = clock();
  const store = openStore({ file: ':memory:', now });
  const mk = (sub, name = sub) => store.upsertUser({ provider: 'google', subject: sub, name });
  return { now, store, mk };
}

// Full happy path: a invites, b uses the link, a accepts.
function link(store, a, b) {
  const { token } = store.createInvite(a.id);
  store.redeemInvite(b.id, token);
  const [req] = store.incomingRequests(a.id);
  return store.acceptRequest(a.id, req.id);
}

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiError, e.message);
    return e.code;
  }
  return null;
};

// Temp folders for on-disk tests live inside the project, not /tmp.
function tmpDir() {
  const base = path.resolve('.e2e-env/tmp-tests');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'db-'));
}

test('cleanName strips control/invisible characters and limits length', () => {
  assert.equal(cleanName('  Sam  '), 'Sam');
  assert.equal(cleanName('Sam‮evil'), 'Samevil', 'no right-to-left override tricks');
  assert.equal(cleanName('a​b'), 'ab', 'no zero-width characters');
  assert.equal(cleanName('a\n\tb'), 'a b');
  assert.equal(cleanName('<script>'), '<script>', 'kept as text; the page never renders names as HTML');
  assert.equal([...cleanName('😀'.repeat(60))].length, 40);
  assert.equal(cleanName(42), '');
  assert.equal(cleanName('   '), '');
});

test('users: same Google account always maps to the same user', () => {
  const { mk, store } = setup();
  const a1 = mk('g-123', 'Alex');
  const a2 = mk('g-123', 'Different Name');
  assert.equal(a1.id, a2.id);
  assert.equal(a2.name, 'Alex', 'signing in again does not overwrite a chosen name');
  const b = mk('g-456', '');
  assert.notEqual(b.id, a1.id);
  assert.equal(b.name, 'Me', 'empty names get a placeholder');
  assert.equal(code(() => store.upsertUser({ provider: 'google', subject: '', name: 'x' })), 'bad-account');
});

test('nothing searchable is stored: no email column anywhere', () => {
  const { store } = setup();
  const cols = store.db
    .prepare("SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'")
    .all()
    .map((r) => `${r.t}.${r.c}`);
  assert.ok(!cols.some((c) => /mail|phone|photo|picture|avatar/i.test(c)), cols.join(', '));
});

test('sessions: token only stored hashed, expire, refresh on use', () => {
  const { store, mk, now } = setup();
  const a = mk('a');
  const token = store.createSession(a.id);
  const row = store.db.prepare('SELECT token_hash FROM sessions').get();
  assert.equal(row.token_hash, sha256(token));
  assert.notEqual(row.token_hash, token);
  assert.equal(store.getSession(token).user.id, a.id);
  assert.equal(store.getSession('x'.repeat(43)), null, 'unknown token');
  assert.equal(store.getSession('bad token!'), null, 'malformed token');
  assert.equal(store.getSession(null), null);

  now.t += TTL.SESSION - 1000;
  const s = store.getSession(token);
  assert.ok(s && s.refreshed, 'used before expiry: extended');
  now.t += TTL.SESSION - 1000;
  assert.ok(store.getSession(token), 'still valid thanks to refresh');
  now.t += TTL.SESSION + 1;
  assert.equal(store.getSession(token), null, 'expired after 30 idle days');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'expired session removed');
});

test('sessions: sign out one / all devices', () => {
  const { store, mk } = setup();
  const a = mk('a');
  const t1 = store.createSession(a.id);
  const t2 = store.createSession(a.id);
  store.deleteSession(t1);
  assert.equal(store.getSession(t1), null);
  assert.ok(store.getSession(t2));
  store.createSession(a.id);
  store.deleteUserSessions(a.id);
  assert.equal(store.getSession(t2), null);
});

test('sign-in flows are single use and expire', () => {
  const { store, now } = setup();
  const f = store.createOAuthFlow('/account');
  const got = store.takeOAuthFlow(f.state);
  assert.deepEqual(got, { verifier: f.verifier, nonce: f.nonce, returnTo: '/account' });
  assert.equal(store.takeOAuthFlow(f.state), null, 'replay rejected');
  const g = store.createOAuthFlow('/');
  now.t += TTL.OAUTH + 1;
  assert.equal(store.takeOAuthFlow(g.state), null, 'expired');
  assert.equal(store.takeOAuthFlow('nope'), null);
});

test('linking: invite -> request -> accept links exactly these two', () => {
  const { store, mk } = setup();
  const a = mk('a', 'Alex');
  const b = mk('b', 'Bo');
  const { token } = store.createInvite(a.id);
  assert.deepEqual(store.peekInvite(b.id, token), { name: 'Alex' });
  const r = store.redeemInvite(b.id, token);
  assert.equal(r.name, 'Alex');
  assert.match(r.code, /^\d{4}$/);
  assert.equal(store.linkOf(b.id), null, 'not linked until Alex accepts');
  assert.deepEqual(store.outgoingRequest(b.id), { name: 'Alex', code: r.code });
  const [req] = store.incomingRequests(a.id);
  assert.equal(req.name, 'Bo');
  assert.equal(req.code, r.code, 'both see the same confirmation code');
  store.acceptRequest(a.id, req.id);
  assert.equal(store.linkOf(a.id).partner.name, 'Bo');
  assert.equal(store.linkOf(b.id).partner.name, 'Alex');
  assert.equal(store.linkOf(a.id).linkId, store.linkOf(b.id).linkId);
  assert.deepEqual(store.incomingRequests(a.id), []);
  assert.equal(store.outgoingRequest(b.id), null);
});

test('invites: single use, expire, revocable, only one at a time, stored hashed', () => {
  const { store, mk, now } = setup();
  const a = mk('a');
  const b = mk('b');
  const c = mk('c');
  const first = store.createInvite(a.id);
  const second = store.createInvite(a.id);
  assert.equal(code(() => store.peekInvite(b.id, first.token)), 'invite-invalid', 'making a new link cancels the old one');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 1);
  assert.equal(store.db.prepare('SELECT token_hash FROM invites').get().token_hash, sha256(second.token));

  store.redeemInvite(b.id, second.token);
  assert.equal(code(() => store.redeemInvite(c.id, second.token)), 'invite-invalid', 'used once only');

  const third = store.createInvite(a.id);
  store.revokeInvite(a.id);
  assert.equal(code(() => store.redeemInvite(c.id, third.token)), 'invite-invalid', 'revoked');

  const fourth = store.createInvite(a.id);
  now.t += TTL.INVITE + 1;
  assert.equal(code(() => store.redeemInvite(c.id, fourth.token)), 'invite-invalid', 'expired');
  assert.equal(store.inviteOf(a.id), null);
});

test('invites: cannot use your own, garbage tokens rejected', () => {
  const { store, mk } = setup();
  const a = mk('a');
  const { token } = store.createInvite(a.id);
  assert.equal(code(() => store.redeemInvite(a.id, token)), 'own-invite');
  assert.equal(code(() => store.peekInvite(a.id, token)), 'own-invite');
  for (const bad of [null, '', 'x', 42, {}, 'a'.repeat(500), "' OR 1=1 --"]) {
    assert.equal(code(() => store.redeemInvite(mk('z').id, bad)), 'invite-invalid', String(bad));
  }
});

test('requests: decline, cancel, expiry, only the invited person can accept', () => {
  const { store, mk, now } = setup();
  const a = mk('a');
  const b = mk('b');
  const c = mk('c');
  let t = store.createInvite(a.id).token;
  store.redeemInvite(b.id, t);
  let [req] = store.incomingRequests(a.id);
  assert.equal(code(() => store.acceptRequest(c.id, req.id)), 'request-invalid', 'someone else cannot accept it');
  assert.equal(code(() => store.acceptRequest(b.id, req.id)), 'request-invalid', 'the requester cannot accept it');
  assert.equal(store.declineRequest(a.id, req.id), b.id);
  assert.deepEqual(store.incomingRequests(a.id), []);
  assert.equal(code(() => store.acceptRequest(a.id, req.id)), 'request-invalid');

  t = store.createInvite(a.id).token;
  store.redeemInvite(b.id, t);
  assert.equal(store.cancelRequest(b.id), a.id);
  assert.deepEqual(store.incomingRequests(a.id), []);

  t = store.createInvite(a.id).token;
  store.redeemInvite(b.id, t);
  [req] = store.incomingRequests(a.id);
  now.t += TTL.REQUEST + 1;
  assert.deepEqual(store.incomingRequests(a.id), []);
  assert.equal(code(() => store.acceptRequest(a.id, req.id)), 'request-invalid');
  assert.equal(code(() => store.acceptRequest(a.id, 42)), 'request-invalid');
});

test('one partner each: nobody can be in two links', () => {
  const { store, mk } = setup();
  const a = mk('a');
  const b = mk('b');
  const c = mk('c');
  link(store, a, b);
  assert.equal(code(() => store.createInvite(a.id)), 'already-linked');
  // c gets an old-style chance: c invites, a (linked) tries to use it.
  const { token } = store.createInvite(c.id);
  assert.equal(code(() => store.redeemInvite(a.id, token)), 'already-linked');
  // The database itself refuses a second membership, even if the code had a bug.
  store.db.prepare("INSERT INTO links (id, created_at) VALUES ('other', 0)").run();
  assert.throws(() => store.db.prepare("INSERT INTO link_members (user_id, link_id) VALUES (?, 'other')").run(a.id), /UNIQUE|PRIMARY/);
});

test('racing requests: accepting one cancels the others; stale ones fail', () => {
  const { store, mk } = setup();
  const a = mk('a');
  const b = mk('b');
  const c = mk('c');
  store.redeemInvite(b.id, store.createInvite(a.id).token);
  store.redeemInvite(c.id, store.createInvite(a.id).token);
  const reqs = store.incomingRequests(a.id);
  assert.equal(reqs.length, 2);
  const r = store.acceptRequest(a.id, reqs.find((x) => x.name === 'b').id);
  assert.deepEqual(r.affected, [c.id], 'c is told their request is gone');
  assert.deepEqual(store.incomingRequests(a.id), []);
  assert.equal(store.outgoingRequest(c.id), null);
  assert.equal(code(() => store.acceptRequest(a.id, reqs.find((x) => x.name === 'c').id)), 'request-invalid');
});

test('invite from someone who linked with another person in the meantime', () => {
  const { store, mk } = setup();
  const a = mk('a');
  const b = mk('b');
  const c = mk('c');
  const { token } = store.createInvite(a.id);
  // a links with b through b's invite instead
  store.redeemInvite(a.id, store.createInvite(b.id).token);
  store.acceptRequest(b.id, store.incomingRequests(b.id)[0].id);
  assert.equal(code(() => store.redeemInvite(c.id, token)), 'invite-invalid', 'linking cancelled a\'s open invite');
});

test('unlink: both sides free again, room state gone', () => {
  const { store, mk } = setup();
  const a = mk('a');
  const b = mk('b');
  const { linkId } = link(store, a, b);
  store.saveRoom(linkId, { v: 'dQw4w9WgXcQ', playing: true, pos: 12 });
  const r = store.unlink(b.id);
  assert.deepEqual(r, { linkId, partnerId: a.id });
  assert.equal(store.linkOf(a.id), null);
  assert.equal(store.linkOf(b.id), null);
  assert.equal(store.loadRoom(linkId), null);
  assert.equal(store.unlink(b.id), null, 'second unlink is a no-op');
  link(store, a, b); // can link again later
  assert.ok(store.linkOf(a.id));
});

test('room state persists', () => {
  const { store, mk } = setup();
  const a = mk('a');
  const b = mk('b');
  const { linkId } = link(store, a, b);
  assert.equal(store.loadRoom(linkId), null);
  store.saveRoom(linkId, { v: 'dQw4w9WgXcQ', playing: true, pos: 12.5 });
  store.saveRoom(linkId, { v: 'dQw4w9WgXcQ', playing: false, pos: 20 });
  assert.deepEqual({ ...store.loadRoom(linkId), savedAt: 0 }, { v: 'dQw4w9WgXcQ', playing: false, pos: 20, savedAt: 0 });
});

test('delete account removes everything about the person', () => {
  const { store, mk } = setup();
  const a = mk('a', 'Alex');
  const b = mk('b', 'Bo');
  const c = mk('c', 'Cy');
  const { linkId } = link(store, a, b);
  store.saveRoom(linkId, { v: 'dQw4w9WgXcQ', playing: true, pos: 1 });
  store.createSession(b.id);
  store.createSession(a.id);
  store.createInvite(c.id); // unrelated: must survive
  const affected = store.deleteUser(b.id);
  assert.deepEqual(affected, [a.id]);
  assert.ok(store.inviteOf(c.id), "other people's data untouched");
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(a.id).n, 1);
  assert.equal(store.linkOf(a.id), null, 'partner is unlinked');
  assert.equal(store.loadRoom(linkId), null);
  for (const t of ['sessions', 'invites', 'requests', 'link_members']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'requests' ? 'from_user = ? OR to_user = ?' : 'user_id = ?'}`).get(...(t === 'requests' ? [b.id, b.id] : [b.id])).n, 0, t);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(b.id).n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM links').get().n, 0);
  // Signing in again with the same Google account starts fresh.
  const again = mk('b', 'Bo again');
  assert.notEqual(again.id, b.id);
  assert.equal(again.name, 'Bo again');
});

test('delete account tells people with pending requests', () => {
  const { store, mk } = setup();
  const a = mk('a');
  const b = mk('b');
  store.redeemInvite(b.id, store.createInvite(a.id).token);
  assert.deepEqual(store.deleteUser(a.id), [b.id]);
  assert.equal(store.outgoingRequest(b.id), null);
});

test('export contains the person\'s data and nothing about tokens', () => {
  const { store, mk } = setup();
  const a = mk('g-1', 'Alex');
  const b = mk('g-2', 'Bo');
  const token = store.createSession(a.id);
  const { linkId } = link(store, a, b);
  store.saveRoom(linkId, { v: 'dQw4w9WgXcQ', playing: false, pos: 42.7 });
  const out = store.exportUser(a.id);
  assert.equal(out.account.name, 'Alex');
  assert.equal(out.account.googleAccountId, 'g-1');
  assert.equal(out.account.username, null, 'Google-only account has no username');
  assert.equal(out.partner.name, 'Bo');
  assert.equal(out.signedInDevices.length, 1);
  assert.deepEqual(out.currentVideo, { youtubeId: 'dQw4w9WgXcQ', position: 42, playing: false });
  const text = JSON.stringify(out);
  assert.ok(!text.includes(token) && !text.includes(sha256(token)), 'no session secrets');
  assert.ok(!text.includes('g-2'), 'nothing identifying about the partner beyond their name');
});

test('purgeExpired clears old rows', () => {
  const { store, mk, now } = setup();
  const a = mk('a');
  store.createSession(a.id);
  store.createInvite(a.id);
  store.createOAuthFlow('/');
  now.t += TTL.SESSION + 1;
  store.purgeExpired();
  for (const t of ['sessions', 'invites', 'oauth_flows']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
});

test('on disk: data survives reopening, file is private, backups are checked and rotated', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'watch.db');
  const now = clock();
  let store = openStore({ file, now });
  const a = store.upsertUser({ provider: 'google', subject: 'a', name: 'Alex' });
  const b = store.upsertUser({ provider: 'google', subject: 'b', name: 'Bo' });
  const { linkId } = link(store, a, b);
  store.saveRoom(linkId, { v: 'dQw4w9WgXcQ', playing: true, pos: 99 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only the server can read it');
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL');

  const backups = path.join(dir, 'backups');
  for (let i = 0; i < 4; i++) {
    now.t += 1000;
    await store.backupTo(backups, 3);
  }
  const files = fs.readdirSync(backups).sort();
  assert.equal(files.length, 3, `keeps the newest 3 as single files: ${files}`);
  assert.ok(files.every((f) => f.endsWith('.db')));
  const copy = new DatabaseSync(path.join(backups, files.at(-1)), { readOnly: true });
  assert.equal(copy.prepare('SELECT name FROM users WHERE id = ?').get(a.id).name, 'Alex');
  copy.close();
  store.close();

  // Simulate a crash: reopen without a clean shutdown in between.
  store = openStore({ file, now });
  assert.equal(store.linkOf(a.id).partner.name, 'Bo');
  assert.equal(store.loadRoom(linkId).pos, 99);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('on disk: a damaged database refuses to start instead of losing data', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'watch.db');
  const store = openStore({ file, now: clock() });
  for (let i = 0; i < 200; i++) store.upsertUser({ provider: 'google', subject: `u${i}`, name: 'x'.repeat(30) });
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.close();
  const buf = fs.readFileSync(file);
  buf.fill(0x5a, 4096, buf.length - 100); // scribble over most pages
  fs.writeFileSync(file, buf);
  assert.throws(() => openStore({ file, now: clock() }), /damaged|malformed|corrupt|not a database/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('on disk: refuses a database from a newer app version', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'watch.db');
  openStore({ file, now: clock() }).close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openStore({ file, now: clock() }), /newer version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore: puts a backup back, keeps the replaced database, refuses damaged backups', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'watch.db');
  const now = clock();
  let store = openStore({ file, now });
  const a = store.upsertUser({ provider: 'google', subject: 'a', name: 'Before' });
  const backup = await store.backupTo(path.join(dir, 'backups'), 5);
  store.setName(a.id, 'After'); // a change made after the backup
  store.upsertUser({ provider: 'google', subject: 'z', name: 'Later person' });
  store.close();

  const r = restore(backup, dir);
  assert.ok(fs.existsSync(r.previousKeptAt));
  store = openStore({ file, now });
  assert.equal(store.db.prepare('SELECT name FROM users WHERE id = ?').get(a.id).name, 'Before');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  store.close();
  // The replaced database still has the newer data, so the restore can be undone.
  const prev = new DatabaseSync(r.previousKeptAt, { readOnly: true });
  assert.equal(prev.prepare('SELECT name FROM users WHERE id = ?').get(a.id).name, 'After');
  prev.close();

  const bad = path.join(dir, 'bad.db');
  fs.writeFileSync(bad, 'not a database at all');
  assert.throws(() => restore(bad, dir), /damaged/);
  store = openStore({ file, now });
  assert.equal(store.db.prepare('SELECT name FROM users').get().name, 'Before', 'nothing changed by a failed restore');
  store.close();
  assert.throws(() => restore(path.join(dir, 'nope.db'), dir), /No such backup/);
  fs.rmSync(dir, { recursive: true, force: true });
});
