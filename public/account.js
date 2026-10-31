// Entry point: who is signed in, partner linking, the account page, and
// starting the watch room once two people are linked.
import { startRoom } from './app.js';

const $ = (id) => document.getElementById(id);
const SCREENS = ['signin', 'link', 'join', 'account', 'privacy'];

let me = null; // latest /api/me
let room = null; // running watch room, if any
let accountSocket = null; // live account updates while not in the room
let pendingJoin = null; // invite token taken from a /join#... link

// ---------------------------------------------------------------- api

async function api(path, body) {
  const init = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': (me && me.csrf) || '' },
    body: JSON.stringify(body),
  };
  let res;
  try {
    res = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new Error('Can’t reach the server. Check your connection and try again.');
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && me && me.user) refresh(); // session ended elsewhere
    throw new Error(data.message || 'Something went wrong. Please try again.');
  }
  return data;
}

// ---------------------------------------------------------------- helpers

function show(screen) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== screen;
  $('room').hidden = screen !== 'room';
  $('topbar').hidden = screen === 'room' || !me || !me.user;
}

function busy(btn, on) {
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

// Runs an action from a button, showing errors in `errEl`.
async function run(btn, errEl, fn) {
  if (errEl) errEl.hidden = true;
  busy(btn, true);
  try {
    await fn();
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message;
      errEl.hidden = false;
    }
  } finally {
    busy(btn, false);
  }
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

const timeLeft = (t) => {
  const h = Math.max(0, Math.round((t - Date.now()) / 3600_000));
  return h >= 1 ? `${h} hour${h === 1 ? '' : 's'}` : 'less than an hour';
};

function go(path) {
  if (location.pathname !== path) history.pushState(null, '', path);
  render();
}

// ---------------------------------------------------------------- state

async function refresh() {
  try {
    me = await api('/api/me');
  } catch (e) {
    if (!me) {
      $('signin-err').textContent = e.message;
      $('signin-err').hidden = false;
      show('signin');
    }
    return;
  }
  render();
}

function render() {
  const path = location.pathname;
  if (path === '/privacy') return show('privacy');
  if (!me || !me.user) {
    stopRoom();
    closeAccountSocket();
    // Google stays visible but inactive until the server has keys for it.
    const google = !!(me && me.googleReady);
    $('signin-btn').disabled = !google;
    $('signin-btn').title = google ? '' : 'Not set up on this server';
    $('signin-off').hidden = google;
    $('signin-join-note').hidden = !pendingJoin;
    show('signin');
    return;
  }
  $('topbar-name').textContent = me.user.name;
  if (path === '/account') {
    renderAccount();
    return show('account');
  }
  if (pendingJoin && !me.partner) {
    renderJoin();
    return show('join');
  }
  if (me.partner) {
    closeAccountSocket();
    if (!room) {
      room = startRoom({
        api,
        partnerName: me.partner.name,
        onAccountChange: refresh,
        onEnded: (reason) => {
          room = null;
          if (reason === 'unlinked') toast('You are no longer linked');
          refresh();
        },
      });
    }
    return show('room');
  }
  stopRoom();
  openAccountSocket();
  renderLink();
  show('link');
}

function stopRoom() {
  if (room) {
    room.stop();
    room = null;
  }
}

// While not linked, a small socket lets the page update itself when a link
// request arrives or is accepted, instead of polling.
function openAccountSocket() {
  if (accountSocket) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  accountSocket = sock;
  sock.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'account') refresh();
    if (msg.type === 'welcome') {
      // We became linked (e.g. partner accepted while this page was open).
      closeAccountSocket();
      refresh();
    }
  };
  sock.onclose = (e) => {
    if (accountSocket !== sock) return;
    accountSocket = null;
    if (e.code === 4001) return refresh();
    setTimeout(() => me && me.user && !me.partner && !room && openAccountSocket(), 3000);
  };
}

function closeAccountSocket() {
  const s = accountSocket;
  accountSocket = null;
  if (s) {
    s.onclose = s.onmessage = null;
    s.close();
  }
}

// ---------------------------------------------------------------- linking screen

let shownInvite = null; // { url, expiresAt } just created on this page

function renderLink() {
  // Requests to us
  const list = $('incoming');
  list.replaceChildren();
  for (const r of me.incoming) {
    const li = document.createElement('li');
    li.className = 'request';
    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = r.name; // textContent: names are never treated as HTML
    const code = document.createElement('div');
    code.className = 'code';
    code.textContent = r.code;
    text.append(name, document.createTextNode(' wants to link with you. Their screen should show the same code:'), code);
    const accept = document.createElement('button');
    accept.className = 'btn primary';
    accept.textContent = 'Codes match, link us';
    const decline = document.createElement('button');
    decline.className = 'btn';
    decline.textContent = 'Decline';
    const err = document.createElement('div');
    err.className = 'err';
    err.hidden = true;
    accept.onclick = () =>
      run(accept, err, async () => {
        await api('/api/request/accept', { id: r.id });
        await refresh();
      });
    decline.onclick = () =>
      run(decline, err, async () => {
        await api('/api/request/decline', { id: r.id });
        await refresh();
      });
    const row = document.createElement('div');
    row.className = 'row';
    row.append(accept, decline);
    li.append(text, row, err);
    list.append(li);
  }
  $('incoming-box').hidden = me.incoming.length === 0;

  // Our request to someone else
  const out = me.outgoing;
  $('outgoing-box').hidden = !out;
  if (out) {
    $('outgoing-name').textContent = out.name;
    $('outgoing-code').textContent = out.code;
  }

  // Our invite link
  const active = me.invite;
  if (!active) shownInvite = null;
  $('invite-make').hidden = !!shownInvite;
  $('invite-made').hidden = !shownInvite;
  $('invite-active-note').hidden = !(active && !shownInvite);
  if (active && !shownInvite) $('invite-active-left').textContent = timeLeft(active.expiresAt);
  if (shownInvite) {
    $('invite-url').value = shownInvite.url;
    $('invite-left').textContent = timeLeft(shownInvite.expiresAt);
  }
}

$('invite-create').onclick = () =>
  run($('invite-create'), $('invite-err'), async () => {
    shownInvite = await api('/api/invite', {});
    me = await api('/api/me');
    renderLink();
  });

$('invite-copy').onclick = async () => {
  const url = $('invite-url').value;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Watch Together', text: 'Link with me on Watch Together', url });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied');
  } catch {
    $('invite-url').select();
  }
};

$('invite-cancel').onclick = () =>
  run($('invite-cancel'), $('invite-err'), async () => {
    await api('/api/invite/revoke', {});
    shownInvite = null;
    await refresh();
  });
$('invite-cancel-active').onclick = () =>
  run($('invite-cancel-active'), $('invite-err'), async () => {
    await api('/api/invite/revoke', {});
    await refresh();
  });

$('outgoing-cancel').onclick = () =>
  run($('outgoing-cancel'), null, async () => {
    await api('/api/request/cancel', {});
    await refresh();
  });

// ---------------------------------------------------------------- join screen

let joinPeek = null;

async function renderJoin() {
  $('join-err').hidden = true;
  $('join-ask').hidden = true;
  $('join-done').hidden = true;
  $('join-loading').hidden = false;
  try {
    joinPeek = await api('/api/invite/peek', { token: pendingJoin });
    $('join-name').textContent = joinPeek.name;
    $('join-ask').hidden = false;
  } catch (e) {
    $('join-err').textContent = e.message;
    $('join-err').hidden = false;
  } finally {
    $('join-loading').hidden = true;
  }
}

$('join-yes').onclick = () =>
  run($('join-yes'), $('join-err'), async () => {
    const r = await api('/api/invite/use', { token: pendingJoin });
    pendingJoin = null;
    $('join-ask').hidden = true;
    $('join-done-name').textContent = r.name;
    $('join-done-code').textContent = r.code;
    $('join-done').hidden = false;
  });

$('join-no').onclick = () => {
  pendingJoin = null;
  go('/');
};
$('join-continue').onclick = () => go('/');

// ---------------------------------------------------------------- account page

function renderAccount() {
  const has = me.user.hasPassword;
  $('pw-section-title').textContent = has ? 'Password' : 'Add a password';
  $('pw-section-info').textContent = has
    ? `You sign in as “${me.user.username}”. Only you can see your username.`
    : 'You sign in with Google. Add a username and password as a second way in.';
  $('pw-change-user').value = me.user.username || '';
  $('pw-new-user-field').hidden = has;
  $('pw-current-field').hidden = !has;
  $('pw-current').value = '';
  $('pw-new').value = '';
  $('pw-change-ok').hidden = true;
  $('pw-change-err').hidden = true;
  $('acct-name').value = me.user.name;
  $('acct-partner').textContent = me.partner ? me.partner.name : 'Not linked yet';
  $('acct-since').textContent = me.partner ? `Linked since ${new Date(me.partner.since).toLocaleDateString()}` : '';
  $('acct-unlink').hidden = !me.partner;
  $('acct-name-ok').hidden = true;
  $('acct-name-err').hidden = true;
  $('delete-confirm').value = '';
  $('delete-go').disabled = true;
}

$('acct-name-form').onsubmit = (e) => {
  e.preventDefault();
  run($('acct-name-save'), $('acct-name-err'), async () => {
    await api('/api/name', { name: $('acct-name').value });
    me = await api('/api/me');
    $('topbar-name').textContent = me.user.name;
    $('acct-name').value = me.user.name;
    $('acct-name-ok').hidden = false;
  });
};

$('pw-change-form').onsubmit = (e) => {
  e.preventDefault();
  run($('pw-change-save'), $('pw-change-err'), async () => {
    const body = me.user.hasPassword
      ? { current: $('pw-current').value, password: $('pw-new').value }
      : { username: $('pw-new-user').value, password: $('pw-new').value };
    await api('/api/password', body);
    me = await api('/api/me');
    renderAccount();
    $('pw-change-ok').hidden = false;
  });
};

// Two-step confirm for unlinking.
$('acct-unlink').onclick = () => {
  $('unlink-confirm').hidden = false;
  $('acct-unlink').hidden = true;
};
$('unlink-no').onclick = () => {
  $('unlink-confirm').hidden = true;
  $('acct-unlink').hidden = false;
};
$('unlink-yes').onclick = () =>
  run($('unlink-yes'), $('acct-err'), async () => {
    await api('/api/unlink', {});
    stopRoom();
    $('unlink-confirm').hidden = true;
    me = await api('/api/me');
    renderAccount();
    toast('Unlinked');
  });

$('acct-export').onclick = () => {
  location.href = '/api/export';
};

$('acct-signout').onclick = () =>
  run($('acct-signout'), $('acct-err'), async () => {
    await api('/api/signout', {});
    signedOut('Signed out');
  });

$('acct-signout-all').onclick = () =>
  run($('acct-signout-all'), $('acct-err'), async () => {
    await api('/api/signout-all', {});
    signedOut('Signed out on all your devices');
  });

$('delete-confirm').oninput = () => {
  $('delete-go').disabled = $('delete-confirm').value.trim() !== 'DELETE';
};
$('delete-form').onsubmit = (e) => {
  e.preventDefault();
  run($('delete-go'), $('delete-err'), async () => {
    await api('/api/delete', { confirm: $('delete-confirm').value.trim() });
    signedOut('Your account and everything in it has been deleted');
  });
};

function signedOut(message) {
  stopRoom();
  closeAccountSocket();
  me = { user: null, googleReady: !!(me && me.googleReady) };
  history.replaceState(null, '', '/');
  render();
  toast(message);
}

// ---------------------------------------------------------------- navigation

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

// ---------------------------------------------------------------- username + password

let signupMode = false;

function setMode(signup) {
  signupMode = signup;
  $('tab-login').setAttribute('aria-selected', String(!signup));
  $('tab-signup').setAttribute('aria-selected', String(signup));
  $('pw-name-field').hidden = !signup;
  $('pw-hint').hidden = !signup;
  $('pw-submit').textContent = signup ? 'Create account' : 'Sign in';
  // Lets password managers offer to save / generate a strong password.
  $('pw-pass').autocomplete = signup ? 'new-password' : 'current-password';
  $('signin-err').hidden = true;
}
$('tab-login').onclick = () => setMode(false);
$('tab-signup').onclick = () => setMode(true);

$('pw-form').onsubmit = (e) => {
  e.preventDefault();
  run($('pw-submit'), $('signin-err'), async () => {
    const body = { username: $('pw-user').value, password: $('pw-pass').value };
    if (signupMode) body.name = $('pw-name').value;
    await api(signupMode ? '/api/signup' : '/api/login', body);
    $('pw-pass').value = '';
    me = await api('/api/me');
    render();
  });
};

$('signin-btn').onclick = () => {
  // Come back to the invite after signing in. The secret itself is kept in
  // this tab only (sessionStorage), never sent through Google.
  try {
    if (pendingJoin) sessionStorage.setItem('wt_join', pendingJoin);
  } catch {}
  location.assign(`/auth/google?next=${encodeURIComponent(pendingJoin ? '/join' : '/')}`);
};

// ---------------------------------------------------------------- start

(function boot() {
  // Invite link: /join#<secret>. Take the secret out of the address bar
  // straight away so it isn't left in history or shared by accident.
  if (location.pathname === '/join') {
    const fromHash = location.hash.slice(1);
    let saved = null;
    try {
      saved = sessionStorage.getItem('wt_join');
      sessionStorage.removeItem('wt_join');
    } catch {}
    pendingJoin = /^[A-Za-z0-9_-]{20,100}$/.test(fromHash) ? fromHash : saved;
    history.replaceState(null, '', '/join');
  }
  const p = new URLSearchParams(location.search);
  const signin = p.get('signin');
  if (signin) {
    history.replaceState(null, '', location.pathname);
    const msgs = {
      cancelled: 'Sign-in was cancelled.',
      expired: 'That sign-in took too long or was already used. Please try again.',
      error: 'Google sign-in didn’t work. Please try again.',
    };
    $('signin-err').textContent = msgs[signin] || msgs.error;
    $('signin-err').hidden = false;
  }
  refresh();
})();
