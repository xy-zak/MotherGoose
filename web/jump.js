// Quick jump (Ctrl+K, ⌘K or /): one search box over everything a view can
// open. Type part of a page's title, file name, description or tags; "#map"
// keeps to pages tagged map. ↑ ↓ choose, Enter opens. The dashboard also
// finds campaigns and party members; the player view finds its tabs.
import { esc, ic, overlay } from '/_mg/ui.js';

const MAX = 50;

/**
 * quickJump opens the search over items and runs the one picked.
 *   items: [{ title, sub, icon, cls, tags: [], text, run }]
 *     sub:  a second, muted line (e.g. the file name or campaign)
 *     cls:  'players' | 'referee' | '' tints the icon by audience
 *     text: anything else to search (description, file name)
 *   placeholder: the search box's hint
 */
export function quickJump({ items, placeholder = 'jump to…', title = 'Jump to' }) {
  const body = document.createElement('div');
  body.className = 'jump';
  // A combobox: focus stays in the box, ↑ ↓ move the highlighted result
  // (aria-activedescendant), and the number of results is read out.
  const touch = matchMedia('(pointer: coarse)').matches;
  body.innerHTML = '<input class="mg-input jump-q" type="search" role="combobox" aria-expanded="true" aria-controls="jump-list" aria-autocomplete="list"' +
      ' autocomplete="off" spellcheck="false" aria-label="Search" placeholder="' + esc(placeholder) + '">' +
    '<ul class="jump-list" id="jump-list" role="listbox" aria-label="Results"></ul>' +
    '<p class="mg-vh jump-count" aria-live="polite"></p>' +
    '<p class="mg-muted jump-help">' + (touch ? 'Tap one to open it · <kbd>#tag</kbd> only pages with that tag'
      : '<kbd>↑</kbd> <kbd>↓</kbd> choose · <kbd>enter</kbd> open · <kbd>#tag</kbd> only pages with that tag') + '</p>';
  const q = body.querySelector('.jump-q');
  const list = body.querySelector('.jump-list');
  let shown = [], at = 0, picked = null;

  const draw = () => {
    shown = search(items, q.value).slice(0, MAX);
    at = Math.min(at, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length ? shown.map((it, i) =>
      '<li role="option" id="jump-' + i + '" data-i="' + i + '" aria-selected="' + (i === at) + '">' +
        '<span class="ji ' + esc(it.cls || '') + '">' + ic(it.icon || 'kind-html') + '</span>' +
        '<span class="jt"><b>' + esc(it.title) + '</b>' + (it.sub ? '<span class="mg-muted">' + esc(it.sub) + '</span>' : '') + '</span>' +
        (it.tags && it.tags.length ? '<span class="mg-chips">' + it.tags.slice(0, 4).map((t) => '<span class="mg-chip">' + esc(t) + '</span>').join('') + '</span>' : '') +
      '</li>').join('')
      : '<li class="none mg-muted">Nothing matches.</li>';
    q.setAttribute('aria-activedescendant', shown.length ? 'jump-' + at : '');
    body.querySelector('.jump-count').textContent = shown.length ? shown.length + ' result' + (shown.length === 1 ? '' : 's') : 'Nothing matches';
    const on = list.querySelector('[aria-selected="true"]');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };

  return overlay({
    title, icon: 'search', body,
    onOpen: (d) => {
      d.classList.add('jump-dialog');
      draw();
      q.focus();
      q.addEventListener('input', () => { at = 0; draw(); });
      q.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (shown.length) { at = (at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; draw(); }
        } else if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey) {
          e.preventDefault();
          at = e.key === 'Home' ? 0 : Math.max(0, shown.length - 1);
          draw();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (shown[at]) { picked = shown[at]; d.close(); }
        }
      });
      list.addEventListener('click', (e) => {
        const li = e.target.closest('[data-i]');
        if (li) { picked = shown[+li.dataset.i]; d.close(); }
      });
    }
  }).then(() => { if (picked) picked.run(); });
}

// search ranks the items matching every word of the query: #words must be
// (the start of) one of an item's tags; other words may be anywhere in its
// title, sub line, tags or text. Titles that start with the query come first.
function search(items, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const tagWords = words.filter((w) => w.startsWith('#') && w.length > 1).map((w) => w.slice(1));
  const plain = words.filter((w) => !w.startsWith('#'));
  const out = [];
  items.forEach((it, i) => {
    const tags = (it.tags || []).map((t) => t.toLowerCase());
    if (!tagWords.every((w) => tags.some((t) => t.startsWith(w)))) return;
    const title = (it.title || '').toLowerCase();
    const hay = [title, it.sub || '', tags.join(' '), it.text || ''].join(' ').toLowerCase();
    if (!plain.every((w) => hay.includes(w))) return;
    const first = plain[0] || '';
    const rank = !first ? 2 : title.startsWith(first) ? 0 : title.includes(first) ? 1 : 2;
    out.push({ it, rank, i });
  });
  return out.sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.it);
}

/** isJumpKey: Ctrl+K / ⌘K anywhere, or / when no field has focus (checked by the caller). */
export const isJumpKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
