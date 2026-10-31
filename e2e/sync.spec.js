// Two real browsers in one room, driving the actual app UI. YouTube's player
// is replaced by e2e/fake-youtube.js so timing is deterministic.
import { test, expect, couple, newPerson, signIn, yt, expectSynced, loadVideo as load } from './people.js';

const VID = 'dQw4w9WgXcQ';
const VID2 = 'jNQXAC9IVRw';
const LINK = `https://www.youtube.com/watch?v=${VID}`;
const loadVideo = (page, link = LINK, opts) => load(page, link, opts);
const pair = couple;

const tap = (page, sel) => page.locator(sel).click();

test('YouTube is not downloaded until there is a video', async ({ browser }, testInfo) => {
  const { a } = await couple(browser, testInfo);
  let ytRequests = 0;
  a.on('request', (r) => r.url().includes('youtube.com') && ytRequests++);
  await a.reload();
  await expect(a.locator('#presence')).toHaveText(/Bo/);
  await a.waitForTimeout(800);
  expect(ytRequests).toBe(0);
  await loadVideo(a);
  await expect.poll(() => ytRequests).toBeGreaterThan(0);
});

test('bad links show an error and do nothing', async ({ browser }, testInfo) => {
  const { a } = await couple(browser, testInfo);
  await loadVideo(a, 'https://vimeo.com/123');
  await expect(a.locator('#load-err')).toBeVisible();
  await expect(a.locator('#empty')).toBeVisible();
  await a.locator('#url').fill('x');
  await expect(a.locator('#load-err')).toBeHidden();
});

test('pasting a link suggests it; it plays for both once the partner accepts', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a, LINK, { accept: false });
  await expect(b.locator('#proposal-who')).toHaveText('Alex wants to watch:');
  await expect(a.locator('#proposal-who')).toHaveText('Waiting for Bo to accept…');
  await expect(a.locator('#proposal-accept')).toBeHidden();
  await a.waitForTimeout(800);
  expect((await yt(a)).vid, 'nothing plays before accepting').toBe(null);
  await b.locator('#proposal-accept').click();
  await expectSynced(a, b, { st: 1 });
  expect((await yt(b)).vid).toBe(VID);
  await expect(a.locator('#proposal')).toBeHidden();
  await expect(b.locator('#proposal')).toBeHidden();
  await expect(b.locator('#video-title')).toHaveText(`Test video ${VID}`);
  await a.waitForTimeout(2000);
  await expectSynced(a, b, { st: 1 });
  expect((await yt(a)).t).toBeGreaterThan(1.5);
});

test('link with a timestamp starts there for both', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(b, `https://youtu.be/${VID}?t=95`);
  await expectSynced(a, b, { st: 1 });
  expect((await yt(a)).t).toBeGreaterThan(94);
});

test('pause and play from our buttons', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  await a.waitForTimeout(1500);

  await tap(b, '#toggle');
  await expectSynced(a, b, { st: 2, tolerance: 0.35 });
  await expect(a.locator('#toggle')).toHaveAttribute('aria-label', 'Play');
  await expect(a.locator('#toast')).toHaveText(/Bo paused at/);
  const pausedAt = (await yt(a)).t;
  await a.waitForTimeout(1500);
  expect(Math.abs((await yt(a)).t - pausedAt)).toBeLessThan(0.05);

  await tap(a, '#toggle');
  await expectSynced(a, b, { st: 1 });
  await expect(b.locator('#toggle')).toHaveAttribute('aria-label', 'Pause');
  expect(Math.abs((await yt(b)).t - pausedAt)).toBeLessThan(1);
});

test('skip buttons move both', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  await tap(b, '#fwd');
  await tap(b, '#fwd');
  await tap(b, '#fwd');
  await expectSynced(a, b, { st: 1 });
  expect((await yt(a)).t).toBeGreaterThan(29);
  const before = (await yt(a)).t;
  await tap(a, '#back');
  await expectSynced(a, b, { st: 1 });
  const t = (await yt(b)).t;
  expect(t).toBeGreaterThan(before - 11);
  expect(t).toBeLessThan(before - 8);
});

test('tapping / dragging the seek bar moves both', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo, { yt: { duration: 600 } });
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  const box = await a.locator('#seek').boundingBox();
  const y = box.y + box.height / 2;
  // Tap at 50% => 300s.
  if (testInfo.project.use.hasTouch) await a.touchscreen.tap(box.x + box.width / 2, y);
  else await a.mouse.click(box.x + box.width / 2, y);
  await expectSynced(a, b, { st: 1 });
  expect((await yt(b)).t).toBeGreaterThan(295);
  expect((await yt(b)).t).toBeLessThan(310);

  // Drag to 25% => 150s. (Pointer drag works the same for touch.)
  await a.mouse.move(box.x + box.width * 0.6, y);
  await a.mouse.down();
  await a.mouse.move(box.x + box.width * 0.4, y, { steps: 4 });
  await a.mouse.move(box.x + box.width * 0.25, y, { steps: 4 });
  await a.mouse.up();
  await expectSynced(a, b, { st: 1 });
  expect((await yt(b)).t).toBeGreaterThan(145);
  expect((await yt(b)).t).toBeLessThan(160);
});

test('using YouTube\'s own controls is shared too', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });

  await b.evaluate(() => window.__wt.player.userPause());
  await expectSynced(a, b, { st: 2, tolerance: 0.35 });

  await a.evaluate(() => window.__wt.player.userPlay());
  await expectSynced(a, b, { st: 1 });

  await b.evaluate(() => window.__wt.player.userScrub(200));
  await expectSynced(a, b, { st: 1 });
  expect((await yt(a)).t).toBeGreaterThan(199);
});

test('keyboard shortcuts (space, arrows)', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'iphone', 'no keyboard on phone');
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  await a.locator('body').click({ position: { x: 2, y: 2 } });
  await a.keyboard.press('Space');
  await expectSynced(a, b, { st: 2, tolerance: 0.35 });
  await a.keyboard.press('ArrowRight');
  await a.keyboard.press('ArrowRight');
  await expect.poll(async () => (await yt(b)).t).toBeGreaterThan(9);
  await a.keyboard.press('k');
  await expectSynced(a, b, { st: 1 });
});

test('stays in sync over time and corrects drift', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  // Knock B's player 4s behind without telling the app (like a hiccup).
  await b.evaluate(() => {
    const p = window.__wt.player;
    p.t -= 4;
    window.__wt.ctl.sample = null;
  });
  await expectSynced(a, b, { st: 1, tolerance: 0.7 });
  for (let i = 0; i < 5; i++) {
    await a.waitForTimeout(1000);
    await expectSynced(a, b, { st: 1, tolerance: 0.7 });
  }
});

test('partner with slow internet: room waits, then resumes together', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  await b.evaluate(() => window.__wt.player.stall(5000));
  await expect(a.locator('#status')).toHaveText('Waiting for Bo to load…', { timeout: 4000 });
  await expect.poll(async () => (await yt(a)).st).toBe(2);
  await expect(b.locator('#status')).toHaveText(/Buffering/);
  await expectSynced(a, b, { st: 1, tolerance: 0.8 });
  await expect(a.locator('#status')).toHaveText('');
});

test('changing video switches both', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  await loadVideo(b, `https://www.youtube.com/shorts/${VID2}`);
  await expect.poll(async () => (await yt(a)).vid).toBe(VID2);
  await expectSynced(a, b, { st: 1 });
  await expect(a.locator('#video-title')).toHaveText(`Test video ${VID2}`);
});

test('a suggestion waits for a partner who is away; they accept when they open the app', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  const bState = await b.context().storageState();
  await b.close();
  await loadVideo(a, LINK, { accept: false });
  await expect(a.locator('#proposal-who')).toHaveText('Waiting for Bo to accept…');
  const b2 = await newPerson(browser, testInfo, { context: { storageState: bState } });
  await b2.goto('/');
  await expect(b2.locator('#proposal-who')).toHaveText('Alex wants to watch:');
  await b2.locator('#proposal-accept').click();
  await expectSynced(a, b2, { st: 1 });
});

test('partner opening the app later lands at the same spot (and paused stays paused)', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  const bState = await b.context().storageState();
  await b.close();
  await a.waitForTimeout(3000);
  const b2 = await newPerson(browser, testInfo, { context: { storageState: bState } });
  await b2.goto('/');
  await expectSynced(a, b2, { st: 1 });
  expect((await yt(b2)).t).toBeGreaterThan(2.5);

  await tap(a, '#toggle');
  await expectSynced(a, b2, { st: 2, tolerance: 0.35 });
  await b2.reload();
  await expect.poll(async () => (await yt(b2)).st).toBe(5); // cued, not playing
  expect(Math.abs((await yt(b2)).t - (await yt(a)).t)).toBeLessThan(0.35);
});

test('your second device (e.g. phone + laptop) joins the same session', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  const laptop = await newPerson(browser, testInfo, { context: { storageState: await a.context().storageState() } });
  await laptop.goto('/');
  await expectSynced(a, laptop, { st: 1 });
  await expect(laptop.locator('#presence')).toHaveText('Watching with Bo');
  await tap(laptop, '#toggle');
  await expectSynced(b, laptop, { st: 2, tolerance: 0.35 });
});

test('blocked autoplay (iPhone rule): plays muted in sync, tap restores sound', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo, { b: { yt: { blockUnmutedAutoplay: true } } });
  await loadVideo(a);
  // B's browser refuses sound; the app falls back to muted playback in sync.
  await expect(b.locator('#tap')).toBeVisible({ timeout: 8000 });
  await expectSynced(a, b, { st: 1 });
  expect((await yt(b)).muted).toBe(true);
  // One tap brings sound back without pausing anyone.
  await tap(b, '#tap');
  await expect(b.locator('#tap')).toBeHidden();
  expect((await yt(b)).muted).toBe(false);
  await b.waitForTimeout(1500);
  await expectSynced(a, b, { st: 1 });
});

test('connection drop: reconnects and catches up on what was missed', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  // Cut B off the way a lost signal would: socket dies, and no network for
  // a while so reconnect attempts fail too.
  await b.context().setOffline(true);
  await b.evaluate(() => window.__wt.dropSocket());
  await expect(b.locator('#presence')).toHaveText(/Reconnecting/);
  await expect(a.locator('#presence')).toHaveText('Waiting for Bo…');
  // A pauses and skips while B is gone.
  await tap(a, '#toggle');
  await tap(a, '#fwd');
  await tap(a, '#fwd');
  await a.waitForTimeout(500);
  await b.context().setOffline(false);
  await expect(b.locator('#presence')).toHaveText('Watching with Alex', { timeout: 15_000 });
  await expectSynced(a, b, { st: 2, tolerance: 0.35 });
  expect((await yt(b)).t).toBeGreaterThan(18);
});

test('offline action is re-sent when nobody else changed anything', async ({ browser }, testInfo) => {
  const { a, b } = await pair(browser, testInfo);
  await loadVideo(a);
  await expectSynced(a, b, { st: 1 });
  await b.context().setOffline(true);
  await b.evaluate(() => window.__wt.dropSocket());
  await expect(b.locator('#presence')).toHaveText(/Reconnecting/);
  await tap(b, '#toggle'); // B pauses while offline
  await b.context().setOffline(false);
  await expect(b.locator('#presence')).toHaveText('Watching with Alex', { timeout: 15_000 });
  await expectSynced(a, b, { st: 2, tolerance: 0.5 });
});

test('works with no horizontal scrolling and big enough tap targets', async ({ browser }, testInfo) => {
  const { a } = await pair(browser, testInfo);
  await loadVideo(a);
  await expect(a.locator('#controls')).toBeVisible();
  const overflow = await a.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const sel of ['#toggle', '#fwd', '#back', '#room .icon-link', '#load button[type=submit]']) {
    const box = await a.locator(sel).boundingBox();
    expect(box.height, sel).toBeGreaterThanOrEqual(44);
    expect(box.width, sel).toBeGreaterThanOrEqual(44);
  }
  // Player keeps 16:9 and fits the screen.
  const pb = await a.locator('#player-box').boundingBox();
  const vw = a.viewportSize().width;
  expect(pb.width).toBeLessThanOrEqual(vw);
  expect(Math.abs(pb.width / pb.height - 16 / 9)).toBeLessThan(0.05);
  // Controls are fully on screen without scrolling.
  const ctl = await a.locator('#controls').boundingBox();
  expect(ctl.y + ctl.height).toBeLessThanOrEqual(a.viewportSize().height);
  // A notification never covers the play button.
  await a.evaluate(() => {
    const t = document.getElementById('toast');
    t.textContent = 'Your partner joined';
    t.hidden = false;
  });
  const tb = await a.locator('#toast').boundingBox();
  const pb2 = await a.locator('#toggle').boundingBox();
  const overlaps = !(tb.y + tb.height <= pb2.y || pb2.y + pb2.height <= tb.y || tb.x + tb.width <= pb2.x || pb2.x + pb2.width <= tb.x);
  expect(overlaps).toBe(false);
  // The input is >=16px so iPhone Safari does not zoom in on focus.
  const fs = await a.locator('#url').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fs).toBeGreaterThanOrEqual(16);
  await a.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-room.png`) });
});
