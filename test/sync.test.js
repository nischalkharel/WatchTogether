import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClockSync,
  SYNC,
  YT_STATE as S,
  applyAction,
  clampPos,
  decide,
  expectedPosition,
  formatTime,
  parseTime,
  parseYouTubeUrl,
} from '../public/sync.js';

test('parseYouTubeUrl handles every common link shape', () => {
  const id = 'dQw4w9WgXcQ';
  const cases = [
    [`https://www.youtube.com/watch?v=${id}`, 0],
    [`https://youtube.com/watch?v=${id}&list=PL123&index=2`, 0],
    [`http://m.youtube.com/watch?v=${id}`, 0],
    [`https://music.youtube.com/watch?v=${id}`, 0],
    [`youtube.com/watch?v=${id}`, 0],
    [`www.youtube.com/watch?v=${id}`, 0],
    [`https://youtu.be/${id}`, 0],
    [`https://youtu.be/${id}?si=abcDEF123`, 0],
    [`https://youtu.be/${id}?t=42`, 42],
    [`https://www.youtube.com/watch?v=${id}&t=1m30s`, 90],
    [`https://www.youtube.com/watch?v=${id}#t=2m`, 120],
    [`https://www.youtube.com/shorts/${id}`, 0],
    [`https://www.youtube.com/shorts/${id}?feature=share`, 0],
    [`https://www.youtube.com/embed/${id}?start=15`, 15],
    [`https://www.youtube.com/live/${id}?si=x`, 0],
    [`https://www.youtube-nocookie.com/embed/${id}`, 0],
    [`  https://youtu.be/${id}  `, 0],
    [id, 0],
  ];
  for (const [url, start] of cases) {
    assert.deepEqual(parseYouTubeUrl(url), { id, start }, url);
  }
});

test('parseYouTubeUrl rejects things that are not YouTube videos', () => {
  for (const bad of [
    '',
    '   ',
    null,
    undefined,
    42,
    'hello world',
    'https://vimeo.com/123456',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=toolongvideoid123',
    'https://www.youtube.com/@somechannel',
    'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'x'.repeat(5000),
  ]) {
    assert.equal(parseYouTubeUrl(bad), null, String(bad).slice(0, 60));
  }
});

test('parseTime supports YouTube time formats', () => {
  assert.equal(parseTime('90'), 90);
  assert.equal(parseTime('90s'), 90);
  assert.equal(parseTime('1m30s'), 90);
  assert.equal(parseTime('1h2m3s'), 3723);
  assert.equal(parseTime('1:30'), 90);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('2m'), 120);
  assert.equal(parseTime(''), 0);
  assert.equal(parseTime(null), 0);
  assert.equal(parseTime('abc'), 0);
  assert.equal(parseTime('-5'), 0);
});

test('clampPos rejects junk', () => {
  assert.equal(clampPos(NaN), 0);
  assert.equal(clampPos(-3), 0);
  assert.equal(clampPos('12'), 0);
  assert.equal(clampPos(Infinity), 0);
  assert.equal(clampPos(1e12), 7 * 24 * 3600);
  assert.equal(clampPos(12.5), 12.5);
});

test('expectedPosition advances only while playing and not held', () => {
  const base = { v: 'dQw4w9WgXcQ', playing: true, pos: 10, at: 1000, hold: [] };
  assert.equal(expectedPosition(base, 4000), 13);
  assert.equal(expectedPosition(base, 500), 10, 'never goes backwards for clock skew');
  assert.equal(expectedPosition({ ...base, playing: false }, 4000), 10);
  assert.equal(expectedPosition({ ...base, hold: ['a'] }, 4000), 10);
  assert.equal(expectedPosition({ ...base, v: null }, 4000), 10);
});

test('applyAction transitions', () => {
  const s0 = { v: null, playing: false, pos: 0, at: 0, hold: ['x'] };
  const s1 = applyAction(s0, { type: 'load', v: 'dQw4w9WgXcQ', pos: 5 }, 100);
  assert.deepEqual(s1, { v: 'dQw4w9WgXcQ', playing: true, pos: 5, at: 100, hold: [] });
  assert.equal(applyAction(s0, { type: 'load', v: 'dQw4w9WgXcQ', pos: 5, playing: false }, 100).playing, false);
  const s2 = applyAction({ ...s1, hold: ['x'] }, { type: 'pause', pos: 9 }, 200);
  assert.deepEqual(s2, { ...s1, playing: false, pos: 9, at: 200, hold: [] });
  const s3 = applyAction(s2, { type: 'seek', pos: 60 }, 300);
  assert.equal(s3.playing, false, 'seek keeps paused state');
  assert.equal(s3.pos, 60);
  const s4 = applyAction(s3, { type: 'play', pos: 60 }, 400);
  assert.equal(s4.playing, true);
  assert.equal(applyAction(s4, { type: 'bogus' }, 500), s4);
});

const base = { expected: 10, current: 10, duration: 100, now: 100_000, lastSeekAt: 0, lastPlayAt: 0 };

test('decide: playing and in sync does nothing', () => {
  assert.deepEqual(decide({ ...base, want: true, state: S.PLAYING, current: 10.3 }), { seek: null, play: false, pause: false });
});

test('decide: playing but drifted seeks', () => {
  assert.equal(decide({ ...base, want: true, state: S.PLAYING, current: 12 }).seek, 10);
  assert.equal(decide({ ...base, want: true, state: S.PLAYING, current: 8 }).seek, 10);
});

test('decide: seek cooldown prevents seek storms', () => {
  const r = decide({ ...base, want: true, state: S.PLAYING, current: 12, lastSeekAt: base.now - 100 });
  assert.equal(r.seek, null);
});

test('decide: paused locally but room playing -> play', () => {
  const r = decide({ ...base, want: true, state: S.PAUSED, current: 10 });
  assert.equal(r.play, true);
  assert.equal(r.seek, null);
  const r2 = decide({ ...base, want: true, state: S.CUED, current: 0 });
  assert.equal(r2.play, true);
  assert.equal(r2.seek, 10);
});

test('decide: play cooldown', () => {
  assert.equal(decide({ ...base, want: true, state: S.PAUSED, lastPlayAt: base.now - 200 }).play, false);
});

test('decide: buffering is left alone unless far off', () => {
  assert.deepEqual(decide({ ...base, want: true, state: S.BUFFERING, current: 12 }), { seek: null, play: false, pause: false });
  assert.equal(decide({ ...base, want: true, state: S.BUFFERING, current: 10 + SYNC.BUFFER_FAR + 1 }).seek, 10);
});

test('decide: room paused -> pause and align', () => {
  const r = decide({ ...base, want: false, state: S.PLAYING, current: 11 });
  assert.equal(r.pause, true);
  assert.equal(r.seek, 10);
  const r2 = decide({ ...base, want: false, state: S.PAUSED, current: 10.1 });
  assert.deepEqual(r2, { seek: null, play: false, pause: false });
  const r3 = decide({ ...base, want: false, state: S.BUFFERING, current: 10 });
  assert.equal(r3.pause, true);
});

test('decide: cued player is not seeked while paused (would start loading)', () => {
  assert.equal(decide({ ...base, want: false, state: S.CUED, current: 0 }).seek, null);
});

test('decide: video ended stays ended', () => {
  const r = decide({ ...base, want: true, state: S.ENDED, current: 100, expected: 104 });
  assert.deepEqual(r, { seek: null, play: false, pause: false });
});

test('decide: expected clamps to duration', () => {
  const r = decide({ ...base, want: true, state: S.PLAYING, current: 50, expected: 500 });
  assert.equal(r.seek, 100);
});

test('ClockSync picks the lowest-latency sample', () => {
  const c = new ClockSync(4);
  // server is 5000ms ahead
  c.add(0, 5000 + 100, 300); // rtt 300, sloppy
  c.add(1000, 5000 + 1010, 1020); // rtt 20, offset 5000
  c.add(2000, 7000 + 400, 2500); // rtt 500
  assert.equal(c.rtt, 20);
  assert.equal(c.offset, 5000);
  assert.equal(c.now(10), 5010);
  c.add(5, NaN, 10);
  c.add(10, 100, 5); // negative rtt ignored
  assert.equal(c.samples.length, 3);
});

test('ClockSync seed is only used until a real sample arrives', () => {
  const c = new ClockSync();
  c.seed(10_000, 1000);
  assert.equal(c.offset, 9000);
  c.add(0, 5010, 20);
  assert.equal(c.offset, 5000);
  c.seed(99_999, 0);
  assert.equal(c.offset, 5000);
});

test('ClockSync forgets old samples', () => {
  const c = new ClockSync(2);
  c.add(0, 100, 10);
  c.add(0, 999, 100);
  c.add(0, 999, 100);
  assert.equal(c.rtt, 100);
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(5.9), '0:05');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-1), '0:00');
});
