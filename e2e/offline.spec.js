// Username + password sign-in on a server with NO Google keys, exactly what
// you get from `npm start` with no setup.
import { test, expect, newPerson, yt, expectSynced, loadVideo, setPartners } from './people.js';

const BASE = 'http://127.0.0.1:3125';
const PASS = 'purple-otter-sings-42';
let n = 0;
const uname = (b) => `${b}${Date.now().toString(36)}${n++}`;

async function person(browser, testInfo) {
  return newPerson(browser, testInfo, { context: { baseURL: BASE } });
}

async function createAccount(page, username, name, password = PASS) {
  await page.goto('/');
  await page.locator('#tab-signup').click();
  await page.locator('#pw-name').fill(name);
  await page.locator('#pw-user').fill(username);
  await page.locator('#pw-pass').fill(password);
  await page.locator('#pw-submit').click();
}

async function link(a, b) {
  await a.locator('#invite-create').click();
  await expect(a.locator('#invite-url')).toHaveValue(/\/join#/);
  await b.goto(await a.locator('#invite-url').inputValue());
  await b.locator('#join-yes').click();
  await expect(b.locator('#join-done-code')).toHaveText(/^\d{4}$/);
  await expect(a.locator('#incoming .code')).toHaveText(await b.locator('#join-done-code').textContent());
  await a.locator('#incoming button.primary').click();
  await b.locator('#join-continue').click();
  setPartners(a, b);
}

test('no Google set up: Google button is visible but greyed out, password form works', async ({ browser }, testInfo) => {
  const page = await person(browser, testInfo);
  await page.goto('/');
  await expect(page.locator('#signin-btn')).toBeVisible();
  await expect(page.locator('#signin-btn')).toBeDisabled();
  await expect(page.locator('#signin-off')).toHaveText(/isn’t set up on this server/);
  await expect(page.locator('#pw-form')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-signin.png`), fullPage: true });
});

test('create two accounts, link them, and watch together, all offline', async ({ browser }, testInfo) => {
  const a = await person(browser, testInfo);
  const b = await person(browser, testInfo);
  await createAccount(a, uname('alex'), 'Alex');
  await expect(a.locator('#screen-link')).toBeVisible();
  await expect(a.locator('#topbar-name')).toHaveText('Alex');
  await createAccount(b, uname('bo'), 'Bo');
  await expect(b.locator('#screen-link')).toBeVisible();
  await link(a, b);
  await expect(a.locator('#presence')).toHaveText('Watching with Bo');
  await expect(b.locator('#presence')).toHaveText('Watching with Alex');
  await loadVideo(a, 'https://youtu.be/dQw4w9WgXcQ');
  await expectSynced(a, b, { st: 1 });
  await b.locator('#toggle').click();
  await expectSynced(a, b, { st: 2, tolerance: 0.35 });
});

test('sign out and back in with username + password (any capitalisation)', async ({ browser }, testInfo) => {
  const page = await person(browser, testInfo);
  const user = uname('cy');
  await createAccount(page, user, 'Cy');
  await expect(page.locator('#screen-link')).toBeVisible();
  await page.goto('/account');
  await page.locator('#acct-signout').click();
  await expect(page.locator('#pw-form')).toBeVisible();
  await page.locator('#pw-user').fill(user.toUpperCase());
  await page.locator('#pw-pass').fill(PASS);
  await page.locator('#pw-submit').click();
  await expect(page.locator('#topbar-name')).toHaveText('Cy');
});

test('wrong password shows a clear error and does not sign in', async ({ browser }, testInfo) => {
  const page = await person(browser, testInfo);
  const user = uname('dee');
  await createAccount(page, user, 'Dee');
  await expect(page.locator('#screen-link')).toBeVisible();
  const other = await person(browser, testInfo);
  await other.goto('/');
  await other.locator('#pw-user').fill(user);
  await other.locator('#pw-pass').fill('not-the-right-one');
  await other.locator('#pw-submit').click();
  await expect(other.locator('#signin-err')).toHaveText('Wrong username or password.');
  await expect(other.locator('#topbar')).toBeHidden();
});

test('weak passwords and taken usernames are explained', async ({ browser }, testInfo) => {
  const page = await person(browser, testInfo);
  await createAccount(page, uname('eve'), 'Eve', 'short');
  await expect(page.locator('#signin-err')).toContainText('at least 10 characters');
  await page.locator('#pw-pass').fill('password123');
  await page.locator('#pw-submit').click();
  await expect(page.locator('#signin-err')).toContainText('too easy to guess');

  const taken = uname('taken');
  const first = await person(browser, testInfo);
  await createAccount(first, taken, 'First');
  await expect(first.locator('#screen-link')).toBeVisible();
  await createAccount(page, taken, 'Second');
  await expect(page.locator('#signin-err')).toContainText('That username is taken');
});

test('change password on the account page; old one stops working', async ({ browser }, testInfo) => {
  const page = await person(browser, testInfo);
  const user = uname('fay');
  await createAccount(page, user, 'Fay');
  await expect(page.locator('#screen-link')).toBeVisible();
  await page.goto('/account');
  await expect(page.locator('#pw-section-info')).toContainText(user);
  await page.locator('#pw-current').fill(PASS);
  await page.locator('#pw-new').fill('a-brand-new-password-7');
  await page.locator('#pw-change-save').click();
  await expect(page.locator('#pw-change-ok')).toBeVisible();

  const other = await person(browser, testInfo);
  await other.goto('/');
  await other.locator('#pw-user').fill(user);
  await other.locator('#pw-pass').fill(PASS);
  await other.locator('#pw-submit').click();
  await expect(other.locator('#signin-err')).toHaveText('Wrong username or password.');
  await other.locator('#pw-pass').fill('a-brand-new-password-7');
  await other.locator('#pw-submit').click();
  await expect(other.locator('#topbar-name')).toHaveText('Fay');
});

test('the partner never sees your username, only your display name', async ({ browser }, testInfo) => {
  const a = await person(browser, testInfo);
  const b = await person(browser, testInfo);
  const secret = uname('hiddenlogin');
  await createAccount(a, secret, 'Alex');
  await createAccount(b, uname('bo'), 'Bo');
  await expect(a.locator('#screen-link')).toBeVisible();
  await expect(b.locator('#screen-link')).toBeVisible();
  await link(a, b);
  await expect(b.locator('#room')).toBeVisible();
  expect(await b.content()).not.toContain(secret);
  await b.goto('/account');
  expect(await b.content()).not.toContain(secret);
});

test('sign-in screen fits a phone, with big enough buttons and no zoom-on-focus', async ({ browser }, testInfo) => {
  const page = await person(browser, testInfo);
  await page.goto('/');
  await page.locator('#tab-signup').click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const sel of ['#pw-submit', '#tab-login', '#tab-signup', '#signin-btn']) {
    const box = await page.locator(sel).boundingBox();
    expect(box.height, sel).toBeGreaterThanOrEqual(40);
  }
  for (const sel of ['#pw-user', '#pw-pass', '#pw-name']) {
    const fs = await page.locator(sel).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fs, sel).toBeGreaterThanOrEqual(16);
  }
});
