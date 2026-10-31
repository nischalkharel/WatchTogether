// Offline sign-in: username + password accounts, with no Google set up at all.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from '../server.js';
import { loadConfig } from '../config.js';
import { Browser, tmpDir, linkPeople } from './helpers.js';
import { hashPassword, verifyPassword, normalizeUsername, checkPassword } from '../passwords.js';
import { openStore } from '../db.js';
import { resetPassword } from '../scripts/reset-password.js';

const GOOD = 'purple-otter-sings-42';

// A server with NO Google keys, like `npm start` with no setup.
async function startOffline(env = {}) {
  const dir = tmpDir('offline-');
  const probe = createServer({ config: { ...loadConfig({ DATA_DIR: dir, BACKUP_EVERY_HOURS: '0', ...env }) } });
  await new Promise((r) => probe.server.listen(0, '127.0.0.1', r));
  const port = probe.server.address().port;
  await new Promise((r) => probe.server.close(r));
  const app = createServer({
    config: loadConfig({ PUBLIC_URL: `http://127.0.0.1:${port}`, DATA_DIR: dir, BACKUP_EVERY_HOURS: '0', ...env }),
  });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  const h = {
    origin: `http://127.0.0.1:${port}`,
    app,
    dir,
    browser: () => new Browser(h),
    async signUp(username, password = GOOD, name = username) {
      const b = new Browser(h);
      const r = await b.post('/api/signup', { username, password, name }, { csrf: '' });
      b.lastStatus = r.status;
      b.lastBody = r.body;
      return b;
    },
    async close() {
      await new Promise((r) => app.server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

let h;
before(async () => {
  h = await startOffline({ RATE_LIMIT_SCALE: '100' });
});
after(() => h.close());

let n = 0;
const uname = (base = 'user') => `${base}${n++}`;

// ---------------------------------------------------------------- pieces

test('hashing: scrypt with a random salt; verify accepts only the right password', async () => {
  const a = await hashPassword(GOOD);
  const b = await hashPassword(GOOD);
  assert.match(a, /^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  assert.notEqual(a, b, 'same password, different hashes');
  assert.ok(!a.includes(GOOD));
  assert.equal(await verifyPassword(GOOD, a), true);
  assert.equal(await verifyPassword(GOOD + 'x', a), false);
  assert.equal(await verifyPassword('', a), false);
  assert.equal(await verifyPassword(GOOD, 'garbage'), false);
  assert.equal(await verifyPassword(GOOD, 'scrypt$1$1$1$x$y'), false);
});

test('usernames: case-insensitive, limited characters', () => {
  assert.equal(normalizeUsername('  Alex.Smith '), 'alex.smith');
  assert.equal(normalizeUsername('bo_b-2'), 'bo_b-2');
  for (const bad of ['ab', 'x'.repeat(31), 'has space', 'émile', '.dot', 'dash-', 'a@b.com', '', null, 42]) {
    assert.equal(normalizeUsername(bad), null, String(bad));
  }
});

test('password rules: long enough, not common, not the username', () => {
  checkPassword(GOOD, 'alex');
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.code;
    }
  };
  assert.equal(code(() => checkPassword('short', 'alex')), 'weak-password');
  assert.equal(code(() => checkPassword('password123', 'alex')), 'common-password');
  assert.equal(code(() => checkPassword('alexalex1234', 'alex')), 'common-password');
  assert.equal(code(() => checkPassword('aaaaaaaaaaaa', 'alex')), 'common-password');
  assert.equal(code(() => checkPassword('x'.repeat(201), 'alex')), 'bad-password');
  assert.equal(code(() => checkPassword(12345678901, 'alex')), 'weak-password');
});

// ---------------------------------------------------------------- end to end

test('no Google keys: server runs, Google is reported off, password sign-up works', async () => {
  const anon = h.browser();
  assert.deepEqual((await anon.get('/api/me')).body, { user: null, googleReady: false });
  assert.equal((await anon.raw('/auth/google')).status, 503);
  const b = await h.signUp(uname('alex'), GOOD, 'Alex');
  assert.equal(b.lastStatus, 200);
  const me = (await b.get('/api/me')).body;
  assert.equal(me.user.name, 'Alex');
  assert.equal(me.user.hasPassword, true);
  assert.match(me.user.username, /^alex\d+$/);
});

test('log in, log out, log in again', async () => {
  const name = uname('bo');
  const b = await h.signUp(name);
  await b.post('/api/signout');
  assert.equal((await b.get('/api/me')).body.user, null);
  const r = await b.post('/api/login', { username: name.toUpperCase(), password: GOOD }, { csrf: '' });
  assert.equal(r.status, 200, 'usernames are case-insensitive');
  assert.equal((await b.get('/api/me')).body.user.username, name);
});

test('wrong password and unknown username get the exact same answer', async () => {
  const name = uname('cy');
  await h.signUp(name);
  const b = h.browser();
  const wrong = await b.post('/api/login', { username: name, password: 'not-the-password' }, { csrf: '' });
  const nobody = await b.post('/api/login', { username: 'nobody-here', password: 'not-the-password' }, { csrf: '' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, nobody.body);
  assert.equal(b.cookies.size, 0);
});

test('timing does not reveal which usernames exist', async () => {
  const name = uname('dee');
  await h.signUp(name);
  const b = h.browser();
  const time = async (u) => {
    const t = performance.now();
    await b.post('/api/login', { username: u, password: 'wrong-password-xx' }, { csrf: '' });
    return performance.now() - t;
  };
  const real = [];
  const fake = [];
  for (let i = 0; i < 4; i++) {
    real.push(await time(name));
    fake.push(await time(`ghost${i}x`));
  }
  const avg = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
  assert.ok(avg(fake) > avg(real) * 0.5, `unknown ${avg(fake).toFixed(0)}ms vs real ${avg(real).toFixed(0)}ms`);
});

test('sign-up: taken usernames, bad usernames, weak passwords are refused', async () => {
  const name = uname('eve');
  assert.equal((await h.signUp(name)).lastStatus, 200);
  const dup = await h.signUp(name.toUpperCase());
  assert.equal(dup.lastStatus, 409);
  assert.equal(dup.lastBody.error, 'username-taken');
  assert.equal((await h.signUp('a b c')).lastBody.error, 'bad-username');
  assert.equal((await h.signUp(uname('fred'), 'short')).lastBody.error, 'weak-password');
  assert.equal((await h.signUp(uname('greg'), 'password123')).lastBody.error, 'common-password');
});

test('passwords are never stored, logged or returned', async () => {
  const secret = 'very-unusual-secret-phrase-77';
  const name = uname('hid');
  const b = await h.signUp(name, secret);
  const all = JSON.stringify(h.app.store.db.prepare('SELECT * FROM passwords').all()) +
    JSON.stringify(h.app.store.db.prepare('SELECT * FROM users').all()) +
    JSON.stringify((await b.get('/api/me')).body) +
    JSON.stringify((await b.get('/api/export')).body);
  assert.ok(!all.includes(secret));
  h.app.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const file = fs.readFileSync(`${h.dir}/watch.db`);
  assert.ok(!file.includes(Buffer.from(secret)), 'not in the database file');
});

test('password guessing is rate limited per username, even from many addresses', async () => {
  const strict = await startOffline();
  const name = 'target-user';
  await strict.signUp(name);
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) {
    const b = strict.browser();
    const r = await b.post('/api/login', { username: name, password: `guess-number-${i}` }, {
      csrf: '',
      headers: { 'x-forwarded-for': `10.0.0.${i}` }, // ignored without TRUST_PROXY, but shows intent
    });
    limited = r.status === 429;
  }
  assert.ok(limited, 'blocked after a handful of wrong guesses');
  await strict.close();
});

test('sign-up spam from one address is limited', async () => {
  const strict = await startOffline();
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) limited = (await strict.signUp(`spam${i}`)).lastStatus === 429;
  assert.ok(limited);
  await strict.close();
});

test('log-in and sign-up refuse other websites', async () => {
  const name = uname('xsite');
  await h.signUp(name);
  const b = h.browser();
  const r = await b.post('/api/login', { username: name, password: GOOD }, { csrf: '', origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const r2 = await b.post('/api/signup', { username: uname('xavi'), password: GOOD }, { csrf: '', origin: 'https://evil.example' });
  assert.equal(r2.status, 403);
  const r3 = await b.post('/api/login', { username: name, password: GOOD }, { csrf: '', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r3.status, 403);
  assert.equal(b.cookies.size, 0);
});

test('logging in replaces any existing session cookie (no session fixation)', async () => {
  const name = uname('fix');
  await h.signUp(name);
  // An attacker plants their own valid session cookie in the victim's browser...
  const attacker = await h.signUp(uname('planted'));
  const planted = [...attacker.cookies.values()][0];
  const b = h.browser();
  b.cookies.set('wt_session', planted);
  // ...then the victim logs in. They must get a brand-new session.
  await b.post('/api/login', { username: name, password: GOOD }, { csrf: '' });
  assert.notEqual([...b.cookies.values()][0], planted);
  const stale = h.browser();
  stale.cookies.set('wt_session', planted);
  assert.equal((await stale.get('/api/me')).body.user, null, 'the old session was ended');
});

test('change password: needs the current one, signs out other devices', async () => {
  const name = uname('chg');
  const phone = await h.signUp(name);
  const laptop = h.browser();
  await laptop.post('/api/login', { username: name, password: GOOD }, { csrf: '' });
  assert.equal((await phone.post('/api/password', { current: 'wrong-current-pw', password: 'brand-new-password-9' })).body.error, 'wrong-password');
  assert.equal((await phone.post('/api/password', { current: GOOD, password: 'short' })).body.error, 'weak-password');
  assert.equal((await phone.post('/api/password', { current: GOOD, password: 'brand-new-password-9' })).status, 200);
  assert.ok((await phone.get('/api/me')).body.user, 'this device stays signed in');
  assert.equal((await laptop.get('/api/me')).body.user, null, 'other devices are signed out');
  const again = h.browser();
  assert.equal((await again.post('/api/login', { username: name, password: GOOD }, { csrf: '' })).status, 401);
  assert.equal((await again.post('/api/login', { username: name, password: 'brand-new-password-9' }, { csrf: '' })).status, 200);
});

test('change password needs the CSRF token like every other change', async () => {
  const b = await h.signUp(uname('csrfpw'));
  const r = await b.post('/api/password', { current: GOOD, password: 'another-good-pass-1' }, { csrf: 'wrong' });
  assert.equal(r.status, 403);
});

test('two offline accounts can link and watch together', async () => {
  const a = await h.signUp(uname('alex'), GOOD, 'Alex');
  const b = await h.signUp(uname('bo'), GOOD, 'Bo');
  await linkPeople(a, b);
  assert.equal((await a.get('/api/me')).body.partner.name, 'Bo');
  const sa = await a.ws();
  assert.equal((await sa.next((m) => m.type === 'welcome')).type, 'welcome');
  await sa.close();
});

test('the username is private: partners and exports of others never see it', async () => {
  const aName = uname('secretname');
  const a = await h.signUp(aName, GOOD, 'Alex');
  const b = await h.signUp(uname('bo'), GOOD, 'Bo');
  await linkPeople(a, b);
  const bView = JSON.stringify((await b.get('/api/me')).body) + JSON.stringify((await b.get('/api/export')).body);
  assert.ok(!bView.includes(aName));
});

test('deleting an offline account removes its username and password too', async () => {
  const name = uname('gone');
  const b = await h.signUp(name);
  await b.post('/api/delete', { confirm: 'DELETE' });
  const db = h.app.store.db;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM logins WHERE username = ?').get(name).n, 0);
  assert.equal((await h.signUp(name)).lastStatus, 200, 'the username is free again');
});

test('a Google account can add a username + password, and then use either', async () => {
  const { startApp } = await import('./helpers.js');
  const g = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
  const b = await g.signedIn('google-sub-1', 'Gina');
  assert.equal((await b.get('/api/me')).body.user.hasPassword, false);
  const r = await b.post('/api/password', { username: 'gina-g', password: GOOD });
  assert.equal(r.status, 200);
  const me = (await b.get('/api/me')).body.user;
  assert.equal(me.username, 'gina-g');
  assert.equal(me.hasPassword, true);
  const other = g.browser();
  assert.equal((await other.post('/api/login', { username: 'gina-g', password: GOOD }, { csrf: '' })).status, 200);
  assert.equal((await other.get('/api/me')).body.user.name, 'Gina', 'same account either way');
  await g.close();
});

test('upgrading an older database adds offline sign-in without losing anything', async () => {
  const dir = tmpDir('upgrade-');
  const file = `${dir}/watch.db`;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    // Build a v1 database by hand (as the previous version of the app made it).
    const v1 = new DatabaseSync(file);
    const sql = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
    const first = sql.slice(sql.indexOf('const MIGRATIONS = [') + 'const MIGRATIONS = ['.length);
    v1.exec(first.slice(first.indexOf('`') + 1, first.indexOf('`', first.indexOf('`') + 1)));
    v1.exec("PRAGMA user_version = 1; INSERT INTO users VALUES ('u1', 'google', 'g-1', 'Old Timer', 0)");
    v1.close();
    const store = openStore({ file });
    assert.ok(store.db.prepare('PRAGMA user_version').get().user_version >= 2, 'upgraded to the latest version');
    assert.equal(store.db.prepare("SELECT name FROM users WHERE id = 'u1'").get().name, 'Old Timer');
    assert.ok(fs.readdirSync(dir).some((f) => /^watch\.db\.before-v\d+\.bak$/.test(f)), 'a copy was kept before upgrading');
    await store.createLocalUser({ username: 'newbie', password: GOOD, name: 'New' });
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server-side password reset: new password works, old one and old sessions do not', async () => {
  const name = uname('forgot');
  const b = await h.signUp(name);
  await resetPassword(h.app.store, name.toUpperCase(), 'reset-by-the-admin-1');
  assert.equal((await b.get('/api/me')).body.user, null, 'signed out everywhere');
  const c = h.browser();
  assert.equal((await c.post('/api/login', { username: name, password: GOOD }, { csrf: '' })).status, 401);
  assert.equal((await c.post('/api/login', { username: name, password: 'reset-by-the-admin-1' }, { csrf: '' })).status, 200);
  await assert.rejects(resetPassword(h.app.store, 'no-such-user', 'whatever-long-pw'), /No account/);
  await assert.rejects(resetPassword(h.app.store, name, 'short'), (e) => e.code === 'weak-password');
});
