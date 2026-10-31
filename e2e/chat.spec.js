// Chat next to the video, and the "watched together" history, on two linked
// browsers through the real screens.
import { test, expect, couple, yt, expectSynced, loadVideo } from './people.js';

const V1 = 'dQw4w9WgXcQ';
const V2 = 'jNQXAC9IVRw';
const bubbles = (page) => page.locator('#chat-list .msg .bubble');

async function openChat(page) {
  if (await page.locator('#tab-chat').isVisible()) await page.locator('#tab-chat').click();
}

async function say(page, text) {
  await openChat(page);
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').click();
}

test('chat sits beside the video on a computer, and is the first tab on a phone', async ({ browser }, testInfo) => {
  const { a } = await couple(browser, testInfo);
  const phone = testInfo.project.name === 'iphone';
  await expect(a.locator('#chat')).toBeVisible();
  await expect(a.locator('#tab-chat')).toBeVisible({ visible: phone });
  if (!phone) {
    const video = await a.locator('#player-box').boundingBox();
    const chat = await a.locator('#chat').boundingBox();
    expect(chat.x).toBeGreaterThan(video.x + video.width - 1); // to the right of the video
    await expect(a.locator('#lists')).toBeVisible(); // playlists below
  } else {
    await expect(a.locator('#lists')).toBeHidden();
    await a.locator('#tab-lists').click();
    await expect(a.locator('#chat')).toBeHidden();
    await expect(a.locator('#lists')).toBeVisible();
  }
});

test('messages arrive instantly for the partner, in order, each on their own side', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await expect(a.locator('#chat-empty')).toContainText('Say hi to Bo!');
  await say(a, 'hi Bo!');
  await openChat(b);
  await expect(bubbles(b)).toHaveText(['hi Bo!']);
  await say(b, 'hey!\nready when you are');
  await expect(bubbles(a)).toHaveText(['hi Bo!', 'hey!\nready when you are']);
  expect(await a.locator('#chat-list .msg').evaluateAll((els) => els.map((e) => e.classList.contains('mine')))).toEqual([true, false]);
  expect(await b.locator('#chat-list .msg').evaluateAll((els) => els.map((e) => e.classList.contains('mine')))).toEqual([false, true]);
  await expect(a.locator('#chat-list .day')).toHaveText(['Today']);
  await expect(a.locator('#chat-list .msg.pending')).toHaveCount(0);
});

test('Enter sends on a computer; Shift+Enter makes a new line', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'iphone', 'phones use the Send button');
  const { a, b } = await couple(browser, testInfo);
  await a.locator('#chat-input').fill('first line');
  await a.locator('#chat-input').press('Shift+Enter');
  await a.locator('#chat-input').pressSequentially('second line');
  await a.locator('#chat-input').press('Enter');
  await expect(bubbles(b)).toHaveText(['first line\nsecond line']);
  await expect(a.locator('#chat-input')).toHaveValue('');
});

test('chat keeps working while watching, and play/pause are unaffected', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${V1}`);
  await expectSynced(a, b, { st: 1 });
  await say(b, 'love this one');
  await expect(bubbles(a)).toHaveText(['love this one']);
  await a.locator('#toggle').click();
  await expectSynced(a, b, { st: 2, tolerance: 0.35 });
  await say(a, 'brb');
  await expect(bubbles(b).last()).toHaveText('brb');
});

test('the chat is still there after reloading the page', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await openChat(a);
  for (let i = 1; i <= 12; i++) {
    await a.locator('#chat-input').fill(`message ${i}`);
    await a.locator('#chat-send').click();
  }
  await expect(a.locator('#chat-list .msg.pending')).toHaveCount(0);
  await b.reload();
  await openChat(b);
  await expect(bubbles(b)).toHaveCount(12);
  await expect(bubbles(b).last()).toHaveText('message 12');
});

test('a message you can\'t send says so, and can be retried', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await openChat(a);
  await a.context().setOffline(true);
  await a.evaluate(() => window.__wt.dropSocket());
  await say(a, 'are you there?');
  await expect(a.locator('#chat-list .msg.failed')).toHaveCount(1);
  await expect(a.locator('#chat-list .msg.failed .meta-line')).toContainText('Tap to retry');
  await a.context().setOffline(false);
  await expect(a.locator('#presence')).toHaveText('Watching with Bo', { timeout: 15_000 });
  await a.locator('#chat-list .msg.failed .meta-line button').click();
  await expect(a.locator('#chat-list .msg.failed')).toHaveCount(0);
  await openChat(b);
  await expect(bubbles(b)).toHaveText(['are you there?']);
});

test('messages sent while you were disconnected show up when you reconnect', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await openChat(b);
  await b.context().setOffline(true);
  await b.evaluate(() => window.__wt.dropSocket());
  await expect(b.locator('#presence')).toHaveText(/Reconnecting/);
  await say(a, 'missed me?');
  await b.context().setOffline(false);
  await expect(b.locator('#presence')).toHaveText('Watching with Alex', { timeout: 15_000 });
  await expect(bubbles(b)).toHaveText(['missed me?']);
});

test('on a phone, an unread badge shows on the Chat tab until you open it', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'the chat is always visible on a computer');
  const { a, b } = await couple(browser, testInfo);
  await b.locator('#tab-lists').click();
  await say(a, 'one');
  await say(a, 'two');
  await expect(b.locator('#chat-badge')).toHaveText('2');
  await b.locator('#tab-chat').click();
  await expect(b.locator('#chat-badge')).toBeHidden();
  await expect(bubbles(b)).toHaveText(['one', 'two']);
});

test('clearing the chat needs confirming and clears it for both', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await say(a, 'delete me');
  await openChat(b);
  await expect(bubbles(b)).toHaveCount(1);
  await b.locator('#chat-menu').click();
  await b.locator('#chat-clear-no').click();
  await expect(bubbles(a)).toHaveCount(1);
  await b.locator('#chat-menu').click();
  await b.locator('#chat-clear-yes').click();
  await expect(bubbles(a)).toHaveCount(0);
  await expect(bubbles(b)).toHaveCount(0);
  await a.reload();
  await openChat(a);
  await expect(a.locator('#chat-empty')).toBeVisible();
});

test('messages are shown as text: HTML can\'t run, long words wrap, too-long is refused', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  let dialogs = 0;
  b.on('dialog', (d) => (dialogs++, d.dismiss()));
  await say(a, '<img src=x onerror=alert(1)><script>alert(2)</script>');
  await openChat(b);
  await expect(bubbles(b)).toHaveText(['<img src=x onerror=alert(1)><script>alert(2)</script>']);
  expect(await b.locator('#chat-list img, #chat-list script').count()).toBe(0);
  await say(a, 'a'.repeat(300));
  const overflow = await b.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await a.locator('#chat-input').evaluate((el) => el.removeAttribute('maxlength'));
  await say(a, 'x'.repeat(501));
  await expect(a.locator('#chat-err')).toContainText('too long');
  expect(dialogs).toBe(0);
});

test('history: what you both watched, who picked it; declined ones aren\'t there', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${V1}`); // Alex suggests, Bo accepts
  await expectSynced(a, b, { st: 1 });
  await loadVideo(b, `https://youtu.be/${V2}`, { accept: false });
  await expect(a.locator('#proposal')).toBeVisible();
  await a.locator('#proposal-decline').click();
  await a.locator('#tab-history').click();
  await b.locator('#tab-history').click();
  await expect(a.locator('#history-list .item')).toHaveCount(1);
  await expect(a.locator('#history-list .item-title')).toHaveText(`Test video ${V1}`);
  await expect(a.locator('#history-list .small')).toContainText('picked by you');
  await expect(b.locator('#history-list .small')).toContainText('picked by Alex');
});

test('history: watch something again from it (partner still has to accept)', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${V1}`);
  await expectSynced(a, b, { st: 1 });
  await loadVideo(b, `https://youtu.be/${V2}`);
  await expect.poll(async () => (await yt(a)).vid).toBe(V2);
  await a.locator('#tab-history').click();
  await expect(a.locator('#history-list .item')).toHaveCount(2);
  await a.locator('#history-list .item').nth(1).getByRole('button', { name: /Suggest .* again/ }).click();
  await expect(b.locator('#proposal-who')).toHaveText('Alex wants to watch:');
  await b.locator('#proposal-accept').click();
  await expect.poll(async () => (await yt(b)).vid).toBe(V1);
});

test('history: remove one, or clear it all (with confirm), for both', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${V1}`);
  await expectSynced(a, b, { st: 1 });
  await loadVideo(a, `https://youtu.be/${V2}`);
  await expect.poll(async () => (await yt(b)).vid).toBe(V2);
  await a.locator('#tab-history').click();
  await b.locator('#tab-history').click();
  await expect(b.locator('#history-list .item')).toHaveCount(2);
  await a.locator('#history-list .item').first().getByRole('button', { name: /Remove/ }).click();
  await expect(b.locator('#history-list .item')).toHaveCount(1);
  await b.locator('#history-clear').click();
  await expect(b.locator('#history-clear-confirm')).toBeVisible();
  await b.locator('#history-clear-yes').click();
  await expect(a.locator('#history-empty')).toBeVisible();
});

test('chat and history fit a phone', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await say(a, 'Long message to check wrapping on a small screen — '.repeat(4));
  await openChat(b);
  await expect(bubbles(b)).toHaveCount(1);
  const overflow = await b.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const sel of ['#chat-send', '#chat-input', '#tab-history']) {
    const box = await b.locator(sel).boundingBox();
    expect(box.height, sel).toBeGreaterThanOrEqual(40);
  }
  const fs = await b.locator('#chat-input').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fs, 'no zoom-on-focus on iPhone').toBeGreaterThanOrEqual(16);
  await b.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-chat.png`), fullPage: true });
});
