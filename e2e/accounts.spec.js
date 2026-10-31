// Accounts, private linking and privacy controls, through the real screens.
import { test, expect, couple, newPerson, signIn, linkViaUi, loadVideo, yt, expectSynced } from './people.js';

const VID = 'dQw4w9WgXcQ';

test('signed out: sign-in options only, and a clear privacy promise', async ({ browser }, testInfo) => {
  const page = await newPerson(browser, testInfo);
  await page.goto('/');
  await expect(page.locator('#signin-btn')).toBeVisible();
  await expect(page.locator('#screen-signin')).toContainText('Your email is never asked for or stored');
  await expect(page.locator('#room')).toBeHidden();
  await expect(page.locator('#topbar')).toBeHidden();
  // The only inputs are the private login form: no email, search or room box.
  const ids = await page.locator('input:visible').evaluateAll((els) => els.map((e) => e.id));
  expect(ids.sort()).toEqual(['pw-pass', 'pw-user']);
  expect(await page.locator('input[type=email]').count()).toBe(0);
});

test('sign in with Google lands on the "link with your partner" screen', async ({ browser }, testInfo) => {
  const page = await newPerson(browser, testInfo);
  await signIn(page, 'Alex Example');
  await expect(page.locator('#screen-link')).toBeVisible();
  await expect(page.locator('#topbar-name')).toHaveText('Alex');
  await expect(page.locator('#invite-create')).toBeVisible();
});

test('full linking flow: invite link, matching codes, approve, watch together', async ({ browser }, testInfo) => {
  const a = await newPerson(browser, testInfo);
  const b = await newPerson(browser, testInfo);
  await signIn(a, 'Alex');
  await signIn(b, 'Bo');
  await a.locator('#invite-create').click();
  await expect(a.locator('#invite-url')).toHaveValue(/\/join#/);
  await expect(a.locator('#invite-made')).toContainText('Expires in 24 hours');
  const url = await a.locator('#invite-url').inputValue();

  await b.goto(url);
  expect(new URL(b.url()).hash).toBe('', 'secret removed from the address bar');
  await expect(b.locator('#join-name')).toHaveText('Alex');
  await b.locator('#join-yes').click();
  await expect(b.locator('#join-done-code')).toHaveText(/^\d{4}$/);
  const code = await b.locator('#join-done-code').textContent();

  // Alex's screen updates by itself (no reload) with Bo's request and the same code.
  await expect(a.locator('#incoming')).toContainText('Bo');
  await expect(a.locator('#incoming .code')).toHaveText(code);
  await a.locator('#incoming button.primary').click();
  await expect(a.locator('#room')).toBeVisible();
  await expect(a.locator('#presence')).toHaveText(/Bo/);

  await b.locator('#join-continue').click();
  await expect(b.locator('#presence')).toHaveText('Watching with Alex');
  await expect(a.locator('#presence')).toHaveText('Watching with Bo');
});

test('opening an invite while signed out: sign in, then come straight back to it', async ({ browser }, testInfo) => {
  const a = await newPerson(browser, testInfo);
  await signIn(a, 'Alex');
  await a.locator('#invite-create').click();
  await expect(a.locator('#invite-url')).toHaveValue(/\/join#/);
  const url = await a.locator('#invite-url').inputValue();

  const b = await newPerson(browser, testInfo);
  await b.goto(url);
  await expect(b.locator('#signin-join-note')).toBeVisible();
  await signIn(b, 'Bo', { path: null });
  await expect(b.locator('#join-name')).toHaveText('Alex');
  // The invite secret never went to Google.
  expect(b.url()).not.toContain(url.split('#')[1]);
});

test('the inviter declines a stranger whose code doesn\'t match', async ({ browser }, testInfo) => {
  const a = await newPerson(browser, testInfo);
  const stranger = await newPerson(browser, testInfo);
  await signIn(a, 'Alex');
  await signIn(stranger, 'Stranger');
  await a.locator('#invite-create').click();
  await expect(a.locator('#invite-url')).toHaveValue(/\/join#/);
  await stranger.goto(await a.locator('#invite-url').inputValue());
  await stranger.locator('#join-yes').click();
  await expect(a.locator('#incoming')).toContainText('Stranger');
  await a.locator('#incoming button:not(.primary)').click();
  await expect(a.locator('#incoming-box')).toBeHidden();
  await expect(a.locator('#room')).toBeHidden();
  await stranger.locator('#join-continue').click();
  await expect(stranger.locator('#outgoing-box')).toBeHidden();
  await expect(stranger.locator('#screen-link')).toBeVisible();
});

test('a used invite link can\'t be used again', async ({ browser }, testInfo) => {
  const a = await newPerson(browser, testInfo);
  const b = await newPerson(browser, testInfo);
  const c = await newPerson(browser, testInfo);
  await signIn(a, 'Alex');
  await signIn(b, 'Bo');
  await signIn(c, 'Cy');
  await a.locator('#invite-create').click();
  await expect(a.locator('#invite-url')).toHaveValue(/\/join#/);
  const url = await a.locator('#invite-url').inputValue();
  await b.goto(url);
  await b.locator('#join-yes').click();
  await expect(b.locator('#join-done')).toBeVisible();
  await c.goto(url);
  await expect(c.locator('#join-err')).toContainText('expired, was already used, or was cancelled');
  await expect(c.locator('#join-ask')).toBeHidden();
});

test('account page: rename shows up for the partner live', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await a.locator('#room .icon-link').click();
  await expect(a.locator('#screen-account')).toBeVisible();
  await expect(a.locator('#acct-partner')).toHaveText('Bo');
  await a.locator('#acct-name').fill('Lexi');
  await a.locator('#acct-name-save').click();
  await expect(a.locator('#acct-name-ok')).toBeVisible();
  await b.reload();
  await expect(b.locator('#presence')).toHaveText('Watching with Lexi');
});

test('names are shown as text: HTML in a name can\'t run on the partner\'s screen', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  let dialogs = 0;
  b.on('dialog', (d) => (dialogs++, d.dismiss()));
  await a.goto('/account');
  await a.locator('#acct-name').fill('<img src=x onerror=alert(1)>');
  await a.locator('#acct-name-save').click();
  await expect(a.locator('#acct-name-ok')).toBeVisible();
  await b.reload();
  await expect(b.locator('#presence')).toHaveText(/(Watching with|Waiting for) <img src=x onerror=alert\(1\)>/);
  expect(await b.locator('#presence img').count()).toBe(0);
  await b.waitForTimeout(500);
  expect(dialogs).toBe(0);
});

test('unlink: needs confirming, then both people leave the room immediately', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${VID}`);
  await expectSynced(a, b, { st: 1 });
  await a.goto('/account');
  await a.locator('#acct-unlink').click();
  await expect(a.locator('#unlink-confirm')).toBeVisible();
  await a.locator('#unlink-yes').click();
  await expect(a.locator('#acct-partner')).toHaveText('Not linked yet');
  // Bo's room closes by itself and the player is gone.
  await expect(b.locator('#room')).toBeHidden();
  await expect(b.locator('#screen-link')).toBeVisible();
  await expect(b.locator('#toast')).toHaveText('You are no longer linked');
  expect(await b.evaluate(() => !!window.__wt)).toBe(false);
});

test('linking again after unlinking starts with a fresh, empty room', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await loadVideo(a, `https://youtu.be/${VID}`);
  await expectSynced(a, b, { st: 1 });
  await a.goto('/account');
  await a.locator('#acct-unlink').click();
  await a.locator('#unlink-yes').click();
  await a.goto('/');
  await expect(b.locator('#screen-link')).toBeVisible();
  await linkViaUi(a, b);
  await expect(a.locator('#empty')).toBeVisible();
  expect((await yt(a)).vid).toBe(null);
});

test('sign out, and sign out on all devices', async ({ browser }, testInfo) => {
  const { a } = await couple(browser, testInfo);
  const laptop = await newPerson(browser, testInfo, { context: { storageState: await a.context().storageState() } });
  await laptop.goto('/');
  await expect(laptop.locator('#room')).toBeVisible();

  await a.goto('/account');
  await a.locator('#acct-signout-all').click();
  await expect(a.locator('#signin-btn')).toBeVisible();
  await expect(a.locator('#toast')).toHaveText('Signed out on all your devices');
  // The other device is kicked out of the room right away.
  await expect(laptop.locator('#room')).toBeHidden({ timeout: 5000 });
  await laptop.reload();
  await expect(laptop.locator('#signin-btn')).toBeVisible();
});

test('download my data', async ({ browser }, testInfo) => {
  const { a } = await couple(browser, testInfo);
  await a.goto('/account');
  const [download] = await Promise.all([a.waitForEvent('download'), a.locator('#acct-export').click()]);
  const path = await download.path();
  const data = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'));
  expect(data.account.name).toBe('Alex');
  expect(data.partner.name).toBe('Bo');
  expect(JSON.stringify(data)).not.toContain('@');
});

test('delete account: needs typing DELETE, then partner is freed', async ({ browser }, testInfo) => {
  const { a, b } = await couple(browser, testInfo);
  await a.goto('/account');
  await expect(a.locator('#delete-go')).toBeDisabled();
  await a.locator('#delete-confirm').fill('delete please');
  await expect(a.locator('#delete-go')).toBeDisabled();
  await a.locator('#delete-confirm').fill('DELETE');
  await a.locator('#delete-go').click();
  await expect(a.locator('#signin-btn')).toBeVisible();
  await expect(a.locator('#toast')).toContainText('deleted');
  await expect(b.locator('#room')).toBeHidden();
  await expect(b.locator('#screen-link')).toBeVisible();
});

test('privacy page is reachable signed out', async ({ browser }, testInfo) => {
  const page = await newPerson(browser, testInfo);
  await page.goto('/');
  await page.locator('a[href="/privacy"]').first().click();
  await expect(page.locator('#screen-privacy')).toBeVisible();
  await expect(page.locator('#screen-privacy')).toContainText('Your email, photo, contacts or location');
  await expect(page.locator('#screen-privacy')).toContainText('Your chat with your partner');
  await expect(page.locator('#screen-privacy')).toContainText('What you’ve watched together');
});

test('account screens fit a phone with no sideways scrolling', async ({ browser }, testInfo) => {
  const { a } = await couple(browser, testInfo);
  for (const p of ['/', '/account', '/privacy']) {
    await a.goto(p);
    await a.waitForLoadState('networkidle');
    const overflow = await a.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, p).toBeLessThanOrEqual(0);
  }
  await a.goto('/account');
  await expect(a.locator('#screen-account')).toBeVisible();
  for (const sel of ['#acct-name-save', '#acct-signout', '#acct-export', '#delete-go']) {
    const box = await a.locator(sel).boundingBox();
    expect(box.height, sel).toBeGreaterThanOrEqual(44);
  }
  await a.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-account.png`), fullPage: true });
});
