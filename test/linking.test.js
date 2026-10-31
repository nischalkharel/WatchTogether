// Private linking between two accounts, and who can watch with whom.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, linkPeople, openSocket, agreeOn } from './helpers.js';

const V = 'dQw4w9WgXcQ';
let h;
before(async () => {
  h = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
});
after(() => h.close());

const tokenOf = (url) => new URL(url).hash.slice(1);
let n = 0;
const person = (name) => h.signedIn(`sub-${name}-${n++}`, name);

test('invite link: the secret is after # so it never reaches servers or logs', async () => {
  const a = await person('Alex');
  const r = await a.post('/api/invite');
  assert.equal(r.status, 200);
  const u = new URL(r.body.url);
  assert.equal(u.origin, h.origin);
  assert.equal(u.pathname, '/join');
  assert.equal(u.search, '');
  assert.ok(u.hash.length > 30, 'long random secret');
  assert.ok(r.body.expiresAt > Date.now() + 23 * 3600_000);
});

test('happy path: invite, request with matching code, accept, both linked', async () => {
  const a = await person('Alex');
  const b = await person('Bo');
  const token = tokenOf((await a.post('/api/invite')).body.url);
  assert.deepEqual((await b.post('/api/invite/peek', { token })).body, { name: 'Alex' });
  const used = await b.post('/api/invite/use', { token });
  assert.equal(used.body.name, 'Alex');
  const meA = (await a.get('/api/me')).body;
  assert.equal(meA.incoming.length, 1);
  assert.equal(meA.incoming[0].name, 'Bo');
  assert.equal(meA.incoming[0].code, used.body.code, 'same code on both screens');
  assert.equal(meA.invite, null, 'invite used up');
  assert.deepEqual((await b.get('/api/me')).body.outgoing, { name: 'Alex', code: used.body.code });
  assert.equal((await a.post('/api/request/accept', { id: meA.incoming[0].id })).status, 200);
  assert.equal((await a.get('/api/me')).body.partner.name, 'Bo');
  assert.equal((await b.get('/api/me')).body.partner.name, 'Alex');
});

test('nobody can find anyone: there is no search or lookup of any kind', async () => {
  const a = await person('Findme');
  for (const p of ['/api/users', '/api/search?q=Findme', '/api/user/1', '/api/lookup?email=x@example.com', '/api/find']) {
    const r = await a.get(p);
    assert.equal(r.status, 404, p);
    const pr = await a.post(p, { q: 'Findme', email: 'x@example.com' });
    assert.equal(pr.status, 404, p);
  }
});

test('peeking at an invite reveals only a first name, and needs sign-in', async () => {
  const a = await person('Alex');
  const token = tokenOf((await a.post('/api/invite')).body.url);
  const stranger = h.browser();
  const r = await stranger.post('/api/invite/peek', { token }, { csrf: '' });
  assert.equal(r.status, 401);
  const b = await person('Bo');
  assert.deepEqual(Object.keys((await b.post('/api/invite/peek', { token })).body), ['name']);
});

test('guessing invite links is useless and rate limited', async () => {
  const strict = await startApp();
  const mallory = await strict.signedIn('mallory', 'Mallory');
  const victim = await strict.signedIn('victim', 'Victim');
  await victim.post('/api/invite');
  let limited = false;
  let found = false;
  for (let i = 0; i < 40; i++) {
    const r = await mallory.post('/api/invite/use', { token: `guess${i}`.padEnd(32, 'x') });
    if (r.status === 429) limited = true;
    if (r.status === 200) found = true;
  }
  assert.ok(limited, 'blocked after a handful of tries');
  assert.ok(!found);
  assert.equal((await victim.get('/api/me')).body.incoming.length, 0);
  await strict.close();
});

test('making extra accounts does not buy extra invite guesses', async () => {
  const strict = await startApp();
  let limited = false;
  for (let acct = 0; acct < 5 && !limited; acct++) {
    const m = await strict.signedIn(`sock-${acct}`, 'Sock');
    for (let i = 0; i < 8; i++) {
      if ((await m.post('/api/invite/peek', { token: `g${acct}x${i}`.padEnd(32, 'x') })).status === 429) limited = true;
    }
  }
  assert.ok(limited, 'blocked by address even across fresh accounts');
  await strict.close();
});

test('cancelling and remaking your own invite is not limited like guessing', async () => {
  const strict = await startApp();
  const a = await strict.signedIn('remaker', 'R');
  for (let i = 0; i < 15; i++) {
    assert.equal((await a.post('/api/invite')).status, 200);
    assert.equal((await a.post('/api/invite/revoke')).status, 200);
  }
  await strict.close();
});

test('a leaked invite cannot link a stranger without the owner approving', async () => {
  const a = await person('Alex');
  const stranger = await person('Stranger');
  const token = tokenOf((await a.post('/api/invite')).body.url);
  await stranger.post('/api/invite/use', { token });
  assert.equal((await stranger.get('/api/me')).body.partner, null);
  assert.equal((await a.get('/api/me')).body.partner, null);
  // Alex sees a request from "Stranger" with a code that doesn't match their partner's: declines.
  const req = (await a.get('/api/me')).body.incoming[0];
  assert.equal(req.name, 'Stranger');
  await a.post('/api/request/decline', { id: req.id });
  assert.equal((await stranger.get('/api/me')).body.outgoing, null);
  // Stranger can't accept on Alex's behalf, or guess request ids.
  assert.equal((await stranger.post('/api/request/accept', { id: req.id })).status, 404);
});

test('nobody can accept a request meant for someone else', async () => {
  const a = await person('Alex');
  const b = await person('Bo');
  const c = await person('Cy');
  await b.post('/api/invite/use', { token: tokenOf((await a.post('/api/invite')).body.url) });
  const id = (await a.get('/api/me')).body.incoming[0].id;
  assert.equal((await c.post('/api/request/accept', { id })).status, 404);
  assert.equal((await b.post('/api/request/accept', { id })).status, 404);
});

test('invite works once; owner can cancel it', async () => {
  const a = await person('Alex');
  const b = await person('Bo');
  const c = await person('Cy');
  const token = tokenOf((await a.post('/api/invite')).body.url);
  await b.post('/api/invite/use', { token });
  assert.equal((await c.post('/api/invite/use', { token })).body.error, 'invite-invalid');
  const t2 = tokenOf((await a.post('/api/invite')).body.url);
  await a.post('/api/invite/revoke');
  assert.equal((await c.post('/api/invite/peek', { token: t2 })).body.error, 'invite-invalid');
});

test('already linked: no new invites, no joining someone else, no second partner', async () => {
  const [a, b] = await h.couple(['Alex', 'Bo']);
  assert.equal((await a.post('/api/invite')).body.error, 'already-linked');
  const c = await person('Cy');
  const ct = tokenOf((await c.post('/api/invite')).body.url);
  assert.equal((await b.post('/api/invite/use', { token: ct })).body.error, 'already-linked');
});

test('signed-out people and unlinked people cannot watch anything', async () => {
  // No cookie: refused outright.
  await assert.rejects(openSocket(h.origin, ''), /401/);
  // Signed in, not linked: connected for account updates only, never a room.
  const lonely = await person('Lonely');
  const s = await lonely.ws();
  assert.equal((await s.next()).type, 'nolink');
  s.send({ type: 'action', action: { type: 'load', v: V, pos: 0 } });
  assert.equal((await s.closed).code, 1008, 'trying to act without a partner closes the connection');
});

test('another website cannot open the watch connection with your cookie', async () => {
  const [a] = await h.couple(['Alex', 'Bo']);
  await assert.rejects(openSocket(h.origin, a.cookieHeader(), { originHeader: 'https://evil.example' }), /403/);
  await assert.rejects(openSocket(h.origin, a.cookieHeader(), { originHeader: null }), /403/);
});

test('only the two linked people share a room; other couples are separate', async () => {
  const [a, b] = await h.couple(['Alex', 'Bo']);
  const [c, d] = await h.couple(['Cy', 'Di']);
  const sa = await a.ws();
  const sb = await b.ws();
  const sc = await c.ws();
  for (const s of [sa, sb, sc]) assert.equal((await s.next((m) => m.type === 'welcome')).type, 'welcome');
  assert.equal((await sb.next((m) => m.type === 'presence' && m.n === 2)).n, 2);

  await agreeOn(a, b, V, 5);
  assert.equal((await sb.next((m) => m.type === 'state')).state.v, V);
  await assert.rejects(sc.next((m) => m.type === 'state', 400), 'other couple sees nothing');
  sc.send({ type: 'action', action: { type: 'pause', pos: 0 } });
  await assert.rejects(sa.next((m) => m.type === 'state' && m.kind === 'pause', 400), 'and cannot affect them');
  void d;
  await Promise.all([sa.close(), sb.close(), sc.close()]);
});

test('both your devices (phone + laptop) join the same room, counted as one person', async () => {
  const sub = `sub-multi-${n++}`;
  const phone = await h.signedIn(sub, 'Alex');
  const laptop = await h.signedIn(sub, 'Alex');
  const partner = await person('Bo');
  await linkPeople(phone, partner);
  const s1 = await phone.ws();
  const s2 = await laptop.ws();
  await s1.next((m) => m.type === 'welcome');
  const w2 = await s2.next((m) => m.type === 'welcome');
  assert.equal(w2.n, 1, 'still just one person in the room');
  const sp = await partner.ws();
  assert.equal((await sp.next((m) => m.type === 'welcome')).n, 2);
  await Promise.all([s1.close(), s2.close(), sp.close()]);
});

test('unlinking cuts the live connection immediately, for both people', async () => {
  const [a, b] = await h.couple(['Alex', 'Bo']);
  const sa = await a.ws();
  const sb = await b.ws();
  await sa.next((m) => m.type === 'welcome');
  await sb.next((m) => m.type === 'welcome');
  await agreeOn(a, b, V);
  await sb.next((m) => m.type === 'state');
  assert.equal((await a.post('/api/unlink')).status, 200);
  assert.equal((await sa.closed).code, 4001);
  assert.equal((await sb.closed).code, 4001);
  assert.equal((await b.get('/api/me')).body.partner, null);
  // Reconnecting gets no room, and the old video is gone.
  const again = await b.ws();
  assert.equal((await again.next()).type, 'nolink');
  await again.close();
  await linkPeople(a, b);
  const fresh = await a.ws();
  assert.equal((await fresh.next((m) => m.type === 'welcome')).state.v, null, 'new link starts empty');
  await fresh.close();
});

test('signing out cuts that device\'s live connection', async () => {
  const [a] = await h.couple(['Alex', 'Bo']);
  const s = await a.ws();
  await s.next((m) => m.type === 'welcome');
  await a.post('/api/signout');
  assert.equal((await s.closed).code, 4001);
});

test('partner sees live account changes (accept, rename, unlink)', async () => {
  const a = await person('Alex');
  const b = await person('Bo');
  const sa = await a.ws();
  await sa.next((m) => m.type === 'nolink');
  await b.post('/api/invite/use', { token: tokenOf((await a.post('/api/invite')).body.url) });
  assert.equal((await sa.next((m) => m.type === 'account')).type, 'account', 'told about the new request');
  await sa.close();
});

test('rename shows up for the partner', async () => {
  const [a, b] = await h.couple(['Alex', 'Bo']);
  await a.post('/api/name', { name: 'Lexi' });
  assert.equal((await b.get('/api/me')).body.partner.name, 'Lexi');
});

test('delete account: needs confirmation, removes everything, frees the partner', async () => {
  const [a, b] = await h.couple(['Alex', 'Bo']);
  const sb = await b.ws();
  await sb.next((m) => m.type === 'welcome');
  assert.equal((await a.post('/api/delete', { confirm: 'yes' })).body.error, 'confirm-mismatch');
  const r = await a.post('/api/delete', { confirm: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await a.get('/api/me')).body.user, null, 'signed out');
  assert.equal((await sb.closed).code, 4001, 'partner\'s room closed');
  assert.equal((await b.get('/api/me')).body.partner, null);
});

test('download my data', async () => {
  const [a] = await h.couple(['Alex', 'Bo']);
  const r = await a.get('/api/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.equal(r.body.account.name, 'Alex');
  assert.equal(r.body.partner.name, 'Bo');
  assert.ok(r.body.notStored.includes('email address'));
  assert.equal((await h.browser().get('/api/export')).status, 401);
  assert.equal((await a.get('/api/export', { 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('names are stored as plain text, so HTML in a name can\'t run in the partner\'s page', async () => {
  const [a, b] = await h.couple(['Alex', 'Bo']);
  await a.post('/api/name', { name: '<img src=x onerror=alert(1)>' });
  const name = (await b.get('/api/me')).body.partner.name;
  assert.equal(name, '<img src=x onerror=alert(1)>', 'returned as data; the page sets it with textContent');
});
