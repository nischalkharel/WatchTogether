// Chat and history over the real server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, agreeOn } from './helpers.js';

const V1 = 'dQw4w9WgXcQ';
const V2 = 'jNQXAC9IVRw';
let h;
before(async () => {
  h = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
});
after(() => h.close());

const isChat = (m) => m.type === 'chat';

async function connected(app = h) {
  const [a, b] = await app.couple();
  const sa = await a.ws();
  const sb = await b.ws();
  await sa.next((m) => m.type === 'welcome');
  await sb.next((m) => m.type === 'welcome');
  return { a, b, sa, sb, close: () => Promise.all([sa.close(), sb.close()]) };
}

test('a chat message reaches the partner instantly and the sender gets it confirmed', async () => {
  const c = await connected();
  c.sa.send({ type: 'chat', text: 'hi Bo!', ref: 'r1' });
  const mine = await c.sa.next(isChat);
  assert.deepEqual([mine.message.text, mine.message.mine, mine.ref], ['hi Bo!', true, 'r1']);
  const theirs = await c.sb.next(isChat);
  assert.deepEqual([theirs.message.text, theirs.message.mine, theirs.ref], ['hi Bo!', false, undefined]);
  assert.equal(theirs.message.id, mine.message.id);
  await c.close();
});

test('your other devices see your messages too, marked as yours', async () => {
  const sub = `multi-${Math.random()}`;
  const phone = await h.signedIn(sub, 'Alex');
  const laptop = await h.signedIn(sub, 'Alex');
  const partner = await h.signedIn(`p-${Math.random()}`, 'Bo');
  const { linkPeople } = await import('./helpers.js');
  await linkPeople(phone, partner);
  const s1 = await phone.ws();
  const s2 = await laptop.ws();
  await s1.next((m) => m.type === 'welcome');
  await s2.next((m) => m.type === 'welcome');
  s1.send({ type: 'chat', text: 'from my phone' });
  const onLaptop = await s2.next(isChat);
  assert.deepEqual([onLaptop.message.text, onLaptop.message.mine], ['from my phone', true]);
  await Promise.all([s1.close(), s2.close()]);
});

test('messages are saved: loading the chat shows them, from each person\'s side', async () => {
  const c = await connected();
  c.sa.send({ type: 'chat', text: 'one' });
  await c.sb.next(isChat);
  c.sb.send({ type: 'chat', text: 'two' });
  await c.sa.next(isChat);
  const fromA = (await c.a.get('/api/chat')).body;
  assert.deepEqual(fromA.messages.map((m) => [m.text, m.mine]), [['one', true], ['two', false]]);
  assert.equal(fromA.more, false);
  await c.close();
});

test('chat survives a server restart', async () => {
  const app = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
  const c = await connected(app);
  c.sa.send({ type: 'chat', text: 'before restart' });
  await c.sb.next(isChat);
  await c.close();
  await app.restart();
  assert.deepEqual((await c.b.get('/api/chat')).body.messages.map((m) => m.text), ['before restart']);
  await app.close();
});

test('empty, too long and junk messages are refused with a reason', async () => {
  const c = await connected();
  c.sa.send({ type: 'chat', text: '   ', ref: 'e1' });
  assert.deepEqual([(await c.sa.next((m) => m.type === 'chat-error')).error], ['empty-message']);
  c.sa.send({ type: 'chat', text: 'x'.repeat(501), ref: 'e2' });
  const long = await c.sa.next((m) => m.type === 'chat-error');
  assert.deepEqual([long.error, long.ref], ['long-message', 'e2']);
  c.sa.send({ type: 'chat', text: { evil: true } });
  assert.equal((await c.sa.next((m) => m.type === 'chat-error')).error, 'empty-message');
  await assert.rejects(c.sb.next(isChat, 300), 'nothing reached the partner');
  await c.close();
});

test('chat spam is rate limited', async () => {
  const strict = await startApp();
  const c = await connected(strict);
  for (let i = 0; i < 30; i++) c.sa.send({ type: 'chat', text: `spam ${i}` });
  const errors = [];
  const ok = [];
  for (;;) {
    try {
      const m = await c.sa.next((x) => x.type === 'chat' || x.type === 'chat-error', 300);
      (m.type === 'chat' ? ok : errors).push(m);
    } catch {
      break;
    }
  }
  assert.ok(ok.length >= 8 && ok.length <= 12, `${ok.length} got through`);
  assert.ok(errors.length > 0 && errors.every((e) => e.error === 'too-many'));
  await c.close();
  await strict.close();
});

test('another couple can\'t read our chat, and their chat never reaches us', async () => {
  const c = await connected();
  const d = await connected();
  c.sa.send({ type: 'chat', text: 'just us' });
  await c.sa.next(isChat); // Alex's own confirmation
  await c.sb.next(isChat);
  await assert.rejects(d.sa.next(isChat, 300));
  await assert.rejects(d.sb.next(isChat, 300));
  assert.deepEqual((await d.a.get('/api/chat')).body.messages, []);
  d.sa.send({ type: 'chat', text: 'them' });
  await d.sb.next(isChat); // it did go to their own partner
  await assert.rejects(c.sa.next((m) => isChat(m) && m.message.text === 'them', 300));
  await assert.rejects(c.sb.next((m) => isChat(m) && m.message.text === 'them', 300));
  await Promise.all([c.close(), d.close()]);
});

test('unlinked or signed-out people can\'t chat or read history', async () => {
  const lonely = await h.signedIn(`lonely-${Math.random()}`, 'Lonely');
  assert.equal((await lonely.get('/api/chat')).body.error, 'not-linked');
  assert.equal((await lonely.get('/api/history')).body.error, 'not-linked');
  const s = await lonely.ws();
  await s.next((m) => m.type === 'nolink');
  s.send({ type: 'chat', text: 'anyone?' });
  assert.equal((await s.closed).code, 1008);
  const anon = h.browser();
  assert.equal((await anon.get('/api/chat')).status, 401);
  assert.equal((await anon.get('/api/history')).status, 401);
});

test('chat and history reads refuse other websites', async () => {
  const [a] = await h.couple();
  assert.equal((await a.get('/api/chat', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await a.get('/api/history', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await a.post('/api/chat/clear', {}, { csrf: 'wrong' })).status, 403);
  assert.equal((await a.post('/api/history/clear', {}, { origin: 'https://evil.example' })).status, 403);
});

test('clearing the chat clears it for both, live', async () => {
  const c = await connected();
  c.sa.send({ type: 'chat', text: 'oops' });
  await c.sb.next(isChat);
  await c.b.post('/api/chat/clear');
  assert.equal((await c.sa.next((m) => m.type === 'chat-cleared')).type, 'chat-cleared');
  assert.deepEqual((await c.a.get('/api/chat')).body.messages, []);
  await c.close();
});

test('history: accepted videos are recorded with who picked them; declined ones are not', async () => {
  const c = await connected();
  await agreeOn(c.a, c.b, V1); // Alex picked, Bo accepted
  assert.equal((await c.sb.next((m) => m.type === 'history')).type, 'history');
  const declined = (await c.b.post('/api/propose', { v: V2 })).body.proposal;
  await c.a.post('/api/proposal/decline', { id: declined.id });
  const hist = (await c.b.get('/api/history')).body.items;
  assert.deepEqual(hist.map((x) => [x.v, x.pickedBy]), [[V1, 'Alex']]);
  assert.equal((await c.a.get('/api/history')).body.items[0].pickedBy, 'you');
  await c.close();
});

test('history: either person can delete an entry or clear it; others can\'t', async () => {
  const c = await connected();
  const d = await connected();
  await agreeOn(c.a, c.b, V1);
  await agreeOn(c.b, c.a, V2);
  const [latest] = (await c.a.get('/api/history')).body.items;
  assert.equal((await d.a.post('/api/history/remove', { id: latest.id })).status, 404, 'other couple');
  assert.equal((await c.b.post('/api/history/remove', { id: latest.id })).status, 200);
  assert.deepEqual((await c.a.get('/api/history')).body.items.map((x) => x.v), [V1]);
  await c.a.post('/api/history/clear');
  assert.deepEqual((await c.b.get('/api/history')).body.items, []);
  await Promise.all([c.close(), d.close()]);
});

test('unlinking removes chat and history', async () => {
  const c = await connected();
  c.sa.send({ type: 'chat', text: 'bye' });
  await c.sb.next(isChat);
  await agreeOn(c.a, c.b, V1);
  await c.a.post('/api/unlink');
  const { linkPeople } = await import('./helpers.js');
  await linkPeople(c.a, c.b);
  assert.deepEqual((await c.a.get('/api/chat')).body.messages, []);
  assert.deepEqual((await c.a.get('/api/history')).body.items, []);
});
