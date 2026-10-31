// Shared, dependency-free sync logic. Imported by the browser (app.js) and the
// server (rooms.js) so both sides agree on how room state evolves over time.

export const YT_STATE = Object.freeze({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
});

// Tuning for the drift corrector. Seconds unless noted.
export const SYNC = Object.freeze({
  DRIFT: 0.6, // max allowed drift while playing before we seek
  PAUSED_DRIFT: 0.3, // max allowed offset while paused
  BUFFER_FAR: 4, // only interrupt a buffering player if it is this far off
  SEEK_COOLDOWN: 2500, // ms between corrective seeks while playing
  PAUSED_SEEK_COOLDOWN: 800, // ms between corrective seeks while paused
  PLAY_COOLDOWN: 1500, // ms between repeated play attempts
});

export const MAX_POS = 7 * 24 * 3600;

// Title saved for a video added before its real title was known.
export const PLACEHOLDER_TITLE = 'YouTube video';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(v) {
  return typeof v === 'string' && VIDEO_ID_RE.test(v);
}

// Accepts YouTube's `t`/`start` formats: "90", "90s", "1m30s", "1h2m3s", "1:30".
export function parseTime(t) {
  if (t == null) return 0;
  const s = String(t).trim().toLowerCase();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return clampPos(Number(s));
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
    return clampPos(s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0));
  }
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return clampPos((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0));
}

// Returns { id, start } for anything that looks like a YouTube video link, or null.
export function parseYouTubeUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 2048) return null;
  if (isVideoId(s)) return { id: s, start: 0 };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch' || url.pathname === '/watch/') {
      id = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v|e)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  if (!isVideoId(id)) return null;

  const hashT = url.hash.match(/[#&]t=([^&]+)/);
  const t = url.searchParams.get('t') ?? url.searchParams.get('start') ?? (hashT && hashT[1]);
  return { id, start: parseTime(t) };
}

export function clampPos(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return 0;
  return Math.min(Math.max(p, 0), MAX_POS);
}

// A room is "effectively playing" only when nobody is holding it for buffering.
export function isEffectivelyPlaying(s) {
  return !!(s && s.v && s.playing && !(s.hold && s.hold.length));
}

// Where the video should be at server time `now` (ms).
export function expectedPosition(s, now) {
  if (!s) return 0;
  if (!isEffectivelyPlaying(s)) return s.pos;
  return clampPos(s.pos + Math.max(0, now - s.at) / 1000);
}

// Pure state transition for a user action at server time `at`.
// Any explicit action clears buffering holds.
export function applyAction(s, a, at) {
  switch (a.type) {
    case 'load':
      return { ...s, v: a.v, playing: a.playing !== false, pos: clampPos(a.pos), at, hold: [] };
    case 'play':
      return { ...s, playing: true, pos: clampPos(a.pos), at, hold: [] };
    case 'pause':
      return { ...s, playing: false, pos: clampPos(a.pos), at, hold: [] };
    case 'seek':
      return { ...s, pos: clampPos(a.pos), at, hold: [] };
    default:
      return s;
  }
}

// Decide which player commands bring the local player in line with the room.
// o: { want, expected, current, state, duration, now, lastSeekAt, lastPlayAt }
export function decide(o) {
  const acts = { seek: null, play: false, pause: false };
  const S = YT_STATE;
  let exp = o.expected;
  if (o.duration > 0) exp = Math.min(exp, o.duration);
  const atEnd = o.duration > 0 && exp >= o.duration - 0.5;
  const drift = Math.abs((o.current || 0) - exp);
  const sinceSeek = o.now - o.lastSeekAt;

  if (o.want) {
    if (o.state === S.ENDED && atEnd) return acts;
    if (o.state === S.PLAYING) {
      if (drift > SYNC.DRIFT && sinceSeek >= SYNC.SEEK_COOLDOWN) acts.seek = exp;
    } else if (o.state === S.BUFFERING) {
      if (drift > SYNC.BUFFER_FAR && sinceSeek >= SYNC.SEEK_COOLDOWN) acts.seek = exp;
    } else if (o.now - o.lastPlayAt >= SYNC.PLAY_COOLDOWN) {
      acts.play = true;
      if (drift > SYNC.DRIFT && sinceSeek >= SYNC.PAUSED_SEEK_COOLDOWN) acts.seek = exp;
    }
  } else {
    if (o.state === S.PLAYING || o.state === S.BUFFERING) acts.pause = true;
    const seekable = o.state !== S.CUED && o.state !== S.UNSTARTED && !(o.state === S.ENDED && atEnd);
    if (seekable && drift > SYNC.PAUSED_DRIFT && sinceSeek >= SYNC.PAUSED_SEEK_COOLDOWN) acts.seek = exp;
  }
  return acts;
}

// NTP-style clock offset estimate. Keeps the lowest-latency recent samples.
export class ClockSync {
  constructor(maxSamples = 8) {
    this.maxSamples = maxSamples;
    this.samples = [];
    this.offset = 0;
    this.rtt = Infinity;
  }

  // sentAt/receivedAt: local ms; serverAt: server ms.
  add(sentAt, serverAt, receivedAt) {
    const rtt = receivedAt - sentAt;
    if (!(rtt >= 0) || !Number.isFinite(serverAt)) return;
    this.samples.push({ rtt, offset: serverAt - (sentAt + receivedAt) / 2 });
    if (this.samples.length > this.maxSamples) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.rtt = best.rtt;
  }

  // Rough offset from a single server timestamp, used only until real samples arrive.
  seed(serverAt, local = Date.now()) {
    if (!this.samples.length && Number.isFinite(serverAt)) this.offset = serverAt - local;
  }

  now(local = Date.now()) {
    return local + this.offset;
  }
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
