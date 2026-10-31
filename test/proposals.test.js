// Playlists and "watch this?" over the real server: the accept rule, live
// updates to both partners, and attempts to get around them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const V1 = 'dQw4w9WgXcQ';
const V2 = 'jNQXAC9IVRw';
let h;
before(async () => {
  h = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
});
after(() => h.close());

const isState = (m) => m.type === 'state';
const isProposal = (m) => m.type === 'proposal';

async function connected() {
  const [a, b] = await h.couple();
  const sa = await a.ws();
  const sb = await b.ws();
  const wa = await sa.next((m) => m.type === 'welcome');
  await sb.next((m) => m.type === 'welcome');
  return { a, b, sa, sb, wa, close: () => Promise.all([sa.close(), sb.close()]) };
}

test('a suggestion does not start anything until the partner accepts', async () => {
  const c = await connected();
  const r = await c.a.post('/api/propose', { v: V1, title: 'Song', start: 12 });
  assert.equal(r.status, 200);
  assert.equal(r.body.proposal.mine, true);
  // Both see it; for Bo it's "theirs" (so Bo gets the Accept button).
  assert.equal((await c.sa.next(isProposal)).proposal.mine, true);
  const seen = (await c.sb.next(isProposal)).proposal;
  assert.deepEqual([seen.v, seen.title, seen.start, seen.mine], [V1, 'Song', 12, false]);
  await assert.rejects(c.sb.next(isState, 400), 'nothing plays yet');

  assert.equal((await c.b.post('/api/proposal/accept', { id: seen.id })).status, 200);
  const st = await c.sb.next(isState);
  assert.deepEqual([st.state.v, st.state.pos, st.state.playing, st.kind], [V1, 12, true, 'load']);
  assert.equal((await c.sa.next(isState)).state.v, V1, 'starts for both together');
  assert.equal((await c.sb.next(isProposal)).proposal, null, 'suggestion cleared for both');
  assert.equal((await c.sa.next(isProposal)).proposal, null);
  await c.close();
});

test('you cannot accept your own suggestion', async () => {
  const c = await connected();
  const { proposal } = (await c.a.post('/api/propose', { v: V1 })).body;
  const r = await c.a.post('/api/proposal/accept', { id: proposal.id });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'own-proposal');
  await assert.rejects(c.sa.next(isState, 300));
  await c.close();
});

test('there is no way around accepting: direct "load" messages are ignored', async () => {
  const c = await connected();
  c.sa.send({ type: 'action', action: { type: 'load', v: V1, pos: 0, playing: true }, at: Date.now() });
  c.sa.send({ type: 'load', v: V1 });
  c.sa.send({ type: 'action', action: { type: 'seek', pos: 10 } }); // no video yet: nothing to seek
  await assert.rejects(c.sb.next(isState, 400));
  // And once a video is playing, you still can't swap it out unilaterally.
  const { proposal } = (await c.a.post('/api/propose', { v: V1 })).body;
  await c.b.post('/api/proposal/accept', { id: proposal.id });
  await c.sb.next(isState);
  c.sa.send({ type: 'action', action: { type: 'load', v: V2, pos: 0 } });
  await assert.rejects(c.sb.next((m) => isState(m) && m.state.v === V2, 400));
  await c.close();
});

test('declining or withdrawing tells both, and nothing plays', async () => {
  const c = await connected();
  let { proposal } = (await c.a.post('/api/propose', { v: V1, title: 'Song' })).body;
  await c.sb.next(isProposal);
  await c.b.post('/api/proposal/decline', { id: proposal.id });
  const closed = await c.sa.next((m) => m.type === 'proposal-closed');
  assert.deepEqual([closed.withdrawn, closed.byMe, closed.title], [false, false, 'Song'], 'Alex hears: Bo declined');
  const closedB = await c.sb.next((m) => m.type === 'proposal-closed');
  assert.deepEqual([closedB.withdrawn, closedB.byMe], [false, true], 'Bo hears: you declined');
  assert.equal((await c.sa.next((m) => isProposal(m) && m.proposal === null)).proposal, null);

  ({ proposal } = (await c.a.post('/api/propose', { v: V2 })).body);
  await c.a.post('/api/proposal/decline', { id: proposal.id }); // withdraw
  const w = await c.sb.next((m) => m.type === 'proposal-closed');
  assert.deepEqual([w.withdrawn, w.byMe], [true, false], 'Bo hears: Alex withdrew it');
  await assert.rejects(c.sb.next(isState, 300));
  await c.close();
});

test('a suggestion waits for a partner who is offline, and is there when they arrive', async () => {
  const [a, b] = await h.couple();
  const { proposal } = (await a.post('/api/propose', { v: V1, title: 'Later' })).body;
  const sb = await b.ws();
  const w = await sb.next((m) => m.type === 'welcome');
  assert.deepEqual([w.proposal.id, w.proposal.title, w.proposal.mine], [proposal.id, 'Later', false]);
  assert.equal(w.state.v, null, 'and nothing started on its own');
  await sb.close();
});

test('a suggestion survives a server restart', async () => {
  const app = await startApp({ env: { RATE_LIMIT_SCALE: '100' } });
  const [a, b] = await app.couple();
  const { proposal } = (await a.post('/api/propose', { v: V1 })).body;
  await app.restart();
  const sb = await b.ws();
  assert.equal((await sb.next((m) => m.type === 'welcome')).proposal.id, proposal.id);
  assert.equal((await b.post('/api/proposal/accept', { id: proposal.id })).status, 200);
  assert.equal((await sb.next(isState)).state.v, V1);
  await sb.close();
  await app.close();
});

test('playing from a playlist: suggest the saved item, partner accepts', async () => {
  const c = await connected();
  const pl = (await c.a.post('/api/playlists/create', { name: 'Movie night' })).body;
  const added = await c.b.post('/api/playlists/add', { playlist: pl.id, v: V2, title: 'Zoo', start: 4 });
  assert.equal(added.status, 200);
  const { proposal } = (await c.a.post('/api/propose', { item: added.body.id })).body;
  assert.deepEqual([proposal.v, proposal.title, proposal.start, proposal.fromItem], [V2, 'Zoo', 4, true]);
  await c.b.post('/api/proposal/accept', { id: proposal.id });
  assert.equal((await c.sa.next(isState)).state.v, V2);
  await c.close();
});

test('playlist changes reach the partner live', async () => {
  const c = await connected();
  const pl = (await c.a.post('/api/playlists/create', { name: 'L' })).body;
  assert.equal((await c.sb.next((m) => m.type === 'playlists')).type, 'playlists');
  await c.a.post('/api/playlists/add', { playlist: pl.id, v: V1, title: 't' });
  await c.sb.next((m) => m.type === 'playlists');
  const lists = (await c.b.get('/api/playlists')).body.playlists;
  assert.equal(lists[0].items[0].v, V1);
  assert.equal(lists[0].items[0].addedBy, 'Alex');
  await c.close();
});

test('another couple can\'t see, change or play from our playlists', async () => {
  const [a, b] = await h.couple(['Alex', 'Bo']);
  const [c] = await h.couple(['Cy', 'Di']);
  const pl = (await a.post('/api/playlists/create', { name: 'Private' })).body;
  const item = (await a.post('/api/playlists/add', { playlist: pl.id, v: V1, title: 'Ours' })).body;
  assert.deepEqual((await c.get('/api/playlists')).body.playlists, []);
  for (const [path, body] of [
    ['/api/playlists/add', { playlist: pl.id, v: V2 }],
    ['/api/playlists/rename', { id: pl.id, name: 'Hacked' }],
    ['/api/playlists/delete', { id: pl.id }],
    ['/api/playlists/remove', { item: item.id }],
    ['/api/playlists/move', { item: item.id, dir: 1 }],
    ['/api/propose', { item: item.id }],
  ]) {
    assert.equal((await c.post(path, body)).status, 404, path);
  }
  // And they can't answer our suggestion.
  const { proposal } = (await a.post('/api/propose', { v: V1 })).body;
  assert.equal((await c.post('/api/proposal/accept', { id: proposal.id })).status, 404);
  assert.equal((await c.post('/api/proposal/decline', { id: proposal.id })).status, 404);
  const ours = (await b.get('/api/playlists')).body.playlists;
  assert.deepEqual([ours[0].name, ours[0].items.length], ['Private', 1]);
});

test('unlinked people get no playlists and cannot suggest', async () => {
  const lonely = await h.signedIn(`lonely-${Math.random()}`, 'Lonely');
  assert.equal((await lonely.get('/api/playlists')).body.error, 'not-linked');
  assert.equal((await h.browser().get('/api/playlists')).status, 401, 'signed out: nothing');
  assert.equal((await lonely.get('/api/playlists', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await lonely.post('/api/propose', { v: V1 })).body.error, 'not-linked');
});

test('playlist and suggestion calls need the CSRF token and same-site origin', async () => {
  const [a] = await h.couple();
  assert.equal((await a.post('/api/playlists/create', { name: 'x' }, { csrf: 'nope' })).status, 403);
  assert.equal((await a.post('/api/propose', { v: V1 }, { origin: 'https://evil.example' })).status, 403);
});

test('a newer suggestion replaces an older one', async () => {
  const c = await connected();
  const first = (await c.a.post('/api/propose', { v: V1 })).body.proposal;
  const second = (await c.b.post('/api/propose', { v: V2 })).body.proposal;
  assert.equal((await c.b.post('/api/proposal/accept', { id: first.id })).body.error, 'proposal-gone');
  assert.equal((await c.a.post('/api/proposal/accept', { id: second.id })).status, 200);
  assert.equal((await c.sa.next(isState)).state.v, V2);
  await c.close();
});

test('unlinking clears the suggestion and the playlists', async () => {
  const [a, b] = await h.couple();
  const pl = (await a.post('/api/playlists/create', { name: 'L' })).body;
  await a.post('/api/playlists/add', { playlist: pl.id, v: V1 });
  await a.post('/api/propose', { v: V1 });
  await a.post('/api/unlink');
  const { linkPeople } = await import('./helpers.js');
  await linkPeople(a, b);
  assert.deepEqual((await a.get('/api/playlists')).body.playlists, [], 'a new link starts empty');
  const s = await b.ws();
  assert.equal((await s.next((m) => m.type === 'welcome')).proposal, null);
  await s.close();
});
