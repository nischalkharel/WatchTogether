// In-memory rooms. Each room holds one authoritative playback state that every
// member's player follows. Pure apart from the injected clock and timers.
import { applyAction, clampPos, expectedPosition, isVideoId } from './public/sync.js';

export const LIMITS = Object.freeze({
  MAX_ROOMS: 20_000, // one per linked pair; memory guard only
  MAX_CLIENTS_PER_ROOM: 8, // two people, a few devices each
  HOLD_MAX_MS: 10_000, // one person's buffering can pause the room this long at most
  ACTION_SKEW_MS: 2000, // how far in the past a client may timestamp an action
  EMPTY_ROOM_TTL_MS: 10 * 60_000, // state is saved to disk, so idle rooms can leave memory
});

export const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function normalizeRoomId(id) {
  if (typeof id !== 'string') return null;
  const s = id.trim().toLowerCase();
  return ROOM_ID_RE.test(s) ? s : null;
}

export class Room {
  // initial: saved { v, playing, pos } to resume from (e.g. after a restart).
  constructor(id, now = Date.now, initial = null) {
    this.id = id;
    this.now = now;
    this.state = { v: null, playing: false, pos: 0, at: now(), hold: [], seq: 0 };
    if (initial && isVideoId(initial.v)) {
      this.state = { ...this.state, v: initial.v, playing: !!initial.playing, pos: clampPos(initial.pos) };
    }
    this.clients = new Set();
    this.holdTimers = new Map();
    this.emptySince = now();
  }

  snapshot() {
    return { ...this.state, hold: [...this.state.hold] };
  }

  // Start a new video for both. Only called by the server once a proposal is
  // accepted; clients can't send 'load' themselves.
  load(v, pos) {
    return this.apply({ type: 'load', v, pos, playing: true }, this.now());
  }

  // Validate and apply a play / pause / seek from a client. Returns true if
  // state changed. A new video can't be started this way (see load()).
  action(raw, clientAt) {
    if (!raw || typeof raw !== 'object' || raw.type === 'load') return false;
    return this.apply(raw, clientAt);
  }

  apply(raw, clientAt) {
    if (!raw || typeof raw !== 'object') return false;
    const type = raw.type;
    const now = this.now();
    let at = Number(clientAt);
    if (!Number.isFinite(at) || at > now || at < now - LIMITS.ACTION_SKEW_MS) at = now;

    let a;
    if (type === 'load') {
      if (!isVideoId(raw.v)) return false;
      a = { type, v: raw.v, pos: clampPos(raw.pos), playing: raw.playing !== false };
    } else if (type === 'play' || type === 'pause' || type === 'seek') {
      if (!this.state.v) return false;
      a = { type, pos: clampPos(raw.pos) };
    } else {
      return false;
    }
    this.clearHolds();
    this.state = { ...applyAction(this.state, a, at), seq: this.state.seq + 1 };
    return true;
  }

  // A member started/stopped buffering. While anyone is held, the room clock
  // freezes so nobody runs ahead. Returns true if state changed.
  buffer(clientId, on) {
    const s = this.state;
    const holding = s.hold.includes(clientId);
    if (on) {
      if (holding || !s.v || !s.playing) return false;
      this.freeze();
      this.state = { ...this.state, hold: [...this.state.hold, clientId], seq: s.seq + 1 };
      return true;
    }
    if (!holding) return false;
    this.release(clientId);
    return true;
  }

  // Pin pos to "now" so later holds/releases don't double-count elapsed time.
  freeze() {
    const now = this.now();
    this.state = { ...this.state, pos: expectedPosition(this.state, now), at: now };
  }

  release(clientId) {
    const t = this.holdTimers.get(clientId);
    if (t) t.cancel();
    this.holdTimers.delete(clientId);
    if (!this.state.hold.includes(clientId)) return false;
    this.freeze();
    this.state = {
      ...this.state,
      hold: this.state.hold.filter((h) => h !== clientId),
      seq: this.state.seq + 1,
    };
    return true;
  }

  clearHolds() {
    for (const t of this.holdTimers.values()) t.cancel();
    this.holdTimers.clear();
    if (this.state.hold.length) this.freeze();
    this.state = { ...this.state, hold: [] };
  }

  setHoldTimer(clientId, cancel) {
    this.holdTimers.set(clientId, { cancel });
  }

  join(client) {
    this.clients.add(client);
    this.emptySince = 0;
  }

  // Returns true if room state changed (the leaver was holding playback).
  leave(client) {
    this.clients.delete(client);
    if (!this.clients.size) this.emptySince = this.now();
    return this.release(client.id);
  }
}

export class Rooms {
  constructor(now = Date.now) {
    this.now = now;
    this.map = new Map();
  }

  get(id, initial = null) {
    let room = this.map.get(id);
    if (!room) {
      if (this.map.size >= LIMITS.MAX_ROOMS) this.sweep();
      if (this.map.size >= LIMITS.MAX_ROOMS) return null;
      room = new Room(id, this.now, initial);
      this.map.set(id, room);
    }
    return room;
  }

  // Forget a room for good (the pair unlinked). Live handlers check `gone`.
  delete(id) {
    const room = this.map.get(id);
    if (room) {
      room.gone = true;
      room.clearHolds();
      clearTimeout(room.saveTimer);
    }
    this.map.delete(id);
  }

  // Drop rooms that have been empty for a long time.
  sweep() {
    const now = this.now();
    for (const [id, room] of this.map) {
      if (!room.clients.size && now - room.emptySince > LIMITS.EMPTY_ROOM_TTL_MS) this.map.delete(id);
    }
  }
}
