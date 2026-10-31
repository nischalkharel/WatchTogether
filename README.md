# Watch Together

Watch YouTube videos in sync with your partner. You each sign in (with a
username and password, or optionally Google), link your two accounts once with
a private invite, and from then on whatever
one of you plays, pauses or skips happens for both. It works on iPhone and on a
computer.

## Privacy and security, in short

- **No email, ever.** Sign in with a username and password (no email needed),
  or with Google, which only gives the app your first name. Your email is never
  asked for, received or stored. Your username is private: nobody else sees it.
- **Nobody can find you.** There is no search, no user list, no public rooms.
  The only way to link is an invite link you create and send yourself.
- **You approve every link.** Opening your invite doesn't link anyone. It sends
  you a request showing a 4-digit code, and you accept only if the code matches
  your partner's screen. Invite links work once and expire after 24 hours.
- **Your chat and history are just yours.** Only the two of you can read them,
  either of you can clear them, and they're deleted for good if you unlink or
  either of you deletes your account. They're stored on your server (that's
  how they're still there tomorrow); the app's Privacy page lists everything stored.
- **Nothing new plays without both of you.** A new video only starts once the
  other person accepts it, and that's enforced by the server, not just the page.
- **Only two linked accounts can watch together.** Each account can have one
  partner. The server works out your room from your sign-in, so there is no
  room address to share or guess.
- **You're in control.** From the account page you can rename yourself, unlink,
  sign out (on one device or all of them), download your data, or delete your
  account and everything stored about you.
- **Hard to attack.** Passwords are hashed with scrypt (slow and memory-hard,
  so a stolen database can't be cracked quickly) and never stored. Password
  guessing is rate limited per username and per address, and a wrong username
  gets the same answer, at the same speed, as a wrong password. Google sign-in
  is checked properly (PKCE, signature, audience, expiry and nonce). Session cookies are `HttpOnly`,
  `SameSite`, `Secure` and `__Host-` on https, and the database only stores
  one-way hashes of them. Every change is checked for its origin and a CSRF
  token. Logins and invite attempts are rate limited. Strict security headers are
  set, and nothing on the page runs inline scripts.
- **Data isn't lost.** One SQLite database file with crash-safe settings, what
  you were watching saved every couple of seconds, checked automatic backups,
  and a tested restore command (see [Backups](#backups)).

The full list of what's stored is on the app's **Privacy** page.

## Run it

Needs [Node.js](https://nodejs.org) **22.5 or newer** (it uses Node's built-in
SQLite, so there's no database to install).

```sh
npm install
npm start
```

Open http://localhost:3000, choose **Create account**, and pick a username and
password. Your partner does the same, then you link (see [Using it](#using-it)).
No Google setup is needed. The Google button shows greyed out until you add keys.

## Optional: Google sign-in (about 10 minutes)

If you'd also like a "Sign in with Google" button, you need your own free Google
"OAuth client". Only you can create it. Without it, everything else works.

1. Go to <https://console.cloud.google.com/>, sign in, and create a project
   (any name, e.g. "Watch Together").
2. **APIs & Services → OAuth consent screen**: choose **External**, fill in an
   app name and your email, and save. You don't need to add any scopes; the
   default `openid` and `profile` are all this app uses. While the app is in
   "Testing" mode, add your and your partner's Google accounts under **Test
   users**. Only those accounts can sign in, which suits a two-person app.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `https://YOUR-SITE/auth/google/callback`
     (for trying it on your computer, add `http://localhost:3000/auth/google/callback` too)
4. Copy the **Client ID** and **Client secret**, then start with both set:
   `GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm start`.

Someone who signed up with Google can add a username and password on their
account page as a second way in.

### Settings

| Variable | What it's for |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional, turns on Google sign-in (see above). Keep the secret secret. |
| `PUBLIC_URL` | Your site's address, e.g. `https://watch.example.com`. Must be https (except on localhost). |
| `NODE_ENV=production` | Set this when it's online: the app then refuses to start without https. |
| `DATA_DIR` | Where the database goes (default `./data`). Must be on a disk that survives restarts. |
| `BACKUP_DIR` | Where backups go (default `DATA_DIR/backups`). Use a different disk if you can. |
| `BACKUP_EVERY_HOURS` | Default 6. `BACKUP_KEEP` (default 28) is how many to keep, so a week's worth. |
| `TRUST_PROXY=1` | Set if your host puts a proxy in front (most do), so rate limits see real addresses. |
| `PORT` | Usually set by your host. |

## Putting it online

Any host that runs Node 22 with WebSockets **and a persistent disk** works
(Fly.io with a volume, Railway with a volume, Render with a disk, or a small
VPS). Settings:

- Start command: `npm start`
- Health check path: `/healthz`
- Environment: `NODE_ENV=production`, `PUBLIC_URL`, `TRUST_PROXY=1`, and
  `DATA_DIR` pointing at the persistent disk. Add `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` too if you want Google sign-in, plus
  `https://YOUR-SITE/auth/google/callback` as a redirect URI in Google.
- Passwords are only safe over **https**, which `NODE_ENV=production` enforces.

⚠️ Without a persistent disk, every deploy wipes the database, and you'd both
need to sign in and link again.

## Backups

Every 6 hours the server writes a complete, checked copy of the database to
`BACKUP_DIR`, keeping the newest 28. To restore one, stop the server and run:

```sh
npm run restore -- data/backups/watch-2026-10-29T12-00-00-000Z.db
npm start
```

The database being replaced is kept next to it (`watch.db.before-restore-…`),
so a restore can be undone. A damaged backup is refused and nothing is changed.

**Copy the backups off the server sometimes** (or set `BACKUP_DIR` to a
separate disk). Backups on the same disk as the data won't help if that disk
itself fails. The app prints a note at startup when they share a disk.

## Using it

- **First time:** **Create account** (or sign in) → **Create invite link** → send it to your partner →
  they open it and press **Yes** → you check the 4-digit codes match → **Accept**.
- **Paste a YouTube link** and press **Suggest** (or **Paste**). Your partner
  sees "Alex wants to watch: …" and taps **Watch** to start it for both of you,
  or **Not now**. Nothing new plays until the other person accepts. If they're
  not online, the suggestion waits for them (up to a day). You can **Cancel**
  your own suggestion. Links with a timestamp (`?t=95`) start there. Shorts and
  `youtu.be` links work too.
- **Watch later:** press **Save** instead to put a link in a shared playlist.
  Either of you can make playlists (e.g. "Movie night"), add, reorder and remove
  videos, and press **▶ Suggest** on one when you're both free. That suggests
  it the same way, so the other still has to accept. **+ Save what's playing**
  adds the current video.
- **Chat:** on a computer it's beside the video; on a phone it's the first tab
  under the controls (with a badge for unread messages). Enter sends on a
  computer, Shift+Enter makes a new line. Messages are kept when you reload or
  come back later. The newest 1,000 are kept, and either of you can clear it.
- **History:** the **History** tab lists everything you've both accepted, with
  who picked it and when. Press **▶ Again** to suggest one again, or remove
  entries / clear it all.
- **Play / pause / −10 / +10 / the seek bar** apply to both of you. YouTube's own
  controls inside the video work too.
- **Forgot your password?** There's no email, so there's no reset link.
  Whoever runs the server can set a new one with
  `npm run reset-password -- <username>` (it signs that account out
  everywhere). A password manager, or adding Google as a second way in, avoids
  needing it.
- On a computer: <kbd>Space</kbd>/<kbd>K</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> 5s, <kbd>J</kbd>/<kbd>L</kbd> 10s.
- You can be signed in on your phone and laptop at once; both follow along.
- **On iPhone**, Safari won't play sound until you touch the page once. If the
  video starts muted, a **"Muted · tap for sound"** button appears. One tap fixes
  it without pausing your partner. **Share → Add to Home Screen** gives you an
  app-like icon.

## How it stays in sync

- The server keeps one shared state per linked pair: which video, playing or
  paused, and where. Every action updates it and goes to both of you, and it is
  saved to disk, so a restart picks up where you were.
- Each device works out where the video *should* be, using a clock synced with
  the server, and nudges its player if it drifts by more than about half a second.
- If one person's internet stalls for more than about 1.5s, the other side waits
  for them, for up to 10s, then carries on.
- Dropped connections reconnect by themselves and catch up.
- When a phone locks, iOS pauses the video. That is *not* treated as a pause
  for your partner.

**Data use:** syncing uses about 20 KB per hour. YouTube's player only downloads
once there's a video, and YouTube picks the video quality to suit your connection.

## Tests

```sh
npm test            # unit + server tests (accounts, linking, attacks, sync, backups), ~5s
npm run setup:e2e   # once: downloads a test browser into node_modules
npm run test:e2e    # browser tests on desktop + iPhone-sized screens
REAL_YT=1 npm run test:e2e -- e2e/real-youtube.spec.js   # against real YouTube
```

Sign-in is tested against a stand-in for Google (`test/fake-google.js`) that
uses the same protocol with real signed tokens. It also sends forged tokens
(wrong signature, wrong app, expired, replayed, `alg: none`, …) to check that
they're refused. The server tests include attacks: requests from other
websites, stolen or made-up cookies, guessing invite links, accepting someone
else's request, joining a couple you're not part of, oversized and malformed
input, and HTML in names.

If the test browser won't start on Linux because of missing system libraries
and you can't `apt install` them, `npm run setup:e2e-libs` downloads them into
`.e2e-env/` instead. Nothing is installed system-wide.

## Files

| File | What it does |
| --- | --- |
| `server.js` | Web server: pages, sign-in, account API, WebSocket sync |
| `oidc.js` | Google sign-in (OpenID Connect + PKCE, token checks) |
| `passwords.js` | Username + password sign-in: scrypt hashing, rules |
| `db.js` | The database: accounts, sessions, linking, saved playback, backups |
| `config.js` | Settings, and refusing insecure ones |
| `rooms.js` | Live playback state per couple, buffering holds |
| `scripts/restore.js` | Restore a backup |
| `public/account.js` | Sign-in, linking, account and privacy screens |
| `public/app.js` | The watch room: connection, YouTube player, controls, suggestions |
| `public/playlists.js` | Shared "Watch later" playlists |
| `public/chat.js` | Chat next to the video |
| `public/history.js` | What you've watched together |
| `public/controller.js` | Keeps the local player matched to the room |
| `public/sync.js` | Shared sync maths (server and browser) |
