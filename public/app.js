import { Controller } from './controller.js';
import { ClockSync, PLACEHOLDER_TITLE, YT_STATE as S, expectedPosition, formatTime, parseYouTubeUrl } from './sync.js';
import { startPlaylists } from './playlists.js';
import { startChat } from './chat.js';
import { startHistory } from './history.js';

const $ = (id) => document.getElementById(id);
const TICK_MS = 500;
const PING_EVERY_MS = 15_000;
const DEAD_AFTER_MS = 40_000; // no message from the server this long => reconnect

// ---------------------------------------------------------------- room

// The watch-together room. Only shown to someone signed in and linked; the
// server decides which room from the session, so there's nothing in the URL.
// opts: { api, partnerName, onAccountChange(), onEnded(reason) }. Returns { stop() }.
export function startRoom(opts) {
  $('room').hidden = false;
  let stopped = false;
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  const partnerName = opts.partnerName || 'Your partner';

  const clock = new ClockSync();
  let ws = null;
  let wsOpen = false;
  let retry = 0;
  let retryTimer = 0;
  let pingTimer = 0;
  let pings = 0;
  let lastMsgAt = 0;
  let boot = null; // server instance id, to notice restarts
  let welcomed = false; // seen a welcome before (so the next one is a reconnect)
  let unreadChat = 0;
  let lastSeq = -1;
  let pending = false; // a local action happened while offline
  let partners = 0;
  let player = null;
  let playerRequested = false;
  let autoMuted = false;
  let title = '';

  const isHidden = () => document.visibilityState === 'hidden';

  const ctl = new Controller({
    player: {
      getPlayerState: () => (player ? player.getPlayerState() : S.UNSTARTED),
      getCurrentTime: () => (player ? player.getCurrentTime() : 0),
      getDuration: () => (player ? player.getDuration() : 0),
      seekTo: (t, a) => player && player.seekTo(t, a),
      playVideo: () => player && player.playVideo(),
      pauseVideo: () => player && player.pauseVideo(),
      loadVideoById: (o) => player && player.loadVideoById(o),
      cueVideoById: (o) => player && player.cueVideoById(o),
    },
    send: (msg) => {
      if (!sendWs(msg) && msg.type === 'action') pending = true;
    },
    serverNow: () => clock.now(),
    isHidden,
    onBlocked: (b) => {
      if (!b || !player) return;
      // The browser refused to start with sound (iPhone does this until the
      // video itself is tapped). Play muted so we stay in sync, offer sound.
      autoMuted = true;
      player.mute();
      player.playVideo();
      renderUi();
    },
    onChange: () => renderUi(),
  });

  // ------------------------------------------------------------ socket

  function sendWs(msg) {
    if (!wsOpen) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  function connect() {
    clearTimeout(retryTimer);
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    ws = sock;
    setConn('connecting');
    sock.onopen = () => {
      wsOpen = true;
      retry = 0;
      pings = 0;
      lastMsgAt = Date.now();
      ping();
    };
    sock.onmessage = (e) => {
      lastMsgAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      onMessage(msg);
    };
    sock.onclose = (e) => {
      // 4001: the server ended this on purpose (unlinked, signed out, account
      // deleted). Don't reconnect; let the account screen take over.
      if (e.code === 4001) {
        if (sock === ws) ended(e.reason || 'ended');
        return;
      }
      dropped(sock);
    };
    sock.onerror = () => {};
  }

  // Socket is gone (or we gave up on it). Reconnect with backoff.
  function dropped(sock) {
    if (sock !== ws || stopped) return;
    sock.onclose = sock.onmessage = sock.onopen = null;
    try {
      sock.close();
    } catch {}
    ws = null;
    wsOpen = false;
    clearTimeout(pingTimer);
    setConn('offline');
    const delay = Math.min(8000, 400 * 2 ** retry++) * (0.75 + Math.random() * 0.5);
    retryTimer = setTimeout(connect, delay);
  }

  function reconnectNow() {
    retry = 0;
    if (ws && !wsOpen) return; // already connecting
    if (ws) dropped(ws);
    clearTimeout(retryTimer);
    connect();
  }

  // Clock sync: a few quick pings to get a good sample, then occasional ones
  // that double as a keep-alive.
  function ping() {
    clearTimeout(pingTimer);
    if (!sendWs({ type: 'ping', c: Date.now() })) return;
    pings++;
    pingTimer = setTimeout(ping, pings < 5 ? 700 : PING_EVERY_MS);
  }

  function onMessage(msg) {
    if (msg.type === 'pong') {
      clock.add(msg.c, msg.t, Date.now());
    } else if (msg.type === 'welcome') {
      clock.seed(msg.t);
      ctl.setMe(msg.id);
      partners = msg.n - 1;
      // The server saves the room, so it is the source of truth. The one
      // exception: we pressed something while offline and nobody else has
      // done anything since, so our action is re-sent.
      const mine = ctl.rs;
      const resend =
        mine && mine.v && pending && boot === msg.boot && msg.state.seq === lastSeq && msg.state.v === mine.v;
      const where = resend ? expectedPosition(mine, clock.now()) : 0;
      boot = msg.boot;
      pending = false;
      lastSeq = msg.state.seq;
      ctl.setState(msg.state);
      if (resend) ctl.act(mine.playing ? 'play' : 'pause', where);
      setProposal(msg.proposal);
      ensurePlayer();
      setConn('online');
      // Back after a dropped connection: catch up on anything we missed.
      if (welcomed) {
        chat.reload();
        history.load();
        lists.load();
      }
      welcomed = true;
    } else if (msg.type === 'nolink') {
      ended('unlinked'); // linked state changed while we were away
    } else if (msg.type === 'account') {
      opts.onAccountChange();
    } else if (msg.type === 'state') {
      const prev = ctl.rs;
      lastSeq = msg.state.seq;
      partners = msg.n - 1;
      const newVideo = !prev || msg.state.v !== prev.v;
      if (newVideo) title = acceptedTitle(msg.state.v);
      ctl.setState(msg.state);
      ensurePlayer();
      if (msg.kind === 'load') {
        if (newVideo) toast(title && title !== PLACEHOLDER_TITLE ? `Starting “${title}”` : 'Starting the video');
      } else if (msg.by !== ctl.me) {
        announce(msg.kind, msg.state);
      }
      lists.render();
      renderUi();
    } else if (msg.type === 'presence') {
      const before = partners;
      partners = msg.n - 1;
      if (partners > before) toast(`${partnerName} joined`);
      else if (partners < before) toast(`${partnerName} left`);
      renderUi();
    } else if (msg.type === 'proposal') {
      setProposal(msg.proposal);
    } else if (msg.type === 'proposal-closed') {
      if (!msg.byMe) {
        toast(msg.withdrawn ? `${partnerName} took back their suggestion` : `${partnerName} said not now to “${msg.title || 'that video'}”`);
      }
    } else if (msg.type === 'playlists') {
      lists.load();
    } else if (msg.type === 'chat') {
      chat.received(msg);
    } else if (msg.type === 'chat-error') {
      chat.failed(msg);
    } else if (msg.type === 'chat-cleared') {
      chat.cleared();
    } else if (msg.type === 'history') {
      history.load();
    }
  }

  // ------------------------------------------------------------ "watch this?"
  // A new video only starts once the other person accepts. The server holds
  // the suggestion, so it survives reloads and waits if the partner is away.

  let proposal = null;
  let lastAccepted = null; // the suggestion that just turned into the video

  // Title of a video we just agreed on, so it shows before YouTube reports it.
  // (The server sends the new state just before clearing the suggestion.)
  function acceptedTitle(v) {
    const p = [proposal, lastAccepted].find((x) => x && x.v === v);
    return (p && p.title) || '';
  }

  function setProposal(p) {
    if (proposal && !p) lastAccepted = proposal;
    proposal = p || null;
    const box = $('proposal');
    box.hidden = !proposal;
    $('proposal-err').hidden = true;
    if (!proposal) return;
    box.classList.toggle('theirs', !proposal.mine);
    const thumb = $('proposal-thumb');
    thumb.classList.remove('missing');
    thumb.onerror = () => thumb.classList.add('missing');
    thumb.src = `https://i.ytimg.com/vi/${proposal.v}/mqdefault.jpg`;
    $('proposal-title').textContent = proposal.title || 'A YouTube video';
    $('proposal-who').textContent = proposal.mine
      ? `Waiting for ${partnerName} to accept…`
      : `${partnerName} wants to watch:`;
    $('proposal-accept').hidden = proposal.mine;
    $('proposal-decline').textContent = proposal.mine ? 'Cancel' : 'Not now';
  }

  async function answer(accept) {
    const p = proposal;
    if (!p) return;
    const btn = accept ? $('proposal-accept') : $('proposal-decline');
    btn.disabled = true;
    try {
      await opts.api(accept ? '/api/proposal/accept' : '/api/proposal/decline', { id: p.id });
      if (accept) {
        // Starting the video from this tap lets iPhone play it with sound.
        title = p.title || '';
        unlockPlayback();
      }
    } catch (e) {
      $('proposal-err').textContent = e.message;
      $('proposal-err').hidden = false;
    } finally {
      btn.disabled = false;
    }
  }
  $('proposal-accept').onclick = () => answer(true);
  $('proposal-decline').onclick = () => answer(false);

  async function suggest(video) {
    try {
      const r = await opts.api('/api/propose', video);
      setProposal(r.proposal);
    } catch (e) {
      toast(e.message);
    }
  }

  function announce(kind, st) {
    const t = formatTime(st.pos);
    const text = {
      play: `${partnerName} pressed play at ${t}`,
      pause: `${partnerName} paused at ${t}`,
      seek: `${partnerName} skipped to ${t}`,
    }[kind];
    if (text) toast(text);
  }

  function setConn(s) {
    $('conn').dataset.s = s;
    renderUi();
  }

  // ------------------------------------------------------------ player

  // The YouTube player is heavy, so only fetch it once there's a video.
  function ensurePlayer(force = false) {
    if (playerRequested || (!force && !(ctl.rs && ctl.rs.v))) return;
    playerRequested = true;
    createPlayer();
  }

  // Called from the tap on "Watch": create the player inside the tap, so the
  // browser counts this page as user-activated. iPhone may still start muted
  // when the server's go-ahead arrives; the "tap for sound" button covers that.
  function unlockPlayback() {
    ensurePlayer(true);
  }

  function loadYouTubeApi() {
    return new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve();
      window.onYouTubeIframeAPIReady = () => resolve();
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => {
        s.remove();
        reject(new Error('YouTube failed to load'));
      };
      document.head.appendChild(s);
    });
  }

  function createPlayer() {
    loadYouTubeApi().then(
      () => {
        const p = new YT.Player('player', {
          width: '100%',
          height: '100%',
          playerVars: {
            playsinline: 1, // stay in the page on iPhone instead of forcing fullscreen
            rel: 0,
            iv_load_policy: 3, // no annotations
            origin: location.origin,
          },
          events: {
            onReady: () => {
              player = p;
              ctl.setReady();
              renderUi();
            },
            onStateChange: (e) => {
              ctl.onPlayerState(e.data);
              const d = p.getVideoData && p.getVideoData();
              if (d && d.title && d.title !== title) {
                title = d.title;
                lists.learnTitle(ctl.rs && ctl.rs.v, title);
              }
              renderUi();
            },
            onError: (e) => {
              const msgs = {
                2: 'That link looks broken.',
                5: 'This video can’t play here.',
                100: 'Video not found or private.',
                101: 'The owner doesn’t allow this video outside YouTube.',
                150: 'The owner doesn’t allow this video outside YouTube.',
              };
              toast(msgs[e.data] || 'YouTube couldn’t play this video.');
            },
          },
        });
      },
      () => {
        toast('Couldn’t reach YouTube, retrying…');
        setTimeout(createPlayer, 5000);
      }
    );
  }

  // Sound comes back on the next tap anywhere on our page.
  function unmute() {
    if (!autoMuted || !player) return;
    autoMuted = false;
    // Some browsers pause instead of unmuting; don't mistake that for the
    // user pressing pause. The controller will simply resume.
    ctl.suppress(2500);
    player.unMute();
    setTimeout(renderUi, 50);
  }
  $('tap').onclick = unmute;
  document.addEventListener('pointerdown', unmute, { capture: true, signal });

  // ------------------------------------------------------------ UI

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.hidden = true), 2600);
  }

  // Write to the DOM only when something changed; this runs twice a second.
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }
  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  function setHidden(el, hidden) {
    if (el.hidden !== hidden) el.hidden = hidden;
  }

  function renderUi() {
    const rs = ctl.rs;
    const has = !!(rs && rs.v);
    setHidden($('empty'), has);
    setHidden($('controls'), !has);
    setText($('video-title'), has ? title || 'Loading…' : 'No video yet');
    // Tab title, with unread chat messages counted when the page is hidden.
    const base = title && has ? `${title} · Watch Together` : 'Watch Together';
    const docTitle = unreadChat ? `(${unreadChat}) ${base}` : base;
    if (document.title !== docTitle) document.title = docTitle;

    const conn = $('conn').dataset.s;
    setText(
      $('presence'),
      conn === 'online'
        ? partners > 0
          ? `Watching with ${partnerName}`
          : `Waiting for ${partnerName}…`
        : conn === 'offline'
          ? 'Reconnecting…'
          : 'Connecting…'
    );

    const playing = !!(rs && rs.playing);
    setText($('toggle'), playing ? '❚❚' : '▶');
    setAttr($('toggle'), 'aria-label', playing ? 'Pause' : 'Play');

    let status = '';
    if (has && rs.hold && rs.hold.length) {
      status = rs.hold.includes(ctl.me) ? 'Buffering…' : `Waiting for ${partnerName} to load…`;
    }
    setText($('status'), status);
    setHidden($('tap'), !autoMuted);
    renderTime();
  }

  // ------------------------------------------------------------ seek bar
  // Custom slider: the native one on iPhone only moves when you grab the tiny
  // thumb, and you can't tap to jump.

  const bar = $('seek');
  let drag = null; // seconds while dragging

  function displayPos() {
    if (drag != null) return drag;
    const dur = ctl.duration();
    const st = ctl.state();
    const live = st === S.PLAYING || st === S.BUFFERING || st === S.PAUSED || st === S.ENDED;
    const pos = live ? ctl.current() : ctl.expected();
    return dur ? Math.min(pos, dur) : pos;
  }

  function renderTime() {
    if (!ctl.rs || !ctl.rs.v) return;
    const dur = ctl.duration();
    const pos = displayPos();
    setText($('time'), `${formatTime(pos)} / ${formatTime(dur)}`);
    const pct = `${dur ? Math.min(100, (pos / dur) * 100).toFixed(2) : 0}%`;
    if (bar.style.getPropertyValue('--p') !== pct) bar.style.setProperty('--p', pct);
    setAttr(bar, 'aria-valuemax', String(Math.floor(dur)));
    setAttr(bar, 'aria-valuenow', String(Math.floor(pos)));
    setAttr(bar, 'aria-valuetext', formatTime(pos));
  }

  function posFromPointer(e) {
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return f * ctl.duration();
  }

  bar.addEventListener('pointerdown', (e) => {
    if (!ctl.duration()) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    drag = posFromPointer(e);
    renderTime();
  }, { signal });
  bar.addEventListener('pointermove', (e) => {
    if (drag == null) return;
    drag = posFromPointer(e);
    renderTime();
  }, { signal });
  const endDrag = (commit) => (e) => {
    if (drag == null) return;
    const to = commit ? posFromPointer(e) : null;
    drag = null;
    bar.classList.remove('dragging');
    if (to != null) ctl.seek(to);
    renderTime();
  };
  bar.addEventListener('pointerup', endDrag(true), { signal });
  bar.addEventListener('pointercancel', endDrag(false), { signal });
  bar.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 }[e.key];
    if (step == null) return;
    e.preventDefault();
    e.stopPropagation();
    ctl.skip(step);
  }, { signal });

  // ------------------------------------------------------------ wiring

  // The pasted link, or null (with an error shown).
  function takeLink() {
    const input = $('url');
    const parsed = parseYouTubeUrl(input.value);
    if (!parsed) {
      $('load-err').textContent = 'That doesn’t look like a YouTube video link.';
      $('load-err').hidden = false;
      return null;
    }
    $('load-err').hidden = true;
    input.value = '';
    input.blur(); // closes the iPhone keyboard
    return parsed;
  }

  // Pasting a link suggests it; it starts for both once the partner accepts.
  $('load').onsubmit = (e) => {
    e.preventDefault();
    const parsed = takeLink();
    if (parsed) suggest({ v: parsed.id, start: parsed.start });
  };
  $('save-link').onclick = async () => {
    const parsed = takeLink();
    if (!parsed) return;
    try {
      await lists.save({ v: parsed.id, title: '', start: parsed.start });
    } catch (e) {
      toast(e.message);
    }
  };
  $('url').oninput = () => ($('load-err').hidden = true);

  if (navigator.clipboard && navigator.clipboard.readText) {
    $('paste').hidden = false;
    $('paste').onclick = async () => {
      try {
        $('url').value = (await navigator.clipboard.readText()).trim();
        if (parseYouTubeUrl($('url').value)) $('load').requestSubmit();
        else $('url').focus();
      } catch {
        $('url').focus();
      }
    };
  }

  $('toggle').onclick = () => {
    const dur = ctl.duration();
    // Pressing play at the very end restarts.
    if (ctl.rs && !ctl.rs.playing && dur && ctl.expected() >= dur - 0.5) ctl.act('play', 0);
    else ctl.toggle();
  };
  $('back').onclick = () => ctl.skip(-10);
  $('fwd').onclick = () => ctl.skip(10);

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('room').hidden) return;
    if (!ctl.rs || !ctl.rs.v) return;
    if (e.key === ' ' || e.key === 'k') {
      if (e.target instanceof HTMLButtonElement && e.key === ' ') return; // button handles it
      e.preventDefault();
      $('toggle').click();
    } else if (e.key === 'ArrowLeft' || e.key === 'j') {
      e.preventDefault();
      ctl.skip(e.key === 'j' ? -10 : -5);
    } else if (e.key === 'ArrowRight' || e.key === 'l') {
      e.preventDefault();
      ctl.skip(e.key === 'l' ? 10 : 5);
    }
  }, { signal });

  // Back from the background (phone unlocked, tab switched): catch up fast.
  document.addEventListener('visibilitychange', () => {
    if (isHidden()) return;
    if (!wsOpen || Date.now() - lastMsgAt > PING_EVERY_MS + 5000) reconnectNow();
    else {
      pings = 3;
      ping();
    }
    ctl.resync();
    renderUi();
  }, { signal });
  window.addEventListener('online', reconnectNow, { signal });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) reconnectNow(); // restored from the back/forward cache
  }, { signal });

  // One light loop drives drift correction, liveness and the clock display.
  // It keeps following the room in a background tab (browsers slow it to ~1/s).
  const lists = startPlaylists({
    api: opts.api,
    partnerName,
    current: () => (ctl.rs && ctl.rs.v ? { v: ctl.rs.v, title } : null),
    suggest: (item) => suggest({ item: item.id }),
    toast,
  });

  // ------------------------------------------------------------ chat, history, tabs
  // On a computer the chat sits beside the video and the tabs switch the lists
  // below; on a phone, Chat is one of the tabs.

  const wide = matchMedia('(min-width: 900px)');
  let tab = 'chat';
  const panels = { chat: 'chat', lists: 'lists', history: 'history' };

  function showTab(name) {
    if (wide.matches && name === 'chat') name = tab === 'chat' ? 'lists' : tab;
    tab = name;
    for (const [t, id] of Object.entries(panels)) {
      const on = t === tab;
      $(`tab-${t}`).setAttribute('aria-selected', String(on));
      $(id).hidden = !on;
    }
    if (chatVisible()) chat.seen();
  }
  const chatVisible = () => document.visibilityState === 'visible' && (wide.matches || tab === 'chat');
  for (const t of Object.keys(panels)) $(`tab-${t}`).onclick = () => showTab(t);
  wide.addEventListener('change', () => showTab(tab), { signal });
  document.addEventListener('visibilitychange', () => chatVisible() && chat.seen(), { signal });

  const chat = startChat({
    api: opts.api,
    partnerName,
    send: (msg) => sendWs(msg),
    isVisible: chatVisible,
    onUnread: (n) => {
      unreadChat = n;
      setText($('chat-badge'), String(n));
      setHidden($('chat-badge'), n === 0);
      renderUi();
    },
  });

  const history = startHistory({
    api: opts.api,
    suggest: (v, t) => suggest({ v, title: t }),
  });
  showTab(wide.matches ? 'lists' : 'chat');

  const tick = setInterval(() => {
    if (wsOpen && Date.now() - lastMsgAt > DEAD_AFTER_MS) dropped(ws);
    ctl.tick();
    if (!isHidden()) renderUi();
  }, TICK_MS);

  // Tear everything down: no timers, listeners, socket or player left behind.
  function stop() {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    clearInterval(tick);
    clearTimeout(retryTimer);
    clearTimeout(pingTimer);
    clearTimeout(toast.t);
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      try {
        ws.close();
      } catch {}
    }
    ws = null;
    wsOpen = false;
    try {
      if (player && player.destroy) player.destroy();
    } catch {}
    player = null;
    // Put a fresh mount point back for next time.
    const box = $('player-box');
    if (!$('player')) {
      const div = document.createElement('div');
      div.id = 'player';
      box.insertBefore(div, $('tap'));
    }
    $('room').hidden = true;
    $('toast').hidden = true;
    document.title = 'Watch Together';
    if (window.__wt && window.__wt.ctl === ctl) delete window.__wt;
  }

  function ended(reason) {
    stop();
    opts.onEnded(reason);
  }

  connect();
  renderUi();
  // For tests / debugging.
  window.__wt = { ctl, clock, dropSocket: () => ws && dropped(ws), get player() { return player; } };
  return { stop };
}
