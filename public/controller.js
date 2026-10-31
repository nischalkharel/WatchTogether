// Keeps one local YouTube player in line with the shared room state and turns
// local player interactions into room actions. The player, transport and clocks
// are injected so this runs (and is tested) without a browser.
import { YT_STATE as S, SYNC, applyAction, clampPos, decide } from './sync.js';

const SUPPRESS_MS = 1200; // after our own seek, ignore position jumps this long
const EXPECT_MS = 1500; // how long a state change we asked for counts as ours
const PAUSE_DEBOUNCE_MS = 400; // a PAUSED that turns into BUFFERING/PLAYING is a scrub, not a pause
const PLAY_WAIT_MS = 4000; // how long a BUFFERING in a paused room may take to become PLAYING
const JUMP = 1.5; // seconds of unexplained movement that counts as a user seek
const BUFFER_REPORT_MS = 1500; // buffering this long makes the room wait for us
const BLOCKED_MS = 3000; // wanted to play this long without starting => needs a tap

export class Controller {
  // opts: { player, send(msg), serverNow(), now(), isHidden(), onBlocked(bool), onChange() }
  constructor(opts) {
    this.player = opts.player;
    this.send = opts.send;
    this.serverNow = opts.serverNow;
    this.now = opts.now || (() => Date.now());
    this.isHidden = opts.isHidden || (() => false);
    this.onBlocked = opts.onBlocked || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.me = null;
    this.rs = null; // room state
    this.ready = false;
    this.loadedId = null;
    this.suppressUntil = 0;
    this.seekQuietUntil = 0;
    // Commands we sent the player that it hasn't carried out yet (time sent).
    // The matching state change is ours; anything else is the user.
    this.issued = { play: -Infinity, pause: -Infinity };
    this.playStarted = true; // has the player reached PLAYING since our last play?
    this.lastSeekAt = -Infinity;
    this.lastPlayAt = -Infinity;
    this.sample = null; // last observed { t, at, state }
    this.pausePendingAt = 0;
    this.playPendingAt = 0; // room paused but player started buffering: maybe a user play
    this.bufferingSince = 0;
    this.bufferReported = false;
    this.wantPlaySince = 0;
    this.blocked = false;
  }

  setMe(id) {
    this.me = id;
  }

  setReady() {
    this.ready = true;
    this.sync();
  }

  // New authoritative state from the server.
  setState(rs) {
    this.rs = { ...rs, hold: rs.hold || [] };
    this.sync();
  }

  holders() {
    return (this.rs && this.rs.hold) || [];
  }

  // Should this player be playing right now?
  wantPlaying() {
    const rs = this.rs;
    if (!rs || !rs.v || !rs.playing) return false;
    return this.holders().every((h) => h === this.me);
  }

  // Where this player should be right now (seconds).
  expected() {
    const rs = this.rs;
    if (!rs) return 0;
    if (!rs.playing || this.holders().length) return rs.pos;
    return clampPos(rs.pos + Math.max(0, this.serverNow() - rs.at) / 1000);
  }

  state() {
    try {
      return this.player.getPlayerState();
    } catch {
      return S.UNSTARTED;
    }
  }

  current() {
    try {
      return Number(this.player.getCurrentTime()) || 0;
    } catch {
      return 0;
    }
  }

  duration() {
    try {
      return Number(this.player.getDuration()) || 0;
    } catch {
      return 0;
    }
  }

  suppressed() {
    return this.now() < this.suppressUntil;
  }

  // Ignore all player events for a while (used around loads and unmuting,
  // where the player may do arbitrary things on its own).
  suppress(ms = SUPPRESS_MS) {
    this.suppressUntil = Math.max(this.suppressUntil, this.now() + ms);
    this.sample = null;
    this.pausePendingAt = 0;
    this.playPendingAt = 0;
  }

  // Did we ask the player for this and it hasn't happened yet? Then the
  // event is ours, not the user's.
  expecting(kind) {
    return this.now() - this.issued[kind] < EXPECT_MS;
  }

  // Note that the player carried out a command (consumes the expectation).
  fulfilled(st) {
    const expPlay = this.expecting('play');
    const expPause = this.expecting('pause');
    if (st === S.PLAYING) {
      this.playStarted = true;
      this.issued.play = -Infinity;
    } else if (st === S.PAUSED) {
      this.issued.pause = -Infinity;
    }
    return st === S.PLAYING ? expPlay : st === S.PAUSED ? expPause : false;
  }

  // ---- user intents -------------------------------------------------------

  // Explicit user action from our own controls or detected from the player.
  act(type, pos) {
    if (!this.rs || !this.rs.v) return;
    const a = { type, pos: clampPos(pos) };
    const at = this.serverNow();
    this.rs = applyAction(this.rs, a, at);
    this.send({ type: 'action', action: a, at });
    // Apply immediately instead of waiting out cooldowns.
    this.lastSeekAt = -Infinity;
    this.lastPlayAt = -Infinity;
    this.pausePendingAt = 0;
    this.playPendingAt = 0;
    this.sync();
    this.onChange();
  }

  play() {
    this.act('play', this.expected());
  }

  pause() {
    // Pause on the frame the presser is looking at.
    this.act('pause', this.state() === S.PLAYING ? this.current() : this.expected());
  }

  toggle() {
    if (this.rs && this.rs.playing) this.pause();
    else this.play();
  }

  seek(pos) {
    const d = this.duration();
    this.act('seek', d > 0 ? Math.min(pos, Math.max(0, d - 0.25)) : pos);
  }

  skip(delta) {
    this.seek(Math.max(0, this.expected() + delta));
  }

  // ---- player events ------------------------------------------------------

  onPlayerState(st) {
    const ours = this.fulfilled(st);
    if (st === S.PLAYING || st === S.BUFFERING) this.setBlocked(false);
    if (!this.rs || !this.rs.v || this.isHidden() || this.suppressed()) return;
    const want = this.wantPlaying();
    if (st === S.BUFFERING && !want) {
      // Either the user pressed play on YouTube's controls (it buffers first)
      // or a seek of ours is loading. Wait and see if it reaches PLAYING.
      if (!this.expecting('play') && !this.holders().length && !this.playPendingAt) this.playPendingAt = this.now();
    } else if (st === S.PLAYING && !want) {
      // Pressed play on the YouTube player itself.
      this.playPendingAt = 0;
      if (ours || this.holders().length) return;
      this.act('play', this.current());
    } else if (st === S.PAUSED && want) {
      // Ours, or the browser refusing a play we just asked for (autoplay
      // rules). Neither is the user pausing; trackBlocked() handles the latter.
      if (ours || !this.playStarted) return;
      // Could be a real pause or the start of a scrub; decide shortly.
      if (!this.pausePendingAt) this.pausePendingAt = this.now();
    } else {
      if (st !== S.PAUSED) this.pausePendingAt = 0;
      if (st !== S.BUFFERING) this.playPendingAt = 0;
    }
  }

  // Called on an interval (~500ms) and whenever room state changes.
  tick() {
    this.sync();
  }

  sync() {
    if (!this.ready || !this.rs) return;
    const rs = this.rs;
    if (!rs.v) return;

    if (rs.v !== this.loadedId) {
      this.loadVideo();
      return;
    }
    const now = this.now();
    const st = this.state();
    const cur = this.current();

    if (this.isHidden()) {
      // In the background we still follow the room (so a computer in another
      // tab pauses when the partner does), but we never read local player
      // changes as intent: phones pause background media on their own.
      this.sample = null;
      this.pausePendingAt = 0;
      this.playPendingAt = 0;
      this.wantPlaySince = 0;
      this.correct(st, cur, now);
      return;
    }

    if (this.pausePendingAt) {
      if (st !== S.PAUSED) {
        this.pausePendingAt = 0;
      } else if (now - this.pausePendingAt >= PAUSE_DEBOUNCE_MS) {
        this.pausePendingAt = 0;
        if (this.wantPlaying()) {
          this.act('pause', cur);
          return;
        }
      } else {
        return; // hold off correcting while we decide
      }
    }

    if (this.playPendingAt) {
      if (st !== S.BUFFERING || this.wantPlaying() || now - this.playPendingAt >= PLAY_WAIT_MS) {
        this.playPendingAt = 0;
      } else {
        return; // don't pause a play the user may have just pressed
      }
    }

    if (this.detectSeek(st, cur, now)) return;
    this.trackBuffering(st, now);
    this.trackBlocked(st, now);
    this.correct(st, cur, now);
  }

  // Issue whatever player commands bring us in line with the room.
  correct(st, cur, now) {
    const want = this.wantPlaying();
    const holdIsMe = this.holders().includes(this.me);
    const acts = decide({
      want,
      expected: this.expected(),
      current: cur,
      state: st,
      duration: this.duration(),
      now,
      lastSeekAt: this.lastSeekAt,
      lastPlayAt: this.lastPlayAt,
    });
    // While the room is waiting on *our* buffering, only correct big jumps.
    if (holdIsMe && acts.seek != null && Math.abs(acts.seek - cur) < SYNC.BUFFER_FAR) acts.seek = null;

    if (acts.seek != null) {
      // A seek makes the position jump; don't mistake that for a user scrub.
      this.seekQuietUntil = now + SUPPRESS_MS;
      this.sample = null;
      this.lastSeekAt = now;
      this.player.seekTo(acts.seek, true);
    }
    if (acts.pause) {
      this.issued.pause = now;
      this.player.pauseVideo();
    }
    if (acts.play) {
      this.issued.play = now;
      this.playStarted = false;
      this.lastPlayAt = now;
      this.player.playVideo();
    }
    this.sample = { t: acts.seek != null ? acts.seek : cur, at: now, state: st };
  }

  loadVideo() {
    const rs = this.rs;
    const now = this.now();
    this.loadedId = rs.v;
    // The load moves the position and (if playing) starts playback: both are
    // ours. A pause during this time is still the user's, so don't block it.
    this.seekQuietUntil = now + SUPPRESS_MS;
    this.sample = null;
    this.pausePendingAt = 0;
    if (rs.playing) {
      this.issued.play = now;
      this.playStarted = false;
    }
    this.lastSeekAt = this.lastPlayAt = now;
    this.wantPlaySince = 0;
    const opts = { videoId: rs.v, startSeconds: this.expected() };
    if (rs.playing) this.player.loadVideoById(opts);
    else this.player.cueVideoById(opts);
  }

  // A user scrub on the YouTube player shows up as currentTime jumping.
  detectSeek(st, cur, now) {
    const prev = this.sample;
    if (!prev || this.suppressed() || this.now() < this.seekQuietUntil) return false;
    if (st !== S.PLAYING && st !== S.PAUSED && st !== S.BUFFERING) return false;
    const moving = prev.state === S.PLAYING && st === S.PLAYING;
    const predicted = prev.t + (moving ? (now - prev.at) / 1000 : 0);
    if (Math.abs(cur - predicted) <= JUMP) return false;
    if (Math.abs(cur - this.expected()) <= JUMP) return false;
    this.act('seek', cur);
    return true;
  }

  trackBuffering(st, now) {
    if (st === S.BUFFERING && this.rs.playing) {
      if (!this.bufferingSince) this.bufferingSince = now;
      if (!this.bufferReported && now - this.bufferingSince >= BUFFER_REPORT_MS) {
        this.bufferReported = true;
        this.send({ type: 'buffer', on: true });
      }
    } else {
      this.bufferingSince = 0;
      if (this.bufferReported) {
        this.bufferReported = false;
        this.send({ type: 'buffer', on: false });
      }
    }
  }

  // iOS (and some desktop browsers) refuse to start playback until the user
  // has touched the player once. Detect that so the UI can ask for a tap.
  trackBlocked(st, now) {
    const stuck = this.wantPlaying() && (st === S.UNSTARTED || st === S.CUED || st === S.PAUSED);
    if (!stuck) {
      this.wantPlaySince = 0;
      if (st === S.PLAYING || st === S.BUFFERING || !this.wantPlaying()) this.setBlocked(false);
      return;
    }
    if (!this.wantPlaySince) this.wantPlaySince = now;
    if (now - this.wantPlaySince >= BLOCKED_MS) this.setBlocked(true);
  }

  setBlocked(b) {
    if (this.blocked === b) return;
    this.blocked = b;
    this.onBlocked(b);
  }

  // Forget local tracking (e.g. after coming back from the background).
  resync() {
    this.sample = null;
    this.pausePendingAt = 0;
    this.playPendingAt = 0;
    this.lastSeekAt = -Infinity;
    this.lastPlayAt = -Infinity;
    this.suppressUntil = 0;
    this.seekQuietUntil = 0;
    this.sync();
  }
}
