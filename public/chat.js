// Chat with your partner, next to the video. Messages go over the room's live
// connection; older ones load from the server on request. All text is shown
// with textContent, so nothing anyone types can run as code.
const $ = (id) => document.getElementById(id);

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return dayFmt.format(d);
}

// opts: { api, partnerName, send(msg) -> bool, isVisible() -> bool, onUnread(n) }
export function startChat(opts) {
  const { api, partnerName } = opts;
  const list = $('chat-list');
  const log = $('chat-log');
  const input = $('chat-input');
  let messages = []; // { id?, ref?, text, at, mine, state: 'sent'|'pending'|'failed', error? }
  let more = false;
  let unread = 0;
  let nextRef = 1;

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const toBottom = () => (log.scrollTop = log.scrollHeight);

  function render() {
    const stick = nearBottom();
    const items = [];
    let lastDay = null;
    for (const m of messages) {
      const day = dayLabel(m.at);
      if (day !== lastDay) {
        const d = document.createElement('li');
        d.className = 'day';
        d.textContent = day;
        items.push(d);
        lastDay = day;
      }
      const li = document.createElement('li');
      li.className = `msg${m.mine ? ' mine' : ''}${m.state !== 'sent' ? ` ${m.state}` : ''}`;
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.text;
      const meta = document.createElement('div');
      meta.className = 'meta-line';
      if (m.state === 'failed') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'linkbtn';
        retry.textContent = `${m.error || 'Not sent.'} Tap to retry`;
        retry.onclick = () => resend(m);
        meta.append(retry);
      } else {
        meta.textContent = m.state === 'pending' ? 'Sending…' : timeFmt.format(new Date(m.at));
      }
      li.append(bubble, meta);
      items.push(li);
    }
    list.replaceChildren(...items);
    $('chat-older').hidden = !more;
    const empty = $('chat-empty');
    empty.hidden = messages.length > 0;
    empty.textContent = `Say hi to ${partnerName}! Only the two of you can see this.`;
    if (stick) toBottom();
  }

  async function loadLatest() {
    try {
      const r = await api('/api/chat');
      // Keep anything still on its way out.
      messages = [...r.messages.map((m) => ({ ...m, state: 'sent' })), ...messages.filter((m) => m.state !== 'sent')];
      more = r.more;
      $('chat-err').hidden = true;
    } catch (e) {
      $('chat-err').textContent = e.message;
      $('chat-err').hidden = false;
    }
    render();
    toBottom();
  }

  $('chat-older').onclick = async () => {
    const first = messages.find((m) => m.id);
    if (!first) return;
    const before = log.scrollHeight;
    try {
      const r = await api(`/api/chat?before=${first.id}`);
      messages = [...r.messages.map((m) => ({ ...m, state: 'sent' })), ...messages];
      more = r.more;
    } catch (e) {
      $('chat-err').textContent = e.message;
      $('chat-err').hidden = false;
    }
    render();
    log.scrollTop = log.scrollHeight - before; // keep the view where it was
  };

  function transmit(m) {
    m.state = 'pending';
    m.error = null;
    if (!opts.send({ type: 'chat', text: m.text, ref: m.ref })) {
      m.state = 'failed';
      m.error = 'Not connected.';
    } else {
      // No confirmation in a while: say so, rather than pretend it was sent.
      setTimeout(() => {
        if (m.state === 'pending') {
          m.state = 'failed';
          m.error = 'Not sent.';
          render();
        }
      }, 10_000);
    }
  }

  function resend(m) {
    transmit(m);
    render();
  }

  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if ([...text].length > 500) {
      $('chat-err').textContent = 'That message is too long (500 characters at most).';
      $('chat-err').hidden = false;
      return;
    }
    $('chat-err').hidden = true;
    const m = { ref: `c${Date.now().toString(36)}${nextRef++}`, text, at: Date.now(), mine: true };
    messages.push(m);
    transmit(m);
    input.value = '';
    grow();
    render();
    toBottom();
  };

  // Enter sends; Shift+Enter makes a new line (on a computer).
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      $('chat-form').requestSubmit();
    }
  });
  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }
  input.addEventListener('input', grow);

  const showClear = (on) => ($('chat-clear-confirm').hidden = !on);
  $('chat-menu').onclick = () => showClear($('chat-clear-confirm').hidden);
  $('chat-clear-no').onclick = () => showClear(false);
  $('chat-clear-yes').onclick = async () => {
    showClear(false);
    try {
      await api('/api/chat/clear', {});
    } catch (e) {
      $('chat-err').textContent = e.message;
      $('chat-err').hidden = false;
    }
  };

  function setUnread(n) {
    unread = n;
    opts.onUnread(unread);
  }

  // ---- from the server

  function received(msg) {
    const m = msg.message;
    const mine = msg.ref && messages.find((x) => x.ref === msg.ref);
    if (mine) {
      Object.assign(mine, { id: m.id, at: m.at, state: 'sent', error: null });
    } else if (!messages.some((x) => x.id === m.id)) {
      messages.push({ ...m, state: 'sent' });
      if (!m.mine && !opts.isVisible()) setUnread(unread + 1);
    }
    render();
  }

  function failed(msg) {
    const m = msg.ref && messages.find((x) => x.ref === msg.ref);
    if (m) {
      m.state = 'failed';
      m.error = msg.message;
      render();
    } else {
      $('chat-err').textContent = msg.message;
      $('chat-err').hidden = false;
    }
  }

  function cleared() {
    messages = messages.filter((m) => m.state !== 'sent');
    more = false;
    setUnread(0);
    render();
  }

  loadLatest();
  return {
    received,
    failed,
    cleared,
    reload: loadLatest, // e.g. after reconnecting: catch up on anything missed
    seen: () => {
      setUnread(0);
      toBottom();
    },
  };
}
