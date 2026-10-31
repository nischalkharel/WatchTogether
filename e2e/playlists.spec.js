// Shared "watch later" playlists and the accept-before-playing rule, through
// the real screens on two linked browsers.
import { test, expect, couple as linkedCouple, yt, expectSynced, loadVideo } from './people.js';

// A linked couple with the "Watch later" tab open (on a phone, Chat is the
// default tab; on a computer the playlists already show).
async function couple(browser, testInfo, opts) {
  const pair = await linkedCouple(browser, testInfo, opts);
  for (const p of [pair.a, pair.b]) await p.locator('#tab-lists').click();
  return pair;
}

const V1 = 'dQw4w9WgXcQ';
const V2 = 'jNQXAC9IVRw';
const titles = (page) => page.locator('#list-items .item-title').allTextContents();

async function save(page, link) {
  await page.locator('#url').fill(link);
  await page.locator('#save-link').click();
}

test('save a link for later; the partner sees it straight away', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await expect(a.locator('#list-empty')).toContainText('Make a playlist');
  await save(a, `https://youtu.be/${V1}`);
  await expect(a.locator('#toast')).toHaveText('Saved to “Watch later”');
  await expect(b.locator('#list-items .item')).toHaveCount(1);
  await expect(b.locator('#list-items .small')).toHaveText('Added by Alex');
  await expect(a.locator('#list-items .small')).toHaveText('Added by you');
  expect((await yt(a)).vid, 'saving does not play anything').toBe(null);
});

test('pick from the playlist: partner must accept before it plays for both', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await save(b, `https://youtu.be/${V1}`);
  await expect(a.locator('#list-items .item')).toHaveCount(1);
  await a.locator('#list-items .btn.primary').click(); // ▶ Suggest
  await expect(b.locator('#proposal')).toBeVisible();
  await expect(b.locator('#proposal-who')).toHaveText('Alex wants to watch:');
  await expect(a.locator('#proposal-who')).toHaveText('Waiting for Bo to accept…');
  await a.waitForTimeout(800);
  expect((await yt(a)).vid).toBe(null);
  expect((await yt(b)).vid).toBe(null);
  await b.locator('#proposal-accept').click();
  await expectSynced(a, b, { st: 1 });
  expect((await yt(a)).vid).toBe(V1);
  // The playing video is highlighted, and its real title fills in for both.
  await expect(a.locator('#list-items .item.playing')).toHaveCount(1);
  await expect(b.locator('#list-items .item-title')).toHaveText(`Test video ${V1}`);
});

test('"Not now" declines: nothing plays and the suggester is told', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${V1}`, { accept: false });
  await expect(b.locator('#proposal')).toBeVisible();
  await b.locator('#proposal-decline').click();
  await expect(a.locator('#proposal')).toBeHidden();
  await expect(b.locator('#proposal')).toBeHidden();
  await expect(a.locator('#toast')).toContainText('Bo said not now');
  expect((await yt(a)).vid).toBe(null);
});

test('the suggester can cancel before the partner answers', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${V1}`, { accept: false });
  await expect(b.locator('#proposal')).toBeVisible();
  await expect(a.locator('#proposal-decline')).toHaveText('Cancel');
  await a.locator('#proposal-decline').click();
  await expect(b.locator('#proposal')).toBeHidden();
  await expect(b.locator('#toast')).toContainText('Alex took back their suggestion');
});

test('a new video while one is playing also needs accepting; the old one keeps going', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${V1}`);
  await expectSynced(a, b, { st: 1 });
  await loadVideo(b, `https://youtu.be/${V2}`, { accept: false });
  await expect(a.locator('#proposal')).toBeVisible();
  await a.waitForTimeout(1000);
  expect((await yt(a)).vid).toBe(V1);
  await expectSynced(a, b, { st: 1 });
  await a.locator('#proposal-accept').click();
  await expect.poll(async () => (await yt(b)).vid).toBe(V2);
  await expectSynced(a, b, { st: 1 });
});

test('a suggestion survives reloading the page', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${V1}`, { accept: false });
  await expect(b.locator('#proposal')).toBeVisible();
  await b.reload();
  await expect(b.locator('#proposal-who')).toHaveText('Alex wants to watch:');
  await b.locator('#proposal-accept').click();
  await expectSynced(a, b, { st: 1 });
});

test('several playlists: create, switch, rename, delete (with confirm)', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  const newList = async (name) => {
    await a.locator('#list-new').click();
    await a.locator('#list-new-name').fill(name);
    await a.locator('#list-new-form button[type=submit]').click();
    await expect(a.locator('#list-new-form')).toBeHidden();
  };
  await newList('Movie night');
  await save(a, `https://youtu.be/${V1}`);
  await expect(a.locator('#list-pick option')).toHaveText(['Movie night (1)']);
  await newList('Cooking');
  await save(a, `https://youtu.be/${V2}`);
  await expect(a.locator('#list-pick option')).toHaveText(['Movie night (1)', 'Cooking (1)']);
  await expect(b.locator('#list-pick option')).toHaveText(['Movie night (1)', 'Cooking (1)']);

  await b.locator('#list-pick').selectOption({ label: 'Movie night (1)' });
  await expect(b.locator('#list-items .item')).toHaveCount(1);

  await a.locator('#list-menu').click();
  await a.locator('#list-edit-name').fill('Cooking shows');
  await a.locator('#list-rename').click();
  await expect(b.locator('#list-pick option')).toHaveText(['Movie night (1)', 'Cooking shows (1)']);

  await a.locator('#list-menu').click();
  await a.locator('#list-delete').click();
  await expect(a.locator('#list-delete-confirm')).toContainText('Cooking shows');
  await a.locator('#list-delete-no').click();
  await expect(a.locator('#list-pick option')).toHaveCount(2);
  await a.locator('#list-menu').click();
  await a.locator('#list-delete').click();
  await a.locator('#list-delete-yes').click();
  await expect(b.locator('#list-pick option')).toHaveText(['Movie night (1)']);
});

test('reorder and remove, seen by both', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await save(a, `https://youtu.be/${V1}`);
  await expect(a.locator('#list-items .item')).toHaveCount(1);
  await save(a, `https://youtu.be/${V2}`);
  await expect(b.locator('#list-items .item')).toHaveCount(2);
  const order = () => b.locator('#list-items img').evaluateAll((els) => els.map((e) => e.src.split('/vi/')[1].slice(0, 11)));
  expect(await order()).toEqual([V1, V2]);
  await a.locator('#list-items .item').nth(1).getByRole('button', { name: 'Move up' }).click();
  await expect.poll(order).toEqual([V2, V1]);
  await expect(a.locator('#list-items .item').first().getByRole('button', { name: 'Move up' })).toBeDisabled();
  await b.locator('#list-items .item').first().getByRole('button', { name: /^Remove/ }).click();
  await expect(a.locator('#list-items .item')).toHaveCount(1);
});

test('saving the same video twice is explained, not duplicated', async ({ browser }, testInfo) => {
  const { a } = await couple(browser, testInfo);
  await save(a, `https://youtu.be/${V1}`);
  await expect(a.locator('#list-items .item')).toHaveCount(1);
  await save(a, `https://www.youtube.com/watch?v=${V1}`);
  await expect(a.locator('#toast')).toHaveText('That video is already in this playlist.');
  await expect(a.locator('#list-items .item')).toHaveCount(1);
});

test('"+ Save what\'s playing" adds the current video with its title', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${V1}`);
  await expectSynced(a, b, { st: 1 });
  await a.locator('#list-new').click();
  await a.locator('#list-new-name').fill('Faves');
  await a.locator('#list-new-form button[type=submit]').click();
  await expect(a.locator('#save-current')).toBeVisible();
  await a.locator('#save-current').click();
  await expect(b.locator('#list-items .item-title')).toHaveText(`Test video ${V1}`);
  await expect(a.locator('#save-current')).toBeHidden();
});

test('titles with HTML are shown as text, never run', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  let dialogs = 0;
  b.on('dialog', (d) => (dialogs++, d.dismiss()));
  // Straight to the API, as an attacker would.
  await a.evaluate(async () => {
    const me = await (await fetch('/api/me')).json();
    const h = { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf };
    const pl = await (await fetch('/api/playlists/create', { method: 'POST', headers: h, body: JSON.stringify({ name: '<b>x</b>' }) })).json();
    await fetch('/api/playlists/add', { method: 'POST', headers: h, body: JSON.stringify({ playlist: pl.id, v: 'dQw4w9WgXcQ', title: '<img src=x onerror=alert(1)>' }) });
    await fetch('/api/propose', { method: 'POST', headers: h, body: JSON.stringify({ v: 'jNQXAC9IVRw', title: '<img src=x onerror=alert(2)>' }) });
  });
  await expect(b.locator('#list-items .item-title')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(b.locator('#proposal-title')).toHaveText('<img src=x onerror=alert(2)>');
  expect(await b.locator('#list-items img:not(.thumb), #proposal-title img').count()).toBe(0);
  await expect(b.locator('#list-pick option')).toHaveText(['<b>x</b> (1)']);
  await b.waitForTimeout(500);
  expect(dialogs).toBe(0);
});

test('playlists and banner fit a phone', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await save(a, `https://youtu.be/${V1}`);
  await loadVideo(a, `https://youtu.be/${V2}`, { accept: false });
  await expect(b.locator('#proposal')).toBeVisible();
  await expect(b.locator('#list-items .item')).toHaveCount(1);
  const overflow = await b.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const sel of ['#proposal-accept', '#proposal-decline', '#list-new', '#list-items .btn.primary', '#save-link', '#suggest']) {
    const box = await b.locator(sel).first().boundingBox();
    expect(box.height, sel).toBeGreaterThanOrEqual(40);
  }
  await b.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-playlists.png`), fullPage: true });
});

test('creating a playlist and saving straight away puts the video in the new list', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await a.locator('#list-new').click();
  await a.locator('#list-new-name').fill('Quick');
  await a.locator('#list-new-name').press('Enter');
  await save(a, `https://youtu.be/${V1}`); // no waiting in between
  await expect(b.locator('#list-pick option')).toHaveText(['Quick (1)']);
});
