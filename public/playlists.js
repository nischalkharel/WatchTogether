// The shared "Watch later" playlists under the player. Either person can add,
// remove and reorder; picking a video only *suggests* it to the partner.
import { PLACEHOLDER_TITLE } from './sync.js';

const $ = (id) => document.getElementById(id);
const thumbUrl = (v) => `https://i.ytimg.com/vi/${v}/mqdefault.jpg`;

// opts: { api, partnerName, current() -> { v, title } | null, suggest(item), toast }
export function startPlaylists(opts) {
  const { api } = opts;
  let lists = [];
  let selected = null;
  try {
    selected = localStorage.getItem('wt_list');
  } catch {}

  function showErr(e) {
    const el = $('list-err');
    el.textContent = e ? e.message : '';
    el.hidden = !e;
  }

  // Fetch the lists. If a fetch is already running it may have started before
  // the latest change, so one more runs after it; awaiting load() always gives
  // a list that includes every change made before the call. Bursts of change
  // notices still collapse into at most one extra request.
  let running = null;
  let queued = null;
  function load() {
    if (queued) return queued;
    if (running) {
      queued = running.then(() => {
        queued = null;
        return load();
      });
      return queued;
    }
    running = (async () => {
      try {
        lists = (await api('/api/playlists')).playlists;
        showErr(null);
      } catch (e) {
        showErr(e);
      } finally {
        running = null;
      }
      render();
    })();
    return running;
  }

  function current() {
    return lists.find((l) => l.id === selected) || lists[0] || null;
  }

  function remember(id) {
    selected = id;
    try {
      localStorage.setItem('wt_list', id);
    } catch {}
  }

  function render() {
    const list = current();
    const pick = $('list-pick');
    pick.replaceChildren(
      ...lists.map((l) => {
        const o = document.createElement('option');
        o.value = l.id;
        o.textContent = `${l.name} (${l.items.length})`;
        return o;
      })
    );
    pick.hidden = !lists.length;
    $('list-menu').hidden = !list;
    if (list) pick.value = list.id;

    const playing = opts.current();
    const already = list && playing && list.items.some((i) => i.v === playing.v);
    $('save-current').hidden = !list || !playing || already;

    const empty = $('list-empty');
    empty.hidden = !!(list && list.items.length);
    empty.textContent = list
      ? `Nothing saved yet. Paste a link above and press Save, or save what’s playing.`
      : `Make a playlist to save videos for later. ${opts.partnerName} sees it too.`;

    const ul = $('list-items');
    ul.replaceChildren(...(list ? list.items.map((it, i) => row(it, i, list.items.length, playing)) : []));
  }

  // Built with textContent only: titles and names are never treated as HTML.
  function row(it, i, count, playing) {
    const li = document.createElement('li');
    li.className = 'item' + (playing && playing.v === it.v ? ' playing' : '');
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    img.loading = 'lazy';
    img.width = 80;
    img.height = 45;
    img.onerror = () => img.classList.add('missing'); // e.g. weak signal: show a plain box
    img.src = thumbUrl(it.v);
    const text = document.createElement('div');
    text.className = 'item-text';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = it.title;
    title.title = it.title;
    const who = document.createElement('div');
    who.className = 'small';
    who.textContent = it.addedBy === 'you' ? 'Added by you' : `Added by ${it.addedBy}`;
    text.append(title, who);

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const btn = (label, aria, fn, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.setAttribute('aria-label', aria);
      b.onclick = async () => {
        b.disabled = true;
        try {
          await fn();
        } catch (e) {
          showErr(e);
        } finally {
          b.disabled = false;
        }
      };
      return b;
    };
    actions.append(
      btn('▶ Suggest', `Suggest “${it.title}” to ${opts.partnerName}`, () => opts.suggest(it), 'primary'),
      btn('↑', 'Move up', () => change('/api/playlists/move', { item: it.id, dir: -1 })),
      btn('↓', 'Move down', () => change('/api/playlists/move', { item: it.id, dir: 1 })),
      btn('✕', `Remove “${it.title}”`, () => change('/api/playlists/remove', { item: it.id }))
    );
    actions.children[1].disabled = i === 0;
    actions.children[2].disabled = i === count - 1;
    li.append(img, text, actions);
    return li;
  }

  async function change(path, body) {
    await api(path, body);
    await load();
  }

  // Save a video into the selected playlist (making one if there are none).
  async function save({ v, title, start }) {
    await (queued || running); // pick the list only once any refresh has landed
    let list = current();
    if (!list) {
      const made = await api('/api/playlists/create', { name: 'Watch later' });
      remember(made.id);
      await load();
      list = current();
    }
    await api('/api/playlists/add', { playlist: list.id, v, title, start });
    await load();
    opts.toast(`Saved to “${list.name}”`);
  }

  // ---- wiring

  $('list-pick').onchange = () => {
    remember($('list-pick').value);
    render();
  };

  const showNew = (on) => {
    $('list-new-form').hidden = !on;
    if (on) $('list-new-name').focus();
  };
  $('list-new').onclick = () => showNew(true);
  $('list-new-cancel').onclick = () => showNew(false);
  $('list-new-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('list-new-form').querySelector('button[type=submit]');
    const name = $('list-new-name').value;
    btn.disabled = true;
    try {
      const made = await api('/api/playlists/create', { name });
      // Close the form only if it still holds what we sent (not a new name
      // someone started typing meanwhile).
      if ($('list-new-name').value === name) {
        $('list-new-name').value = '';
        showNew(false);
      }
      remember(made.id);
      await load();
    } catch (err) {
      showErr(err);
    } finally {
      btn.disabled = false;
    }
  };

  const showEdit = (on) => {
    $('list-edit').hidden = !on;
    $('list-delete-confirm').hidden = true;
    if (on) {
      $('list-edit-name').value = current().name;
      $('list-edit-name').focus();
    }
  };
  $('list-menu').onclick = () => showEdit($('list-edit').hidden);
  $('list-edit-cancel').onclick = () => showEdit(false);
  // Close the editor straight away (not when the request returns, which could
  // close it again after it's been reopened); reopen it if the rename fails.
  $('list-rename').onclick = async () => {
    const id = current().id;
    const name = $('list-edit-name').value;
    showEdit(false);
    try {
      await change('/api/playlists/rename', { id, name });
    } catch (e) {
      showErr(e);
      showEdit(true);
    }
  };
  $('list-delete').onclick = () => {
    $('list-edit').hidden = true;
    $('list-delete-name').textContent = current().name;
    $('list-delete-confirm').hidden = false;
  };
  $('list-delete-no').onclick = () => ($('list-delete-confirm').hidden = true);
  $('list-delete-yes').onclick = async () => {
    const id = current().id;
    $('list-delete-confirm').hidden = true;
    try {
      await change('/api/playlists/delete', { id });
    } catch (e) {
      showErr(e);
    }
  };

  $('save-current').onclick = async () => {
    const p = opts.current();
    if (!p) return;
    try {
      await save({ v: p.v, title: p.title, start: 0 });
    } catch (e) {
      showErr(e);
    }
  };

  // The player told us a video's real title: the server fills it in wherever
  // the pair only had the placeholder (playlists and history). Once per video.
  const learned = new Set();
  function learnTitle(v, title) {
    render();
    if (!v || !title || title === PLACEHOLDER_TITLE || learned.has(v)) return;
    learned.add(v);
    api('/api/playlists/title', { v, title }).catch(() => learned.delete(v));
  }

  load();
  return { load, render, save, learnTitle };
}
