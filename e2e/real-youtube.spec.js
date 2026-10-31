// Smoke test against the real YouTube player (needs internet). Run with:
//   REAL_YT=1 npm run test:e2e -- e2e/real-youtube.spec.js
// Two people in one room; checks play/pause/seek reach the real embedded player.
import { test, expect, couple, loadVideo } from './people.js';

test.skip(!process.env.REAL_YT, 'set REAL_YT=1 to run against real YouTube');

// "Me at the zoo": the first YouTube video, always embeddable, 19s long.
const VID = 'jNQXAC9IVRw';

const yt = (page) =>
  page.evaluate(() => {
    const p = window.__wt && window.__wt.player;
    if (!p || !p.getPlayerState) return { st: null, t: 0 };
    return { st: p.getPlayerState(), t: p.getCurrentTime(), muted: p.isMuted() };
  });

test('real YouTube: both play, pause and seek together', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const { a, b } = await couple(browser, testInfo, { realYouTube: true });
  await loadVideo(a, `https://youtu.be/${VID}`); // Alex suggests, Bo taps Watch

  // Headless browsers block sound like iPhones do, so the app should fall back
  // to muted playback. Either way, both end up playing.
  await expect.poll(async () => [(await yt(a)).st, (await yt(b)).st].join(), { timeout: 45_000 }).toBe('1,1');
  await expect(a.locator('#video-title')).toHaveText(/zoo/i, { timeout: 15_000 });

  const close = async (tol) => {
    const [x, y] = [await yt(a), await yt(b)];
    return Math.abs(x.t - y.t) <= tol;
  };
  await expect.poll(() => close(1), { timeout: 15_000 }).toBe(true);

  await b.locator('#toggle').click();
  await expect.poll(async () => [(await yt(a)).st, (await yt(b)).st].join(), { timeout: 15_000 }).toBe('2,2');
  await expect.poll(() => close(0.5), { timeout: 10_000 }).toBe(true);

  // Seek both to 10s by tapping 10/19ths of the way along A's bar.
  const box = await a.locator('#seek').boundingBox();
  const dur = await a.evaluate(() => window.__wt.player.getDuration());
  await a.mouse.click(box.x + (box.width * 10) / dur, box.y + box.height / 2);
  await expect.poll(async () => Math.round((await yt(b)).t), { timeout: 15_000 }).toBe(10);
  await expect.poll(() => close(0.5), { timeout: 10_000 }).toBe(true);

  await a.locator('#toggle').click();
  await expect.poll(async () => [(await yt(a)).st, (await yt(b)).st].join(), { timeout: 20_000 }).toBe('1,1');
  await expect.poll(() => close(1), { timeout: 15_000 }).toBe(true);
  await a.screenshot({ path: testInfo.outputPath('real-youtube.png') });
});
