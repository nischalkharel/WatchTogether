// Static files, and syncing playback between a linked couple over WebSockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, agreeOn } from './helpers.js';

const V = 'dQw4w9WgXcQ';
let h;
before(async () => {
  h = await startApp({ holdMaxMs: 300, env: { RATE_LIMIT_SCALE: '100' } });
});
after(() => h.close());

const isState = (m) => m.type === 'state';
// Raw HTTP (fetch would quietly decompress bodies and hide what was sent).
const get = (p, headers = {}) =>
  new Promise((resolve, reject) => {
    http
      .get(h.origin + p, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null }, body: Buffer.concat(chunks) })
        );
      })
      .on('error', reject);
  });

// A linked couple, both connected.
async function connectedCouple() {
  const [a, b] = await h.couple();
  const sa = await a.ws();
  const wa = await sa.next((m) => m.type === 'welcome');
  const sb = await b.ws();
  const wb = await sb.next((m) => m.type === 'welcome');
  await sa.next((m) => m.type === 'presence' && m.n === 2);
  return { a, b, sa, sb, wa, wb, close: () => Promise.all([sa.close(), sb.close()]) };
}

// ---------------------------------------------------------------- HTTP

test('serves the app shell for its pages', async () => {
  for (const p of ['/', '/join', '/account', '/privacy']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.body.toString(), /Watch Together/);
  }
  assert.equal((await get('/r/some-room')).status, 404, 'old public room links are gone');
});

test('serves static assets with the right types', async () => {
  const cases = {
    '/app.js': /javascript/,
    '/sync.js': /javascript/,
    '/controller.js': /javascript/,
    '/style.css': /text\/css/,
    '/icon.svg': /svg/,
    '/manifest.webmanifest': /manifest\+json/,
  };
  for (const [p, type] of Object.entries(cases)) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type, p);
  }
});

test('compresses responses and supports conditional requests', async () => {
  const plain = await get('/app.js');
  const br = await get('/app.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.headers.get('content-encoding'), 'br');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), plain.body);
  const gz = await get('/app.js', { 'accept-encoding': 'gzip' });
  assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);
  const again = await get('/app.js', { 'if-none-match': plain.headers.get('etag') });
  assert.equal(again.status, 304);
});

test('whole app is still small', async () => {
  let total = 0;
  for (const p of ['/', '/app.js', '/sync.js', '/controller.js', '/style.css', '/icon.svg']) {
    total += (await get(p, { 'accept-encoding': 'br' })).body.length;
  }
  assert.ok(total < 30_000, `app is ${total} bytes compressed`);
});

test('404s, and server files / the database are never served', async () => {
  for (const p of ['/nope.js', '/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/package.json', '/rooms.js', '/db.js', '/data/watch.db', '/watch.db', '/%2e%2e/data/watch.db']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('healthz', async () => {
  const r = await get('/healthz');
  assert.equal(r.body.toString(), 'ok');
});

// ---------------------------------------------------------------- syncing

test('welcome carries id, state, server time and boot id', async () => {
  const c = await connectedCouple();
  assert.equal(typeof c.wa.id, 'string');
  assert.equal(typeof c.wa.boot, 'string');
  assert.ok(Math.abs(c.wa.t - Date.now()) < 1000);
  assert.deepEqual({ ...c.wa.state, at: 0 }, { v: null, playing: false, pos: 0, at: 0, hold: [], seq: 0 });
  await c.close();
});

test('ping/pong echoes the client timestamp', async () => {
  const c = await connectedCouple();
  c.sa.send({ type: 'ping', c: 12345 });
  assert.equal((await c.sa.next((m) => m.type === 'pong')).c, 12345);
  await c.close();
});

test('an accepted video, then pause / seek / play, reach both', async () => {
  const c = await connectedCouple();
  await agreeOn(c.a, c.b, V, 5);
  const sb = await c.sb.next(isState);
  assert.equal(sb.state.v, V);
  assert.equal(sb.state.pos, 5);
  assert.equal(sb.kind, 'load');
  assert.equal((await c.sa.next(isState)).state.v, V, 'the proposer starts too');

  c.sb.send({ type: 'action', action: { type: 'pause', pos: 7.5 }, at: Date.now() });
  const p = await c.sa.next((m) => isState(m) && m.kind === 'pause');
  assert.equal(p.state.playing, false);
  assert.equal(p.state.pos, 7.5);

  c.sb.send({ type: 'action', action: { type: 'seek', pos: 60 }, at: Date.now() });
  assert.equal((await c.sa.next((m) => isState(m) && m.kind === 'seek')).state.pos, 60);
  c.sa.send({ type: 'action', action: { type: 'play', pos: 60 }, at: Date.now() });
  assert.equal((await c.sb.next((m) => isState(m) && m.kind === 'play')).state.playing, true);
  await c.close();
});

test('invalid and malformed messages are ignored', async () => {
  const c = await connectedCouple();
  c.sa.ws.send('not json');
  c.sa.ws.send(Buffer.from([1, 2, 3]));
  c.sa.send(null);
  c.sa.send({ type: 'action', action: { type: 'load', v: V } }); // must go through a proposal
  c.sa.send({ type: 'action', action: { type: 'play', pos: 0 } }); // no video yet
  c.sa.send({ type: 'action' });
  c.sa.send({ type: 'whatever' });
  await assert.rejects(c.sb.next(isState, 300));
  await agreeOn(c.a, c.b, V);
  assert.equal((await c.sb.next(isState)).state.v, V);
  await c.close();
});

test('oversized messages close the socket', async () => {
  const c = await connectedCouple();
  c.sa.ws.send('x'.repeat(10_000));
  assert.equal((await c.sa.closed).code, 1009);
  await c.close();
});

test('buffer hold freezes the room; release and timeout unfreeze it', async () => {
  const c = await connectedCouple();
  await agreeOn(c.a, c.b, V);
  await c.sa.next(isState);
  await c.sb.next(isState);
  c.sb.send({ type: 'buffer', on: true });
  const held = await c.sa.next(isState);
  assert.deepEqual(held.state.hold, [c.wb.id]);
  c.sb.send({ type: 'buffer', on: false });
  assert.deepEqual((await c.sa.next(isState)).state.hold, []);
  c.sb.send({ type: 'buffer', on: true });
  await c.sa.next(isState);
  assert.deepEqual((await c.sa.next(isState, 2000)).state.hold, [], 'expires (300ms in tests)');
  await c.close();
});

test('disconnecting while holding releases the hold', async () => {
  const c = await connectedCouple();
  await agreeOn(c.a, c.b, V);
  await c.sa.next(isState);
  c.sb.send({ type: 'buffer', on: true });
  assert.equal((await c.sa.next(isState)).state.hold.length, 1);
  await c.sb.close();
  assert.deepEqual((await c.sa.next(isState)).state.hold, []);
  assert.equal((await c.sa.next((m) => m.type === 'presence')).n, 1);
  await c.close();
});

test('message flooding is rate limited', async () => {
  const c = await connectedCouple();
  for (let i = 0; i < 200; i++) c.sa.send({ type: 'ping', c: i });
  await new Promise((r) => setTimeout(r, 300));
  let pongs = 0;
  for (;;) {
    try {
      await c.sa.next((m) => m.type === 'pong', 50);
      pongs++;
    } catch {
      break;
    }
  }
  assert.ok(pongs >= 30 && pongs <= 60, `${pongs} pongs`);
  await c.close();
});

// ---------------------------------------------------------------- nothing is lost

test('what you were watching survives a server restart', async () => {
  const app = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
  const [a, b] = await app.couple();
  let sa = await a.ws();
  await sa.next((m) => m.type === 'welcome');
  await agreeOn(a, b, V, 30);
  await sa.next(isState);
  sa.send({ type: 'action', action: { type: 'pause', pos: 42.5 } });
  await sa.next((m) => isState(m) && m.kind === 'pause');

  await app.restart(); // like a deploy, a crash recovery, or the host rebooting

  assert.equal((await a.get('/api/me')).body.partner.name, 'Bo', 'still signed in and linked');
  sa = await a.ws();
  const w = await sa.next((m) => m.type === 'welcome');
  assert.equal(w.state.v, V);
  assert.equal(w.state.playing, false);
  assert.equal(w.state.pos, 42.5);
  const sb = await b.ws();
  assert.equal((await sb.next((m) => m.type === 'welcome')).state.pos, 42.5);
  await Promise.all([sa.close(), sb.close()]);
  await app.close();
});

test('a playing video resumes about where it was after a restart', async () => {
  const app = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
  const [a, b] = await app.couple();
  let sa = await a.ws();
  await sa.next((m) => m.type === 'welcome');
  await agreeOn(a, b, V, 100);
  await sa.next(isState);
  await new Promise((r) => setTimeout(r, 1500));
  await app.restart();
  sa = await a.ws();
  const w = await sa.next((m) => m.type === 'welcome');
  assert.equal(w.state.playing, true);
  assert.ok(w.state.pos >= 101 && w.state.pos < 103, `pos ${w.state.pos}`);
  await sa.close();
  await app.close();
});

test('backups: a full, valid copy is written', async () => {
  const app = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
  const dir = app.dir;
  await app.couple(['Alex', 'Bo']);
  const file = await app.app.backup();
  assert.ok(file && fs.existsSync(file));
  assert.equal(path.dirname(file), path.join(dir, 'backups'), 'defaults to DATA_DIR/backups');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM link_members').get().n, 2);
  copy.close();
  await app.close();
});

test('expired sessions lose their live connection at the next cleanup', async () => {
  const c = await connectedCouple();
  // End exactly A's session behind the server's back (as expiry would).
  const token = [...c.a.cookies.values()][0];
  h.app.store.deleteSession(token);
  h.app.upkeep();
  assert.equal((await c.sa.closed).code, 4001);
  // B's session is untouched and stays connected.
  c.sb.send({ type: 'ping', c: 1 });
  assert.equal((await c.sb.next((m) => m.type === 'pong')).c, 1);
  await c.close();
});
