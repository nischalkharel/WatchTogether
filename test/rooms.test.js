import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, Room, Rooms, normalizeRoomId } from '../rooms.js';
import { expectedPosition } from '../public/sync.js';

const V = 'dQw4w9WgXcQ';

function fakeClock(t = 1_000_000) {
  const c = () => c.t;
  c.t = t;
  return c;
}

test('normalizeRoomId', () => {
  assert.equal(normalizeRoomId('Cozy-Mango-1234'), 'cozy-mango-1234');
  assert.equal(normalizeRoomId(' abc '), 'abc');
  assert.equal(normalizeRoomId('-abc'), null);
  assert.equal(normalizeRoomId('a b'), null);
  assert.equal(normalizeRoomId('../etc'), null);
  assert.equal(normalizeRoomId('x'.repeat(41)), null);
  assert.equal(normalizeRoomId(null), null);
});

test('room starts empty and rejects play before a video is loaded', () => {
  const room = new Room('r', fakeClock());
  assert.equal(room.state.v, null);
  assert.equal(room.action({ type: 'play', pos: 0 }), false);
  assert.equal(room.state.seq, 0);
});

test('load / pause / seek / play update state and seq', () => {
  const now = fakeClock();
  const room = new Room('r', now);
  assert.ok(room.load(V, 3));
  assert.deepEqual({ ...room.state }, { v: V, playing: true, pos: 3, at: now.t, hold: [], seq: 1 });
  now.t += 5000;
  assert.equal(expectedPosition(room.state, now()), 8);
  assert.ok(room.action({ type: 'pause', pos: 8 }, now()));
  assert.equal(room.state.playing, false);
  now.t += 5000;
  assert.equal(expectedPosition(room.state, now()), 8, 'paused does not advance');
  assert.ok(room.action({ type: 'seek', pos: 100 }, now()));
  assert.equal(room.state.pos, 100);
  assert.equal(room.state.playing, false);
  assert.ok(room.action({ type: 'play', pos: 100 }, now()));
  assert.equal(room.state.seq, 4);
});

test('clients cannot start a new video; only the server can (after an accepted proposal)', () => {
  const room = new Room('r', fakeClock());
  assert.equal(room.action({ type: 'load', v: V, pos: 0 }), false);
  assert.equal(room.state.v, null);
  assert.equal(room.load(V, 42), true);
  assert.equal(room.state.v, V);
  assert.equal(room.state.playing, true);
  assert.equal(room.state.pos, 42);
  assert.equal(room.action({ type: 'load', v: 'jNQXAC9IVRw', pos: 0 }), false, 'nor switch to another one');
  assert.equal(room.state.v, V);
});

test('a room can start from saved state (after a restart)', () => {
  const room = new Room('r', fakeClock(), { v: V, playing: false, pos: 42 });
  assert.deepEqual([room.state.v, room.state.playing, room.state.pos], [V, false, 42]);
  assert.equal(new Room('r', fakeClock(), { v: 'bad', playing: true, pos: 1 }).state.v, null, 'bad saved data ignored');
});

test('invalid actions are rejected', () => {
  const room = new Room('r', fakeClock());
  assert.equal(room.load('nope', 0), false);
  assert.equal(room.load('<script>xx', 0), false);
  assert.equal(room.action(null), false);
  assert.equal(room.action('play'), false);
  assert.equal(room.action({ type: 'explode' }), false);
  room.load(V, 0);
  room.action({ type: 'seek', pos: 'abc' });
  assert.equal(room.state.pos, 0, 'non-numeric pos becomes 0');
  room.action({ type: 'seek', pos: -50 });
  assert.equal(room.state.pos, 0);
});

test('client timestamps are only trusted within a small window', () => {
  const now = fakeClock();
  const room = new Room('r', now);
  room.load(V, 0);
  room.action({ type: 'pause', pos: 0 }, now.t - 500);
  assert.equal(room.state.at, now.t - 500, 'recent past timestamp kept for latency compensation');
  room.action({ type: 'play', pos: 0 }, now.t + 10_000);
  assert.equal(room.state.at, now.t, 'future timestamp replaced');
  room.action({ type: 'play', pos: 0 }, now.t - LIMITS.ACTION_SKEW_MS - 1);
  assert.equal(room.state.at, now.t, 'very old timestamp replaced');
  room.action({ type: 'play', pos: 0 }, 'garbage');
  assert.equal(room.state.at, now.t);
});

test('buffer hold freezes the room clock and release resumes it', () => {
  const now = fakeClock();
  const room = new Room('r', now);
  room.load(V, 0);
  now.t += 10_000;
  assert.ok(room.buffer('a', true));
  assert.deepEqual(room.state.hold, ['a']);
  assert.equal(room.state.pos, 10);
  now.t += 3000;
  assert.equal(expectedPosition(room.state, now()), 10, 'frozen while held');
  assert.equal(room.buffer('a', true), false, 'double hold ignored');
  assert.ok(room.buffer('b', true));
  assert.ok(room.buffer('a', false));
  now.t += 3000;
  assert.equal(expectedPosition(room.state, now()), 10, 'still held by b');
  assert.ok(room.buffer('b', false));
  assert.equal(room.state.pos, 10);
  now.t += 2000;
  assert.equal(expectedPosition(room.state, now()), 12);
  assert.equal(room.buffer('b', false), false, 'release when not held is a no-op');
});

test('buffer hold is ignored when paused or empty', () => {
  const room = new Room('r', fakeClock());
  assert.equal(room.buffer('a', true), false);
  room.load(V, 0);
  room.action({ type: 'pause', pos: 0 });
  assert.equal(room.buffer('a', true), false);
});

test('any user action clears holds and cancels timers', () => {
  const now = fakeClock();
  const room = new Room('r', now);
  room.load(V, 0);
  room.buffer('a', true);
  let cancelled = 0;
  room.setHoldTimer('a', () => cancelled++);
  room.action({ type: 'seek', pos: 30 }, now());
  assert.deepEqual(room.state.hold, []);
  assert.equal(cancelled, 1);
});

test('leaving releases that member\'s hold', () => {
  const now = fakeClock();
  const room = new Room('r', now);
  const a = { id: 'a' };
  room.join(a);
  room.load(V, 0);
  room.buffer('a', true);
  assert.equal(room.leave(a), true);
  assert.deepEqual(room.state.hold, []);
  assert.equal(room.clients.size, 0);
  assert.equal(room.emptySince, now.t);
});

test('Rooms caps total rooms and sweeps old empty ones', () => {
  const now = fakeClock();
  const rooms = new Rooms(now);
  for (let i = 0; i < LIMITS.MAX_ROOMS; i++) assert.ok(rooms.get(`r${i}`));
  assert.equal(rooms.get('overflow'), null);
  now.t += LIMITS.EMPTY_ROOM_TTL_MS + 1;
  assert.ok(rooms.get('overflow'), 'old empty rooms are evicted');
  assert.equal(rooms.get('r0') === rooms.get('r0'), true);
});

test('snapshot is a copy', () => {
  const room = new Room('r', fakeClock());
  room.load(V, 0);
  room.buffer('a', true);
  const snap = room.snapshot();
  snap.hold.push('zzz');
  assert.deepEqual(room.state.hold, ['a']);
});
