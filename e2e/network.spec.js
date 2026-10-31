// How the app behaves on a poor connection, and how much data sync costs.
import { test, expect, couple, loadVideo } from './people.js';

// A signed-in, linked couple with byte counters on each socket.
async function counted(page) {
  const stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 };
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => ((stats.framesIn += 1), (stats.bytesIn += String(f.payload).length)));
    ws.on('framesent', (f) => ((stats.framesOut += 1), (stats.bytesOut += String(f.payload).length)));
  });
  await page.reload(); // reconnect with counting on
  await expect(page.locator('#presence')).toHaveText(/Watching with/);
  return { page, stats, ctx: page.context() };
}

async function people(browser, testInfo) {
  const { a, b } = await couple(browser, testInfo);
  return [await counted(a), await counted(b)];
}

const yt = (page) =>
  page.evaluate(() => {
    const p = window.__wt.player;
    return p ? { st: p.getPlayerState(), t: p.getCurrentTime() } : { st: null, t: 0 };
  });

test('sync traffic is tiny while watching', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const [a, b] = await people(browser, testInfo);
  await loadVideo(a.page, 'https://youtu.be/dQw4w9WgXcQ'); // suggest; Bo accepts
  await expect.poll(async () => (await yt(b.page)).st).toBe(1);
  // Measure a steady 30s of watching.
  await a.page.waitForTimeout(5000);
  const before = { ...b.stats };
  await a.page.waitForTimeout(30_000);
  const bytes = b.stats.bytesIn + b.stats.bytesOut - before.bytesIn - before.bytesOut;
  const frames = b.stats.framesIn + b.stats.framesOut - before.framesIn - before.framesOut;
  console.log(`steady state: ${frames} messages, ${bytes} bytes in 30s`);
  // Just the 15s keep-alive ping/pong: a few hundred bytes per minute.
  expect(bytes).toBeLessThan(600);
  const d = Math.abs((await yt(a.page)).t - (await yt(b.page)).t);
  expect(d).toBeLessThan(0.8);
});

test('high latency + slow connection: still syncs pause/play/seek', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const [a, b] = await people(browser, testInfo);
  // Make B's connection look like weak mobile data (400ms each way).
  const cdp = await b.ctx.newCDPSession(b.page);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 800, downloadThroughput: 20_000, uploadThroughput: 10_000 });
  await expect(b.page.locator('#presence')).toHaveText(/Watching with/);
  await loadVideo(a.page, 'https://youtu.be/dQw4w9WgXcQ'); // suggest; Bo accepts
  const synced = async (st, tol) => {
    const [x, y] = [await yt(a.page), await yt(b.page)];
    return x.st === st && y.st === st && Math.abs(x.t - y.t) <= tol;
  };
  await expect.poll(() => synced(1, 0.8), { timeout: 20_000 }).toBe(true);
  await b.page.locator('#toggle').click();
  await expect.poll(() => synced(2, 0.5), { timeout: 20_000 }).toBe(true);
  await b.page.locator('#fwd').click();
  await expect.poll(async () => (await yt(a.page)).t, { timeout: 20_000 }).toBeGreaterThan(9);
  await a.page.locator('#toggle').click();
  await expect.poll(() => synced(1, 0.8), { timeout: 20_000 }).toBe(true);
  // Stays in sync over a while even with the lag.
  for (let i = 0; i < 6; i++) {
    await a.page.waitForTimeout(1000);
    expect(await synced(1, 0.8)).toBe(true);
  }
});

test('flaky connection: repeated drops never desync or double-act', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const [a, b] = await people(browser, testInfo);
  await loadVideo(a.page, 'https://youtu.be/dQw4w9WgXcQ'); // suggest; Bo accepts
  await expect.poll(async () => (await yt(b.page)).st).toBe(1);
  for (let i = 0; i < 4; i++) {
    await b.ctx.setOffline(true);
    await b.page.evaluate(() => window.__wt.dropSocket());
    await a.page.waitForTimeout(700);
    await b.ctx.setOffline(false);
    await expect(b.page.locator('#presence')).toHaveText(/Watching with/, { timeout: 15_000 });
  }
  const seq = await a.page.evaluate(() => window.__wt.ctl.rs.seq);
  expect(seq).toBe(1); // no phantom actions from reconnecting
  await expect
    .poll(async () => Math.abs((await yt(a.page)).t - (await yt(b.page)).t) < 0.8 && (await yt(b.page)).st === 1, { timeout: 10_000 })
    .toBe(true);
});
