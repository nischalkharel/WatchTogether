// Chat and "watched together" history: the database rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, CHAT, HISTORY, openStore } from '../db.js';

const V1 = 'dQw4w9WgXcQ';
const V2 = 'jNQXAC9IVRw';

function clock(t = 1_700_000_000_000) {
  const c = () => c.t;
  c.t = t;
  return c;
}

function setup() {
  const now = clock();
  const store = openStore({ file: ':memory:', now });
  const mk = (sub) => store.upsertUser({ provider: 'google', subject: sub, name: sub });
  const pair = (x, y) => {
    const a = mk(x);
    const b = mk(y);
    store.redeemInvite(b.id, store.createInvite(a.id).token);
    store.acceptRequest(a.id, store.incomingRequests(a.id)[0].id);
    return [a, b, store.linkOf(a.id).linkId];
  };
  return { now, store, mk, pair };
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

// ---------------------------------------------------------------- chat

test('chat: both see the conversation, each from their own side', () => {
  const { store, pair, now } = setup();
  const [a, b] = pair('Alex', 'Bo');
  store.sendMessage(a.id, 'hi!');
  now.t += 1000;
  store.sendMessage(b.id, 'hey 👋');
  const fromA = store.listMessages(a.id).messages;
  const fromB = store.listMessages(b.id).messages;
  assert.deepEqual(fromA.map((m) => [m.text, m.mine]), [['hi!', true], ['hey 👋', false]]);
  assert.deepEqual(fromB.map((m) => [m.text, m.mine]), [['hi!', false], ['hey 👋', true]]);
  assert.ok(fromA[1].at > fromA[0].at);
});

test('chat: another couple can never read or write our messages', () => {
  const { store, pair } = setup();
  const [a] = pair('Alex', 'Bo');
  const [c] = pair('Cy', 'Di');
  store.sendMessage(a.id, 'private');
  assert.deepEqual(store.listMessages(c.id).messages, []);
  store.sendMessage(c.id, 'theirs');
  assert.deepEqual(store.listMessages(a.id).messages.map((m) => m.text), ['private']);
  store.clearChat(c.id);
  assert.equal(store.listMessages(a.id).messages.length, 1, 'their clear does not touch ours');
});

test('chat: unlinked people cannot chat', () => {
  const { store, mk } = setup();
  const lonely = mk('Lonely');
  assert.equal(code(() => store.sendMessage(lonely.id, 'hi')), 'not-linked');
  assert.equal(code(() => store.listMessages(lonely.id)), 'not-linked');
});

test('chat: cleaned text, sensible limits', () => {
  const { store, pair } = setup();
  const [a] = pair('Alex', 'Bo');
  assert.equal(code(() => store.sendMessage(a.id, '   ')), 'empty-message');
  assert.equal(code(() => store.sendMessage(a.id, '​‮')), 'empty-message');
  assert.equal(code(() => store.sendMessage(a.id, 42)), 'empty-message');
  assert.equal(code(() => store.sendMessage(a.id, 'x'.repeat(CHAT.MAX_CHARS + 1))), 'long-message');
  store.sendMessage(a.id, '😀'.repeat(CHAT.MAX_CHARS)); // emoji count as one character each
  store.sendMessage(a.id, '  line one\r\n\n\n\n\nline‮ two\t\tend  ');
  const last = store.listMessages(a.id).messages.at(-1).text;
  assert.equal(last, 'line one\n\nline two end', 'line breaks kept (max 2), invisible tricks removed');
  store.sendMessage(a.id, '<script>alert(1)</script>');
  assert.equal(store.listMessages(a.id).messages.at(-1).text, '<script>alert(1)</script>', 'stored as plain text; the page never renders it as HTML');
});

test('chat: pages of messages, newest last', () => {
  const { store, pair } = setup();
  const [a] = pair('Alex', 'Bo');
  for (let i = 1; i <= CHAT.PAGE + 10; i++) store.sendMessage(a.id, `m${i}`);
  const first = store.listMessages(a.id);
  assert.equal(first.messages.length, CHAT.PAGE);
  assert.equal(first.more, true);
  assert.equal(first.messages.at(-1).text, `m${CHAT.PAGE + 10}`);
  const older = store.listMessages(a.id, first.messages[0].id);
  assert.deepEqual(older.messages.map((m) => m.text), Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
  assert.equal(older.more, false);
});

test('chat: only the newest messages are kept, so it never grows forever', () => {
  const { store, pair } = setup();
  const [a, , linkId] = pair('Alex', 'Bo');
  for (let i = 1; i <= CHAT.KEEP + 25; i++) store.sendMessage(a.id, `m${i}`);
  const n = store.db.prepare('SELECT COUNT(*) AS n, MIN(text) AS t FROM messages WHERE link_id = ?').get(linkId);
  assert.equal(n.n, CHAT.KEEP);
  const oldest = store.db.prepare('SELECT text FROM messages WHERE link_id = ? ORDER BY id LIMIT 1').get(linkId).text;
  assert.equal(oldest, 'm26');
});

test('chat: either person can clear it for both', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  store.sendMessage(a.id, 'one');
  store.sendMessage(b.id, 'two');
  store.clearChat(b.id);
  assert.deepEqual(store.listMessages(a.id).messages, []);
});

// ---------------------------------------------------------------- history

test('history: records what was watched, newest first, with who picked it', () => {
  const { store, pair, now } = setup();
  const [a, b, linkId] = pair('Alex', 'Bo');
  store.recordWatched(linkId, { v: V1, title: 'Song', pickedBy: a.id });
  now.t += 3600_000;
  store.recordWatched(linkId, { v: V2, title: 'Zoo', pickedBy: b.id });
  const fromA = store.listHistory(a.id).items;
  assert.deepEqual(fromA.map((h) => [h.v, h.title, h.pickedBy]), [[V2, 'Zoo', 'Bo'], [V1, 'Song', 'you']]);
  assert.deepEqual(store.listHistory(b.id).items.map((h) => h.pickedBy), ['you', 'Alex']);
});

test('history: picking the same video again straight away is not a new entry', () => {
  const { store, pair, now } = setup();
  const [a, , linkId] = pair('Alex', 'Bo');
  store.recordWatched(linkId, { v: V1, title: 'Song', pickedBy: a.id });
  now.t += 60_000;
  store.recordWatched(linkId, { v: V1, title: 'Song', pickedBy: a.id });
  assert.equal(store.listHistory(a.id).items.length, 1);
  now.t += 3600_000;
  store.recordWatched(linkId, { v: V1, title: 'Song', pickedBy: a.id });
  assert.equal(store.listHistory(a.id).items.length, 2, 'watching it again later is');
});

test('history: another couple can\'t see or delete ours', () => {
  const { store, pair } = setup();
  const [a, , linkA] = pair('Alex', 'Bo');
  const [c] = pair('Cy', 'Di');
  store.recordWatched(linkA, { v: V1, title: 'Ours', pickedBy: a.id });
  const id = store.listHistory(a.id).items[0].id;
  assert.deepEqual(store.listHistory(c.id).items, []);
  assert.equal(code(() => store.removeHistory(c.id, id)), 'history-missing');
  store.clearHistory(c.id);
  assert.equal(store.listHistory(a.id).items.length, 1);
});

test('history: delete one entry, or clear it all', () => {
  const { store, pair } = setup();
  const [a, b, linkId] = pair('Alex', 'Bo');
  store.recordWatched(linkId, { v: V1, title: 'One', pickedBy: a.id });
  store.recordWatched(linkId, { v: V2, title: 'Two', pickedBy: a.id });
  const [two] = store.listHistory(a.id).items;
  store.removeHistory(b.id, two.id);
  assert.deepEqual(store.listHistory(a.id).items.map((h) => h.title), ['One']);
  assert.equal(code(() => store.removeHistory(a.id, two.id)), 'history-missing');
  assert.equal(code(() => store.removeHistory(a.id, 'x')), 'history-missing');
  store.clearHistory(a.id);
  assert.deepEqual(store.listHistory(b.id).items, []);
});

test('history: bad video ids are ignored; it is capped; pages work', () => {
  const { store, pair } = setup();
  const [a, , linkId] = pair('Alex', 'Bo');
  store.recordWatched(linkId, { v: 'bad', title: 'x', pickedBy: a.id });
  assert.equal(store.listHistory(a.id).items.length, 0);
  const id = (i) => `vid${String(i).padStart(8, '0')}`;
  for (let i = 0; i < HISTORY.KEEP + 5; i++) store.recordWatched(linkId, { v: id(i), title: 't', pickedBy: a.id });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM history WHERE link_id = ?').get(linkId).n, HISTORY.KEEP);
  const page = store.listHistory(a.id);
  assert.equal(page.items.length, HISTORY.PAGE);
  assert.equal(page.more, true);
  assert.equal(store.listHistory(a.id, page.items.at(-1).id).items[0].v, id(HISTORY.KEEP + 5 - HISTORY.PAGE - 1));
});

test('history: a placeholder title is filled in once the real one is known', () => {
  const { store, pair } = setup();
  const [a, b, linkId] = pair('Alex', 'Bo');
  store.recordWatched(linkId, { v: V1, title: '', pickedBy: a.id });
  assert.equal(store.listHistory(a.id).items[0].title, 'YouTube video');
  store.fillTitle(b.id, V1, 'Real title');
  assert.equal(store.listHistory(a.id).items[0].title, 'Real title');
});

// ---------------------------------------------------------------- lifecycle

test('unlinking or deleting an account removes chat and history', () => {
  const { store, pair } = setup();
  const [a, b, linkId] = pair('Alex', 'Bo');
  store.sendMessage(a.id, 'hi');
  store.recordWatched(linkId, { v: V1, title: 't', pickedBy: a.id });
  store.unlink(a.id);
  for (const t of ['messages', 'history']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);

  const [c, d, link2] = pair('Cy', 'Di');
  store.sendMessage(d.id, 'hi');
  store.recordWatched(link2, { v: V1, title: 't', pickedBy: d.id });
  store.deleteUser(d.id);
  for (const t of ['messages', 'history']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  void b;
  void c;
});

test('chat and history are in "download my data"', () => {
  const { store, pair } = setup();
  const [a, b, linkId] = pair('Alex', 'Bo');
  store.sendMessage(a.id, 'hi');
  store.sendMessage(b.id, 'hello');
  store.recordWatched(linkId, { v: V1, title: 'Song', pickedBy: b.id });
  const out = store.exportUser(a.id);
  assert.deepEqual(out.chat.map((m) => [m.from, m.text]), [['you', 'hi'], ['Bo', 'hello']]);
  assert.deepEqual(out.watchedTogether.map((h) => [h.youtubeId, h.title, h.pickedBy]), [[V1, 'Song', 'Bo']]);
  assert.ok(!out.notStored.includes('watch history'), 'no longer claims history is not stored');
});
