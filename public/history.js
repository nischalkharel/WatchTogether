// Everything the two of you have watched together, newest first. Each entry
// can be suggested again (the partner still accepts) or removed.
const $ = (id) => document.getElementById(id);
const thumbUrl = (v) => `https://i.ytimg.com/vi/${v}/mqdefault.jpg`;
const whenFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// opts: { api, suggest(v, title) }
export function startHistory(opts) {
  const { api } = opts;
  let items = [];
  let more = false;
  let running = null;
  let queued = false;

  function showErr(e) {
    $('history-err').textContent = e ? e.message : '';
    $('history-err').hidden = !e;
  }

  // Same idea as the playlists: a change arriving mid-fetch gets one more fetch.
  async function load() {
    if (running) {
      queued = true;
      return running;
    }
    running = (async () => {
      try {
        const r = await api('/api/history');
        items = r.items;
        more = r.more;
        showErr(null);
      } catch (e) {
        showErr(e);
      }
      render();
    })();
    await running;
    running = null;
    if (queued) {
      queued = false;
      return load();
    }
  }

  function render() {
    $('history-list').replaceChildren(...items.map(row));
    $('history-empty').hidden = items.length > 0;
    $('history-clear').hidden = items.length === 0;
    $('history-more').hidden = !more;
  }

  function row(it) {
    const li = document.createElement('li');
    li.className = 'item';
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    img.loading = 'lazy';
    img.width = 80;
    img.height = 45;
    img.onerror = () => img.classList.add('missing');
    img.src = thumbUrl(it.v);
    const text = document.createElement('div');
    text.className = 'item-text';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = it.title;
    title.title = it.title;
    const meta = document.createElement('div');
    meta.className = 'small';
    const who = it.pickedBy === 'you' ? 'you' : it.pickedBy;
    meta.textContent = `${whenFmt.format(new Date(it.at))} · picked by ${who}`;
    text.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn primary';
    again.textContent = '▶ Again';
    again.setAttribute('aria-label', `Suggest “${it.title}” again`);
    again.onclick = () => opts.suggest(it.v, it.title);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Remove “${it.title}” from history`);
    del.onclick = async () => {
      del.disabled = true;
      try {
        await api('/api/history/remove', { id: it.id });
        await load();
      } catch (e) {
        showErr(e);
        del.disabled = false;
      }
    };
    actions.append(again, del);
    li.append(img, text, actions);
    return li;
  }

  $('history-more').onclick = async () => {
    const last = items.at(-1);
    if (!last) return;
    try {
      const r = await api(`/api/history?before=${last.id}`);
      items = [...items, ...r.items];
      more = r.more;
    } catch (e) {
      showErr(e);
    }
    render();
  };

  const confirm = (on) => ($('history-clear-confirm').hidden = !on);
  $('history-clear').onclick = () => confirm(true);
  $('history-clear-no').onclick = () => confirm(false);
  $('history-clear-yes').onclick = async () => {
    confirm(false);
    try {
      await api('/api/history/clear', {});
      await load();
    } catch (e) {
      showErr(e);
    }
  };

  load();
  return { load };
}
