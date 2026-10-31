// Shared playlists and "watch this?" proposals: the database rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, PLAYLIST_LIMITS, TTL, openStore } from '../db.js';

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
    return [a, b];
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

test('playlists are shared by the pair: either can create, add, see', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const pl = store.createPlaylist(a.id, ' Movie night ');
  assert.equal(pl.name, 'Movie night');
  store.addToPlaylist(b.id, pl.id, { v: V1, title: 'Song', start: 12 });
  store.addToPlaylist(a.id, pl.id, { v: V2, title: 'Zoo', start: 0 });
  for (const [who, me, other] of [[a, 'you', 'Bo'], [b, 'Alex', 'you']]) {
    const lists = store.listPlaylists(who.id);
    assert.equal(lists.length, 1);
    assert.deepEqual(lists[0].items.map((i) => [i.v, i.title, i.start, i.addedBy]), [
      [V1, 'Song', 12, other],
      [V2, 'Zoo', 0, me],
    ]);
  }
});

test('one couple can never see or touch another couple\'s playlists', () => {
  const { store, pair } = setup();
  const [a] = pair('Alex', 'Bo');
  const [c] = pair('Cy', 'Di');
  const pl = store.createPlaylist(a.id, 'Ours');
  const { id: itemId } = store.addToPlaylist(a.id, pl.id, { v: V1, title: 'x', start: 0 });
  assert.deepEqual(store.listPlaylists(c.id), []);
  assert.equal(code(() => store.addToPlaylist(c.id, pl.id, { v: V2, title: 'y', start: 0 })), 'playlist-missing');
  assert.equal(code(() => store.renamePlaylist(c.id, pl.id, 'Hacked')), 'playlist-missing');
  assert.equal(code(() => store.deletePlaylist(c.id, pl.id)), 'playlist-missing');
  assert.equal(code(() => store.removeFromPlaylist(c.id, itemId)), 'item-missing');
  assert.equal(code(() => store.moveInPlaylist(c.id, itemId, 1)), 'item-missing');
  assert.equal(code(() => store.propose(c.id, { itemId })), 'item-missing', "can't even propose their video");
  assert.equal(store.listPlaylists(a.id)[0].name, 'Ours');
  assert.equal(store.listPlaylists(a.id)[0].items.length, 1);
});

test('unlinked people have no playlists and cannot make any', () => {
  const { store, mk } = setup();
  const lonely = mk('Lonely');
  assert.equal(code(() => store.listPlaylists(lonely.id)), 'not-linked');
  assert.equal(code(() => store.createPlaylist(lonely.id, 'x')), 'not-linked');
  assert.equal(code(() => store.propose(lonely.id, { v: V1 })), 'not-linked');
});

test('validation: names, video ids, titles, duplicates, limits', () => {
  const { store, pair } = setup();
  const [a] = pair('Alex', 'Bo');
  assert.equal(code(() => store.createPlaylist(a.id, '   ')), 'bad-playlist-name');
  assert.equal(code(() => store.createPlaylist(a.id, 42)), 'bad-playlist-name');
  const pl = store.createPlaylist(a.id, 'L');
  for (const bad of ['short', '"><script>xx', null, 42, V1 + 'x']) {
    assert.equal(code(() => store.addToPlaylist(a.id, pl.id, { v: bad, title: 't', start: 0 })), 'bad-video', String(bad));
  }
  store.addToPlaylist(a.id, pl.id, { v: V1, title: 'T‮​itle\n' + 'x'.repeat(500), start: -5 });
  const item = store.listPlaylists(a.id)[0].items[0];
  assert.ok(item.title.startsWith('Title x'), 'invisible characters stripped');
  assert.equal([...item.title].length, 150, 'titles are capped');
  assert.equal(item.start, 0, 'bad start time clamped');
  assert.equal(code(() => store.addToPlaylist(a.id, pl.id, { v: V1, title: 'again', start: 0 })), 'already-in-playlist');
  store.addToPlaylist(a.id, pl.id, { v: V2, title: '', start: 0 });
  assert.equal(store.listPlaylists(a.id)[0].items[1].title, 'YouTube video', 'missing title gets a placeholder');
  for (let i = store.listPlaylists(a.id).length; i < PLAYLIST_LIMITS.LISTS; i++) store.createPlaylist(a.id, `L${i}`);
  assert.equal(code(() => store.createPlaylist(a.id, 'one too many')), 'too-many-playlists');
});

test('a full playlist refuses more videos', () => {
  const { store, pair } = setup();
  const [a] = pair('Alex', 'Bo');
  const pl = store.createPlaylist(a.id, 'Big');
  const id = (i) => `vid${String(i).padStart(8, '0')}`;
  for (let i = 0; i < PLAYLIST_LIMITS.ITEMS; i++) store.addToPlaylist(a.id, pl.id, { v: id(i), title: 't', start: 0 });
  assert.equal(code(() => store.addToPlaylist(a.id, pl.id, { v: 'zzzzzzzzzzz', title: 't', start: 0 })), 'playlist-full');
});

test('rename, delete, remove, reorder', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const pl = store.createPlaylist(a.id, 'Old');
  store.renamePlaylist(b.id, pl.id, 'New');
  assert.equal(store.listPlaylists(a.id)[0].name, 'New', 'partner can rename too');
  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'].map((v) => store.addToPlaylist(a.id, pl.id, { v, title: v, start: 0 }).id);
  const order = () => store.listPlaylists(a.id)[0].items.map((i) => i.v[0]).join('');
  assert.equal(order(), 'abc');
  store.moveInPlaylist(b.id, ids[2], -1);
  assert.equal(order(), 'acb');
  store.moveInPlaylist(a.id, ids[0], -1); // already first: no-op
  assert.equal(order(), 'acb');
  store.moveInPlaylist(a.id, ids[1], 1); // already last
  assert.equal(order(), 'acb');
  assert.equal(code(() => store.moveInPlaylist(a.id, ids[0], 5)), 'bad-request');
  store.removeFromPlaylist(b.id, ids[2]);
  assert.equal(order(), 'ab');
  store.deletePlaylist(b.id, pl.id);
  assert.deepEqual(store.listPlaylists(a.id), []);
});

test('proposals: only the other person can accept; either can decline/withdraw', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const { linkId, proposal } = store.propose(a.id, { v: V1, title: 'Song', start: 3 });
  assert.equal(store.proposalOf(linkId).id, proposal.id);
  assert.equal(code(() => store.closeProposal(a.id, proposal.id, { accept: true })), 'own-proposal');
  const done = store.closeProposal(b.id, proposal.id, { accept: true });
  assert.deepEqual([done.proposal.v, done.proposal.start], [V1, 3]);
  assert.equal(store.proposalOf(linkId), null);
  assert.equal(code(() => store.closeProposal(b.id, proposal.id, { accept: true })), 'proposal-gone', 'only once');

  const p2 = store.propose(b.id, { v: V2 }).proposal;
  store.closeProposal(b.id, p2.id, { accept: false }); // withdraw own
  assert.equal(store.proposalOf(linkId), null);
  const p3 = store.propose(b.id, { v: V2 }).proposal;
  store.closeProposal(a.id, p3.id, { accept: false }); // decline partner's
  assert.equal(store.proposalOf(linkId), null);
});

test('proposals: a newer suggestion replaces the old; stale ids fail', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const old = store.propose(a.id, { v: V1 }).proposal;
  const newer = store.propose(b.id, { v: V2 }).proposal;
  assert.equal(code(() => store.closeProposal(b.id, old.id, { accept: true })), 'proposal-gone');
  assert.equal(code(() => store.closeProposal(b.id, newer.id, { accept: true })), 'own-proposal');
  assert.equal(store.closeProposal(a.id, newer.id, { accept: true }).proposal.v, V2);
});

test('proposals from a playlist use the saved video, not anything the caller sends', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const pl = store.createPlaylist(a.id, 'L');
  const { id } = store.addToPlaylist(b.id, pl.id, { v: V1, title: 'Saved', start: 30 });
  const p = store.propose(a.id, { itemId: id, v: V2, title: 'sneaky', start: 999 }).proposal;
  assert.deepEqual([p.v, p.title, p.start, p.itemId], [V1, 'Saved', 30, id]);
});

test('proposals expire after a day', () => {
  const { store, pair, now } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const { linkId, proposal } = store.propose(a.id, { v: V1 });
  now.t += TTL.PROPOSAL + 1;
  assert.equal(store.proposalOf(linkId), null);
  assert.equal(code(() => store.closeProposal(b.id, proposal.id, { accept: true })), 'proposal-gone');
  store.purgeExpired();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM proposals').get().n, 0);
});

test('unlinking deletes the pair\'s playlists and proposal', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const pl = store.createPlaylist(a.id, 'L');
  store.addToPlaylist(a.id, pl.id, { v: V1, title: 't', start: 0 });
  store.propose(a.id, { v: V1 });
  store.unlink(b.id);
  for (const t of ['playlists', 'playlist_items', 'proposals']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test('deleting an account keeps the partner\'s data out of reach and removes theirs', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const pl = store.createPlaylist(a.id, 'L');
  store.addToPlaylist(b.id, pl.id, { v: V1, title: 't', start: 0 });
  store.deleteUser(b.id);
  for (const t of ['playlists', 'playlist_items', 'proposals']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test('playlists are in "download my data"', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const pl = store.createPlaylist(a.id, 'Movie night');
  store.addToPlaylist(b.id, pl.id, { v: V1, title: 'Song', start: 0 });
  const out = store.exportUser(a.id);
  assert.deepEqual(out.playlists, [{ name: 'Movie night', videos: [{ youtubeId: V1, title: 'Song', addedBy: 'Bo' }] }]);
});

test('a placeholder title is filled in once the real one is known, never overwriting a real title', () => {
  const { store, pair } = setup();
  const [a, b] = pair('Alex', 'Bo');
  const [c] = pair('Cy', 'Di');
  const pl = store.createPlaylist(a.id, 'L');
  store.addToPlaylist(a.id, pl.id, { v: V1, title: '', start: 0 });
  store.addToPlaylist(a.id, pl.id, { v: V2, title: 'Named already', start: 0 });
  const cpl = store.createPlaylist(c.id, 'Theirs');
  store.addToPlaylist(c.id, cpl.id, { v: V1, title: '', start: 0 });
  assert.equal(store.fillTitle(b.id, V1, 'Real title'), 1);
  assert.equal(store.fillTitle(b.id, V2, 'Overwrite?'), 0);
  assert.equal(store.fillTitle(b.id, V1, 'Again'), 0, 'only the placeholder is replaced');
  assert.equal(store.fillTitle(b.id, 'bad', 'x'), 0);
  assert.deepEqual(store.listPlaylists(a.id)[0].items.map((i) => i.title), ['Real title', 'Named already']);
  assert.equal(store.listPlaylists(c.id)[0].items[0].title, 'YouTube video', "other couples' lists untouched");
});
