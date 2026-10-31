import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../public/controller.js';
import { Room } from '../rooms.js';
import { YT_STATE as S } from '../public/sync.js';

const V = 'dQw4w9WgXcQ';
const V2 = 'aaaaaaaaaaa';

// Simulated YouTube player driven by a shared fake clock.
class FakePlayer {
  constructor(clock, { duration = 300 } = {}) {
    this.clock = clock;
    this.dur = duration;
    this.st = S.UNSTARTED;
    this.t = 0;
    this.base = clock.t;
    this.calls = [];
    this.onState = () => {};
    this.blockAutoplay = false;
  }
  advance() {
    const dt = (this.clock.t - this.base) / 1000;
    this.base = this.clock.t;
    if (this.st === S.PLAYING) {
      this.t = Math.min(this.dur, this.t + dt);
      if (this.t >= this.dur) {
        this.st = S.ENDED;
        this.onState(S.ENDED);
      }
    }
  }
  set(st) {
    this.advance();
    if (this.st === st) return;
    this.st = st;
    this.onState(st);
  }
  getPlayerState() { this.advance(); return this.st; }
  getCurrentTime() { this.advance(); return this.t; }
  getDuration() { return this.st === S.UNSTARTED ? 0 : this.dur; }
  seekTo(t) { this.advance(); this.calls.push(['seek', t]); this.t = t; }
  playVideo() {
    this.calls.push(['play']);
    if (!this.blockAutoplay || this.muted) this.set(S.PLAYING);
    else if (this.st !== S.UNSTARTED && this.st !== S.CUED) this.set(S.PAUSED);
  }
  mute() { this.muted = true; }
  pauseVideo() { this.calls.push(['pause']); this.set(S.PAUSED); }
  loadVideoById(o) {
    this.calls.push(['load', o.videoId, o.startSeconds]);
    this.t = o.startSeconds;
    this.st = S.UNSTARTED;
    if (!this.blockAutoplay || this.muted) this.set(S.PLAYING);
    else setTimeout(() => this.set(S.PAUSED), 0); // iOS: refuses, reports paused
  }
  cueVideoById(o) { this.calls.push(['cue', o.videoId, o.startSeconds]); this.t = o.startSeconds; this.set(S.CUED); }
  // User interactions on YouTube's own UI:
  userScrub(t) { this.advance(); this.t = t; }
}

function clock(t = 1_000_000) {
  const c = () => c.t;
  c.t = t;
  return c;
}

// A room on a "server", plus N clients that talk to it synchronously.
function harness(n = 2, opts = {}) {
  const now = clock();
  const room = new Room('t', now);
  const clients = [];
  const sent = [];
  for (let i = 0; i < n; i++) {
    const player = new FakePlayer(now, opts);
    const c = {
      id: `c${i}`,
      player,
      hidden: false,
      blocked: [],
    };
    c.ctl = new Controller({
      player,
      now,
      serverNow: now,
      isHidden: () => c.hidden,
      onBlocked: (b) => c.blocked.push(b),
      send: (msg) => {
        sent.push({ from: c.id, msg });
        let changed = false;
        if (msg.type === 'action') changed = room.action(msg.action, msg.at);
        if (msg.type === 'buffer') changed = room.buffer(c.id, msg.on);
        if (changed) for (const o of clients) o.ctl.setState(room.snapshot());
      },
    });
    player.onState = (st) => c.ctl.onPlayerState(st);
    c.ctl.setMe(c.id);
    c.ctl.setState(room.snapshot());
    c.ctl.setReady();
    clients.push(c);
  }
  const step = (ms, every = 500) => {
    for (let t = 0; t < ms; t += every) {
      now.t += every;
      for (const c of clients) c.ctl.tick();
    }
  };
  // Both agreed on a video (a proposal was accepted): the room starts it for all.
  const agree = (v, start = 0) => {
    if (room.load(v, start)) for (const o of clients) o.ctl.setState(room.snapshot());
  };
  return { now, room, clients, sent, step, agree };
}

function times(clients) {
  return clients.map((c) => c.player.getCurrentTime());
}

function assertInSync(clients, tolerance = 0.7) {
  const t = times(clients);
  const spread = Math.max(...t) - Math.min(...t);
  assert.ok(spread <= tolerance, `players out of sync: ${t.join(', ')}`);
}

test('loading a video starts it on every client', () => {
  const { clients, step, agree } = harness();
  agree(V, 0);
  step(1000);
  for (const c of clients) {
    assert.equal(c.player.getPlayerState(), S.PLAYING);
    assert.ok(c.player.calls.some((x) => x[0] === 'load' && x[1] === V));
  }
  step(5000);
  assertInSync(clients);
  assert.ok(Math.abs(clients[1].player.getCurrentTime() - 6) < 0.7);
});

test('pause via our controls pauses everyone at the same spot', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(10_000);
  clients[1].ctl.pause();
  step(1000);
  for (const c of clients) assert.equal(c.player.getPlayerState(), S.PAUSED);
  assert.equal(room.state.playing, false);
  assertInSync(clients, 0.35);
  step(5000);
  assertInSync(clients, 0.35);
  assert.ok(Math.abs(clients[0].player.getCurrentTime() - room.state.pos) < 0.35);
});

test('pause on the YouTube player itself is detected and shared', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(5000);
  clients[0].player.set(S.PAUSED); // user clicked YouTube's pause
  step(1000);
  assert.equal(room.state.playing, false);
  assert.equal(clients[1].player.getPlayerState(), S.PAUSED);
});

test('play on the YouTube player itself is detected and shared', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(2000);
  clients[0].ctl.pause();
  step(3000);
  clients[1].player.set(S.PLAYING); // user clicked YouTube's play on the other device
  step(1000);
  assert.equal(room.state.playing, true);
  assert.equal(clients[0].player.getPlayerState(), S.PLAYING);
  step(3000);
  assertInSync(clients);
});

test('play on YouTube\'s own controls that buffers first is still shared', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(2000);
  clients[0].ctl.pause();
  step(3000);
  clients[1].player.set(S.BUFFERING); // YouTube: play -> buffering -> playing
  step(500);
  clients[1].player.set(S.PLAYING);
  step(1000);
  assert.equal(room.state.playing, true);
  assert.equal(clients[0].player.getPlayerState(), S.PLAYING);
  assert.equal(clients[1].player.getPlayerState(), S.PLAYING);
});

test('a paused player that buffers after OUR corrective seek does not start the room', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(2000);
  clients[0].ctl.pause();
  step(1000);
  // Knock client 1 out of position so the app seeks it; YouTube sometimes
  // shows BUFFERING while loading the new spot, even when paused.
  clients[1].player.t += 5;
  clients[1].ctl.sample = null;
  const origSeek = clients[1].player.seekTo.bind(clients[1].player);
  clients[1].player.seekTo = (t) => {
    origSeek(t);
    clients[1].player.set(S.BUFFERING);
    clients[1].player.set(S.PAUSED);
  };
  step(3000);
  assert.equal(room.state.playing, false, 'room stayed paused');
  assert.equal(room.state.seq, 2);
});

test('a slow-buffering play on YouTube\'s controls right after our seek is still shared', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(2000);
  clients[0].ctl.pause();
  step(200); // client 1 just got corrected (paused + seeked)
  clients[1].player.set(S.BUFFERING); // user presses play; slow network
  step(2500);
  assert.equal(clients[1].player.calls.filter((c) => c[0] === 'pause').length <= 1, true, 'not re-paused while loading');
  clients[1].player.set(S.PLAYING);
  step(1000);
  assert.equal(room.state.playing, true);
  assert.equal(clients[0].player.getPlayerState(), S.PLAYING);
});

test('skip with our buttons moves everyone', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(4000);
  clients[1].ctl.skip(10);
  step(1000);
  assert.ok(room.state.pos >= 13.5 && room.state.pos <= 14.5, `pos ${room.state.pos}`);
  assertInSync(clients);
  assert.ok(clients[0].player.getCurrentTime() > 13);
  clients[0].ctl.skip(-100);
  step(500);
  assert.ok(room.state.pos === 0);
  assertInSync(clients);
});

test('scrubbing on the YouTube player itself is detected and shared', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(5000);
  clients[1].player.userScrub(120);
  step(1000);
  assert.ok(Math.abs(room.state.pos - 120) < 1, `room pos ${room.state.pos}`);
  assert.ok(clients[0].player.getCurrentTime() > 119);
  step(5000);
  assertInSync(clients);
});

test('a user pause right after one of our drift corrections is not lost', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(5000);
  clients[1].player.t -= 3; // drifted; next tick the app seeks to fix it
  clients[1].ctl.sample = null;
  step(500);
  assert.ok(clients[1].player.calls.some((c) => c[0] === 'seek'), 'correction happened');
  clients[1].player.set(S.PAUSED); // user hits YouTube's own pause immediately after
  step(1500);
  assert.equal(room.state.playing, false, 'pause was shared');
  assert.equal(clients[0].player.getPlayerState(), S.PAUSED);
});

test('a user pause right after a video loads is not lost', () => {
  const { clients, step, room, now, agree } = harness();
  agree(V, 0);
  now.t += 300;
  clients[1].player.set(S.PAUSED); // pause within the first second
  step(1000);
  assert.equal(room.state.playing, false);
  assert.equal(clients[0].player.getPlayerState(), S.PAUSED);
});

test('a user play right after one of our corrective pauses is not lost', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(3000);
  clients[0].ctl.pause();
  step(500); // client 1 was told to pause
  clients[1].player.set(S.PLAYING); // user presses YouTube's play straight away
  step(1000);
  assert.equal(room.state.playing, true);
  assert.equal(clients[0].player.getPlayerState(), S.PLAYING);
});

test('a scrub that pauses briefly (PAUSED then BUFFERING) is a seek, not a pause', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(5000);
  // Desktop YouTube fires PAUSED -> BUFFERING -> PLAYING when you click the bar.
  clients[0].player.set(S.PAUSED);
  clients[0].player.userScrub(60);
  clients[0].player.set(S.BUFFERING);
  step(100, 100);
  clients[0].player.set(S.PLAYING);
  step(1500);
  assert.equal(room.state.playing, true, 'room was not paused');
  assert.ok(Math.abs(room.state.pos - 60) < 2, `pos ${room.state.pos}`);
  step(3000);
  assertInSync(clients);
});

test('seeking while paused stays paused for everyone', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(3000);
  clients[0].ctl.pause();
  step(1000);
  clients[1].ctl.seek(200);
  step(1500);
  assert.equal(room.state.playing, false);
  for (const c of clients) {
    assert.equal(c.player.getPlayerState(), S.PAUSED);
    assert.ok(Math.abs(c.player.getCurrentTime() - 200) < 0.35);
  }
});

test('drift is corrected', () => {
  const { clients, step, agree } = harness();
  agree(V, 0);
  step(3000);
  // Simulate a player that silently fell behind (e.g. a stall the API didn't report).
  clients[1].player.t -= 3;
  clients[1].ctl.sample = null; // not a user scrub
  step(3000);
  assertInSync(clients);
});

test('small drift is tolerated (no seek spam)', () => {
  const { clients, step, agree } = harness();
  agree(V, 0);
  step(3000);
  const before = clients[1].player.calls.filter((c) => c[0] === 'seek').length;
  clients[1].player.t -= 0.3;
  clients[1].ctl.sample = null;
  step(5000);
  const after = clients[1].player.calls.filter((c) => c[0] === 'seek').length;
  assert.equal(after, before);
});

test('a long buffer makes the room wait, then everyone resumes together', () => {
  const { clients, step, room, sent, agree } = harness();
  agree(V, 0);
  step(5000);
  clients[1].player.set(S.BUFFERING); // client 1's connection is slow
  step(2000);
  assert.deepEqual(room.state.hold, ['c1']);
  assert.ok(sent.some((s) => s.from === 'c1' && s.msg.type === 'buffer' && s.msg.on));
  step(500);
  assert.equal(clients[0].player.getPlayerState(), S.PAUSED, 'partner waits');
  const frozen = clients[0].player.getCurrentTime();
  step(3000);
  assert.ok(Math.abs(clients[0].player.getCurrentTime() - frozen) < 0.01);
  clients[1].player.set(S.PLAYING); // caught up
  step(1000);
  assert.deepEqual(room.state.hold, []);
  assert.equal(clients[0].player.getPlayerState(), S.PLAYING);
  step(3000);
  assertInSync(clients);
});

test('short buffering blips do not interrupt the partner', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(3000);
  clients[1].player.set(S.BUFFERING);
  step(1000);
  clients[1].player.set(S.PLAYING);
  step(2000);
  assert.equal(room.state.seq, 1, 'no hold, no extra state changes');
  assert.equal(clients[0].player.calls.filter((c) => c[0] === 'pause').length, 0);
});

test('our own commands never echo back as user actions', () => {
  const { clients, step, room, agree } = harness(3);
  agree(V, 0);
  step(3000);
  clients[0].ctl.pause();
  step(2000);
  clients[0].ctl.play();
  step(2000);
  clients[2].ctl.seek(50);
  step(5000);
  // 4 user actions => exactly 4 state changes, no feedback loops.
  assert.equal(room.state.seq, 4);
  assertInSync(clients);
});

test('a late joiner lands at the right spot', () => {
  const { clients, step, now, room, agree } = harness(1);
  agree(V, 30);
  step(20_000);
  const p = new FakePlayer(now);
  const late = new Controller({ player: p, now, serverNow: now, send: () => {} });
  p.onState = (st) => late.onPlayerState(st);
  late.setMe('late');
  late.setState(room.snapshot());
  late.setReady();
  for (let i = 0; i < 4; i++) {
    now.t += 500;
    late.tick();
    clients[0].ctl.tick();
  }
  assert.equal(p.getPlayerState(), S.PLAYING);
  assert.ok(Math.abs(p.getCurrentTime() - clients[0].player.getCurrentTime()) < 0.7);
});

test('a late joiner to a paused room cues the video without playing', () => {
  const { clients, step, now, room, agree } = harness(1);
  agree(V, 0);
  step(3000);
  clients[0].ctl.pause();
  step(500);
  const p = new FakePlayer(now);
  const late = new Controller({ player: p, now, serverNow: now, send: () => {} });
  late.setState(room.snapshot());
  late.setReady();
  assert.equal(p.calls[0][0], 'cue');
  assert.ok(Math.abs(p.calls[0][2] - room.state.pos) < 0.01);
  now.t += 2000;
  late.tick();
  assert.equal(p.calls.filter((c) => c[0] === 'play').length, 0);
});

test('changing video switches everyone', () => {
  const { clients, step, agree } = harness();
  agree(V, 0);
  step(3000);
  agree(V2, 10);
  step(1000);
  for (const c of clients) assert.ok(c.player.calls.some((x) => x[0] === 'load' && x[1] === V2));
  assertInSync(clients);
});

test('a hidden (backgrounded) client does not broadcast its forced pause', () => {
  const { clients, step, room, agree } = harness();
  agree(V, 0);
  step(3000);
  clients[1].hidden = true;
  clients[1].player.set(S.PAUSED); // iOS pauses media when the screen locks
  step(3000);
  assert.equal(room.state.playing, true, 'partner keeps watching');
  assert.equal(clients[0].player.getPlayerState(), S.PLAYING);
  clients[1].hidden = false;
  clients[1].ctl.resync();
  step(1500);
  assert.equal(clients[1].player.getPlayerState(), S.PLAYING);
  assertInSync(clients);
});

test('blocked autoplay is reported so the UI can react', () => {
  const { clients, step, now, agree } = harness(1);
  clients[0].player.blockAutoplay = true;
  agree(V, 0);
  step(4000);
  assert.deepEqual(clients[0].blocked, [true]);
  clients[0].player.blockAutoplay = false;
  clients[0].player.playVideo();
  now.t += 500;
  clients[0].ctl.tick();
  assert.deepEqual(clients[0].blocked, [true, false]);
});

test('iPhone-style autoplay refusal never pauses the room, and muted fallback syncs', async () => {
  const { clients, step, room, agree } = harness();
  clients[1].player.blockAutoplay = true;
  clients[1].ctl.onBlocked = (b) => {
    clients[1].blocked.push(b);
    if (b) {
      clients[1].player.mute();
      clients[1].player.playVideo();
    }
  };
  agree(V, 0);
  await new Promise((r) => setTimeout(r, 5)); // let the async PAUSED fire
  step(6000);
  assert.equal(room.state.playing, true, 'room still playing');
  assert.equal(room.state.seq, 1, 'no pause was broadcast');
  assert.deepEqual(clients[1].blocked, [true, false]);
  assert.equal(clients[1].player.getPlayerState(), S.PLAYING);
  assertInSync(clients);
});

test('a video that reaches its end does not loop', () => {
  const { clients, step, agree } = harness(2, { duration: 20 });
  agree(V, 0);
  step(25_000);
  for (const c of clients) {
    assert.equal(c.player.getPlayerState(), S.ENDED);
    assert.equal(c.player.calls.filter((x) => x[0] === 'play').length, 0);
  }
});

test('seek clamps to just before the end', () => {
  const { clients, step, room, agree } = harness(2, { duration: 100 });
  agree(V, 0);
  step(1000);
  clients[0].ctl.seek(5000);
  assert.ok(room.state.pos < 100 && room.state.pos > 99);
});

test('actions before any video are ignored', () => {
  const { clients, room, agree } = harness();
  clients[0].ctl.play();
  clients[0].ctl.pause();
  clients[0].ctl.seek(10);
  assert.equal(room.state.seq, 0);
});
