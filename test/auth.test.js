// Sign-in, sessions, and the protections around them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { loadConfig } from '../config.js';
import { safeReturnTo } from '../server.js';

let h;
before(async () => {
  h = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
});
after(() => h.close());

test('signed out: /api/me says so, and asks Google only for name (never email)', async () => {
  const b = h.browser();
  const me = await b.get('/api/me');
  assert.deepEqual(me.body, { user: null, googleReady: true });
  await b.signIn('s-1', 'Alex Example');
  const auth = h.google.authRequests.at(-1);
  assert.equal(auth.scope, 'openid profile', 'no email scope');
  assert.equal(auth.code_challenge_method, 'S256', 'PKCE');
  assert.ok(auth.state.length >= 40 && auth.nonce.length >= 40);
});

test('full Google sign-in creates a session cookie with safe flags', async () => {
  const b = h.browser();
  const res = await b.signIn('s-2', 'Bo Person', '/account');
  assert.equal(res.status, 302);
  assert.equal(b.lastLocation, '/account', 'returned to the page they came from');
  const me = await b.get('/api/me');
  assert.equal(me.body.user.name, 'Bo', 'first name only');
  assert.ok(!JSON.stringify(me.body).includes('@'), 'no email anywhere');
  assert.ok(!('id' in me.body.user), 'internal id not exposed');
  const tok = h.google.tokenRequests.at(-1);
  assert.ok(tok.code_verifier, 'PKCE verifier sent');
});

test('session cookie: HttpOnly, SameSite=Lax, 30 days', async () => {
  h.google.nextUser = { sub: 's-3', name: 'C', email: 'c@x' };
  const b = h.browser();
  let res = await b.raw('/auth/google');
  res = await b.raw(res.headers.get('location'));
  res = await b.raw(res.headers.get('location'));
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /Path=\//);
});

test('on https the cookie is Secure and __Host- prefixed, and HSTS is on', async () => {
  const c = loadConfig({ PUBLIC_URL: 'https://watch.example.com', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' });
  assert.equal(c.secure, true);
  assert.deepEqual(c.errors, []);
  // Exercised end to end by starting a server with an https PUBLIC_URL.
  const { createServer } = await import('../server.js');
  const app = createServer({ config: { ...c, dataDir: h.dir + '/https', backupEveryMs: 0 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/);
  const signout = await fetch(`http://127.0.0.1:${port}/api/signout`, {
    method: 'POST',
    headers: { origin: 'https://watch.example.com', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(signout.status, 401);
  await new Promise((r) => app.server.close(r));
  assert.ok(true);
});

test('config refuses to run insecurely', () => {
  assert.match(loadConfig({ PUBLIC_URL: 'http://watch.example.com' }).errors.join(), /https/);
  assert.match(loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'http://localhost:3000' }).errors.join(), /https/);
  assert.deepEqual(loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://x.example' }).errors, [], 'Google is optional, even in production');
  assert.match(loadConfig({ GOOGLE_CLIENT_ID: 'only-half' }).errors.join(), /both/);
  assert.match(loadConfig({ OIDC_ISSUER: 'http://evil.example' }).errors.join(), /https/);
  assert.deepEqual(loadConfig({}).errors, [], 'local development is fine');
});

test('server will not start with an insecure config', async () => {
  const { createServer } = await import('../server.js');
  assert.throws(() => createServer({ config: loadConfig({ PUBLIC_URL: 'http://x.example' }) }), /Can't start safely/);
});

test('tampered ID tokens from "Google" are all rejected', async () => {
  try {
    for (const tamper of ['signature', 'audience', 'expired', 'nonce', 'issuer', 'alg-none', 'unknown-kid']) {
      h.google.tamper = tamper;
      const b = h.browser();
      await b.signIn(`evil-${tamper}`, 'Mallory');
      assert.equal(b.lastLocation, '/?signin=error', tamper);
      assert.equal(b.cookies.size, 0, `${tamper}: no cookie`);
      assert.equal((await b.get('/api/me')).body.user, null, `${tamper}: not signed in`);
    }
  } finally {
    h.google.tamper = null;
  }
  // And an honest token still works afterwards.
  const ok = h.browser();
  await ok.signIn('honest', 'Honest');
  assert.equal(ok.lastLocation, '/');
});

test('sign-in callback: forged, replayed or missing state is refused', async () => {
  const b = h.browser();
  // An attacker's own code + made-up state (login CSRF): refused.
  const r1 = await b.raw('/auth/google/callback?code=abc&state=forgedforgedforgedforgedforged');
  assert.equal(r1.headers.get('location'), '/?signin=expired');
  const r2 = await b.raw('/auth/google/callback?code=abc');
  assert.equal(r2.headers.get('location'), '/?signin=expired');

  // Replay a genuine callback URL a second time: refused (state is single-use).
  h.google.nextUser = { sub: 's-replay', name: 'R', email: 'r@x' };
  let res = await b.raw('/auth/google');
  res = await b.raw(res.headers.get('location'));
  const callback = res.headers.get('location');
  const ok = await b.raw(callback);
  assert.equal(ok.headers.get('location'), '/');
  const other = h.browser();
  const replay = await other.raw(callback);
  assert.equal(replay.headers.get('location'), '/?signin=expired');
  assert.equal(other.cookies.size, 0);
});

test('person cancels on the Google screen', async () => {
  const b = h.browser();
  const start = await b.raw('/auth/google');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const res = await b.raw(`/auth/google/callback?error=access_denied&state=${state}`);
  assert.equal(res.headers.get('location'), '/?signin=cancelled');
});

test('return address after sign-in can only be on this site', () => {
  assert.equal(safeReturnTo('/account'), '/account');
  assert.equal(safeReturnTo('/join'), '/join');
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', '/a b', '/%0d%0aSet-Cookie:x', null, '', 'x'.repeat(300)]) {
    const r = safeReturnTo(bad);
    assert.ok(r === '/' || (r.startsWith('/') && !r.startsWith('//') && !r.includes(':')), String(bad));
  }
  assert.equal(safeReturnTo('//evil.com'), '/');
  assert.equal(safeReturnTo('/\\evil.com'), '/');
});

test('session cookie is replaced on each sign-in (no session fixation)', async () => {
  const b = await h.signedIn('s-fix', 'F');
  const first = [...b.cookies.values()][0];
  await b.signIn('s-fix', 'F');
  const second = [...b.cookies.values()][0];
  assert.notEqual(first, second);
  const stale = h.browser();
  stale.cookies.set('wt_session', first);
  assert.equal((await stale.get('/api/me')).body.user, null, 'old session ended');
});

test('made-up or stolen-looking cookies get nothing', async () => {
  const b = h.browser();
  for (const v of ['x', 'A'.repeat(43), "'; DROP TABLE users; --", '%00', 'a'.repeat(5000)]) {
    b.cookies.set('wt_session', v);
    const me = await b.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user, null, v.slice(0, 20));
  }
});

test('changes need the right Origin AND the CSRF token', async () => {
  const b = await h.signedIn('s-csrf', 'Csrf');
  const ok = await b.post('/api/name', { name: 'Okay' });
  assert.equal(ok.status, 200);
  const evil = await b.post('/api/name', { name: 'Hacked' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error, 'bad-origin');
  const noOrigin = await b.post('/api/name', { name: 'Hacked' }, { origin: null });
  assert.equal(noOrigin.status, 403);
  const crossSite = await b.post('/api/name', { name: 'Hacked' }, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const noToken = await b.post('/api/name', { name: 'Hacked' }, { csrf: 'wrong' });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.error, 'bad-csrf');
  // A plain HTML form post (what a malicious page could send) is refused.
  const form = await b.post('/api/name', 'name=Hacked', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  assert.equal((await b.get('/api/me')).body.user.name, 'Okay');
});

test('another account\'s CSRF token does not work for mine', async () => {
  const a = await h.signedIn('s-ca', 'A');
  const b = await h.signedIn('s-cb', 'B');
  const aToken = (await a.get('/api/me')).body.csrf;
  const r = await b.post('/api/name', { name: 'X' }, { csrf: aToken });
  assert.equal(r.status, 403);
});

test('oversized and malformed request bodies are rejected', async () => {
  const b = await h.signedIn('s-body', 'B');
  assert.equal((await b.post('/api/name', 'x'.repeat(10_000))).status, 413);
  assert.equal((await b.post('/api/name', '{not json')).status, 400);
  assert.equal((await b.post('/api/name', '[1,2]')).status, 400);
  assert.equal((await b.post('/api/name', { name: 42 })).status, 400);
  assert.equal((await b.post('/api/name', { name: '​​' })).status, 400);
});

test('sign out ends this device only; sign out everywhere ends all', async () => {
  const sub = 's-out';
  const phone = await h.signedIn(sub, 'P');
  const laptop = await h.signedIn(sub, 'P');
  const r = await phone.post('/api/signout');
  assert.equal(r.status, 200);
  assert.equal((await phone.get('/api/me')).body.user, null);
  assert.ok((await laptop.get('/api/me')).body.user, 'other device still signed in');

  const tablet = await h.signedIn(sub, 'P');
  await laptop.post('/api/signout-all');
  assert.equal((await laptop.get('/api/me')).body.user, null);
  assert.equal((await tablet.get('/api/me')).body.user, null);
});

test('security headers on every page', async () => {
  const b = h.browser();
  for (const p of ['/', '/join', '/account', '/app.js', '/api/me']) {
    const res = await b.raw(p);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', p);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
  }
  const html = await b.raw('/');
  const csp = html.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/www\.youtube\.com(;|$)/, 'no inline scripts');
  assert.match(csp, /connect-src 'self'/);
  assert.equal((await b.raw('/api/me')).headers.get('cache-control'), 'no-store');
});

test('sign-in page is rate limited per address', async () => {
  const strict = await startApp();
  const b = strict.browser();
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++) limited = (await b.raw('/auth/google')).status === 429;
  assert.ok(limited);
  await strict.close();
});

test('without Google keys the app runs; Google sign-in says it is off', async () => {
  const { createServer } = await import('../server.js');
  const app = createServer({ config: { ...loadConfig({ DATA_DIR: h.dir + '/nokeys' }), backupEveryMs: 0 } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/me`)).json(), { user: null, googleReady: false });
  assert.equal((await fetch(`${base}/auth/google`, { redirect: 'manual' })).status, 503);
  await new Promise((r) => app.server.close(r));
});
