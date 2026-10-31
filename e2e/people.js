// Helpers for browser tests: signed-in people, linked couples, fake YouTube.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const FAKE_YT = fs.readFileSync(path.resolve('e2e/fake-youtube.js'), 'utf8');
const GOOGLE = `http://127.0.0.1:${Number(process.env.E2E_PORT || 3123) + 1}`;
let n = 0;
const open = new Set(); // contexts made during the current test

// Use this `test` in spec files: every browser context a test opens through
// these helpers is closed when the test ends, so nothing piles up.
export const test = base.extend({
  _closeContexts: [
    async ({}, use) => {
      await use();
      await Promise.all([...open].map((c) => c.close().catch(() => {})));
      open.clear();
    },
    { auto: true },
  ],
});
export { expect };

// A browser context for one person. Only our server, the fake Google and the
// fake YouTube API can be reached.
export async function newPerson(browser, testInfo, { yt = {}, context = {}, realYouTube = false } = {}) {
  const ctx = await browser.newContext({ ...testInfo.project.use, ...context });
  open.add(ctx);
  if (!realYouTube) {
    await ctx.addInitScript((cfg) => (window.__fakeYT = cfg), yt);
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await ctx.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_YT }));
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    throw e;
  });
  return page;
}

// Click "Sign in with Google" and come back signed in as `name`.
export async function signIn(page, name, { sub = `google-${name}-${Date.now()}-${n++}`, path: start = '/' } = {}) {
  await fetch(`${GOOGLE}/next-user`, { method: 'POST', body: JSON.stringify({ sub, name, email: `${sub}@example.com` }) });
  if (start) await page.goto(start);
  await page.locator('#signin-btn').click();
  await expect(page.locator('#topbar-name, #room').first()).toBeAttached();
  await page.waitForLoadState('networkidle');
  return sub;
}

// Link two signed-in people through the real invite + approve screens.
export function setPartners(a, b) {
  partners.set(a, b);
  partners.set(b, a);
}

export async function linkViaUi(a, b) {
  await expect(a.locator('#screen-link')).toBeVisible();
  await a.locator('#invite-create').click();
  await expect(a.locator('#invite-url')).toHaveValue(/\/join#[A-Za-z0-9_-]{30,}$/);
  const url = await a.locator('#invite-url').inputValue();
  await b.goto(url);
  await b.locator('#join-yes').click();
  await expect(b.locator('#join-done-code')).toHaveText(/^\d{4}$/);
  const code = await b.locator('#join-done-code').textContent();
  await expect(a.locator('#incoming .code')).toHaveText(code);
  await a.locator('#incoming button.primary').click();
  await b.locator('#join-continue').click();
  await expect(a.locator('#room')).toBeVisible();
  await expect(b.locator('#room')).toBeVisible();
}

// Two people, signed in, linked, both in the watch room.
export async function couple(browser, testInfo, opts = {}) {
  const a = await newPerson(browser, testInfo, opts);
  const b = await newPerson(browser, testInfo, opts.b || opts);
  await signIn(a, 'Alex');
  await signIn(b, 'Bo');
  await linkViaUi(a, b);
  await expect(a.locator('#presence')).toHaveText('Watching with Bo');
  await expect(b.locator('#presence')).toHaveText('Watching with Alex');
  partners.set(a, b);
  partners.set(b, a);
  return { a, b };
}

// Player state as the fake player sees it.
export const yt = (page) =>
  page.evaluate(() => {
    const p = window.__wt && window.__wt.player;
    if (!p) return { st: null, t: 0, vid: null, muted: false };
    return { st: p.getPlayerState(), t: p.getCurrentTime(), vid: p.vid, muted: p.isMuted() };
  });

export async function expectSynced(a, b, { tolerance = 0.8, st } = {}) {
  await expect
    .poll(
      async () => {
        const [x, y] = await Promise.all([yt(a), yt(b)]);
        if (st != null && (x.st !== st || y.st !== st)) return `states ${x.st}/${y.st}`;
        if (x.vid !== y.vid) return `videos ${x.vid}/${y.vid}`;
        const d = Math.abs(x.t - y.t);
        return d <= tolerance ? 'ok' : `drift ${d.toFixed(2)}s (${x.t.toFixed(2)} vs ${y.t.toFixed(2)})`;
      },
      { timeout: 10_000, intervals: [200] }
    )
    .toBe('ok');
}

const partners = new WeakMap(); // page -> partner's page (set by couple())

// Paste a link and suggest it; the partner taps "Watch" on their banner, so
// it starts for both. (Invalid links never reach the partner.)
export async function loadVideo(page, link, { accept = true } = {}) {
  await page.locator('#url').fill(link);
  await page.locator('#suggest').click();
  const partner = partners.get(page);
  if (!accept || !partner || !(await page.locator('#load-err').isHidden())) return;
  await expect(partner.locator('#proposal-accept')).toBeVisible();
  await partner.locator('#proposal-accept').click();
}
