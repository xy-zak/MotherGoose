// The player view's tab row: this device's own order for the tabs, shrinking
// them to fit, the tag filter, and dragging tabs into a new order.
// Kept on this device, per session: { order: [fileKey…] }.
// Pages not in the order (added since) follow it, in the referee's order.
import { $, allTags, hasTags, overlay, savedTags, saveList, tagToggles, toggleTag, withIcon } from '/_mg/ui.js';
import { app, fileKey, S } from './state.js';

const tabsEl = $('tabs');
let tabDrag = null;      // { tab, x, y, touch, active, held, moved, timer }
let renderLater = false; // a reload came in mid-drag
let eatClick = false;    // the click that ends a drag doesn't also open the tab

/** redrawWhenFree redraws now, or once the tab being dragged is dropped. */
export function redrawWhenFree() {
  if (tabDrag && tabDrag.active) renderLater = true;
  else app.render();
}

const tabKey = () => 'mg-tabs:' + (S.session ? S.session.id : '');
export function tabPrefs() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(tabKey()) || 'null'); } catch (e) {}
  return { order: v && Array.isArray(v.order) ? v.order : [] };
}
function saveTabPrefs(p) {
  try {
    if (!p.order.length) localStorage.removeItem(tabKey());
    else localStorage.setItem(tabKey(), JSON.stringify(p));
  } catch (e) {}
}

// The pages in tab order: players' pages, then the referee's, each group in
// this device's order.
export function arrange(files) {
  const order = tabPrefs().order;
  const pos = new Map(order.map((k, i) => [k, i]));
  const rank = (f, i) => [f.scope === 'gm' ? 1 : 0, pos.has(fileKey(f)) ? pos.get(fileKey(f)) : order.length + i];
  return files.map((f, i) => ({ f, r: rank(f, i) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1]).map((x) => x.f);
}

function setOrder(keys) {
  const p = tabPrefs();
  // Back in the referee's order: nothing of this device's own to keep.
  p.order = keys.join('\n') === defaultKeys().join('\n') ? [] : keys;
  saveTabPrefs(p);
  S.files = arrange(S.serverFiles);
  app.render();
}
// The tab order with nothing of this device's own.
const defaultKeys = () => S.serverFiles.map((f, i) => ({ f, i }))
  .sort((a, b) => (a.f.scope === 'gm') - (b.f.scope === 'gm') || a.i - b.i).map((x) => fileKey(x.f));

// Shrinks tabs from the end, other than the open one, until the row fits.
// Group labels go down to their icons first. The open tab always keeps its
// full size; if the row still doesn't fit, it scrolls.
export function fitTabs() {
  if (tabDrag && tabDrag.active) return;
  const box = $('tabs');
  const tabs = Array.from(box.querySelectorAll('.tab'));
  box.classList.remove('tight');
  tabs.forEach((t) => t.classList.remove('auto-small'));
  const over = () => box.scrollWidth > box.clientWidth + 1;
  box.classList.remove('overflowing');
  if (!over()) return;
  box.classList.add('tight');
  for (let i = tabs.length - 1; i >= 0 && over(); i--) {
    const t = tabs[i];
    if (t.getAttribute('aria-selected') !== 'true') t.classList.add('auto-small');
  }
  box.classList.toggle('overflowing', over());   // still too many: the row scrolls, and its edges fade
}
let fitFrame = 0;
new ResizeObserver(() => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(fitTabs); }).observe($('tabs'));
if (document.fonts) document.fonts.ready.then(fitTabs);

// ---- the tag filter: only the tabs with every chosen tag (this device, per campaign) -------

const filterKey = () => 'mg-tabfilter:' + (S.session ? S.session.id : '');
const tabFilter = () => savedTags(filterKey(), S.files);

/** visibleFiles is the tabs on show: those matching the filter, and always the open one. */
export function visibleFiles() {
  const filter = tabFilter();
  return filter.length ? S.files.filter((f) => hasTags(f, filter) || fileKey(f) === S.active) : S.files;
}

/** drawFilterBtn shows the filter button when pages have tags, shaded while filtering. */
export function drawFilterBtn() {
  const filter = tabFilter();
  const b = $('filterBtn');
  b.hidden = !allTags(S.files).length;
  b.classList.toggle('on', filter.length > 0);
  b.setAttribute('aria-pressed', String(filter.length > 0));
  b.innerHTML = withIcon('filter', filter.length ? filter.join(' + ') : 'filter');
  b.title = filter.length ? 'Showing only pages tagged ' + filter.join(' and ') + ' (t)' : 'Show only pages with a tag (t)';
}

/** filterOverlay picks the filter's tags; the tabs follow as they are picked. */
export async function filterOverlay() {
  const tags = allTags(S.files);
  if (!tags.length) return;
  const body = document.createElement('div');
  const draw = () => {
    body.innerHTML = '<p class="mg-muted">Show only the tabs with every tag you pick. Kept on this device.</p>' +
      '<div class="tf-chips">' + tagToggles(tags, tabFilter()) + '</div>';
  };
  draw();
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    saveList(filterKey(), toggleTag(tabFilter(), b.dataset.tag));
    draw();
    app.render();
  });
  const v = await overlay({ title: 'Filter tabs', icon: 'filter', body, actions: [{ label: 'clear filter', value: 'all', kind: 'quiet', icon: 'close' }, { label: 'done', value: null, kind: 'primary', icon: 'check' }] });
  if (v === 'all') { saveList(filterKey(), []); app.render(); }
}

// ---- dragging tabs into another order -------------------------------------------------
// A mouse drags straight away; a finger holds a moment first (so swiping
// still scrolls). Tabs only move within their own group (players' or
// referee's pages).


function beginTabDrag() {
  const d = tabDrag;
  if (!d || d.active) return;
  d.active = true;
  d.tab.classList.add('dragging');
  tabsEl.classList.add('dragging');
  if (d.touch && navigator.vibrate) try { navigator.vibrate(8); } catch (e) {}
}

tabsEl.addEventListener('pointerdown', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab || e.button !== 0 || !e.isPrimary) return;
  tabDrag = { tab, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', active: false, held: false, moved: false, timer: 0 };
  if (tabDrag.touch) {
    const d = tabDrag;
    d.timer = setTimeout(() => { if (tabDrag === d) { d.held = true; beginTabDrag(); } }, 420);
  }
});
addEventListener('pointermove', (e) => {
  const d = tabDrag;
  if (!d || !e.isPrimary) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (!d.active) {
    if (d.touch) { if (Math.hypot(dx, dy) > 10) { clearTimeout(d.timer); tabDrag = null; } return; }  // a swipe
    if (Math.abs(dx) < 6) return;
    beginTabDrag();
  }
  if (Math.abs(dx) > 4) d.moved = true;
  const peers = Array.from(tabsEl.querySelectorAll('.tab')).filter((t) => t.dataset.scope === d.tab.dataset.scope);
  const me = peers.indexOf(d.tab);
  let target = null, after = false;
  peers.forEach((t, i) => {
    if (i === me) return;
    const b = t.getBoundingClientRect(), mid = (b.left + b.right) / 2;
    if (i < me && e.clientX < mid && !target) { target = t; after = false; }
    if (i > me && e.clientX > mid) { target = t; after = true; }
  });
  if (target) { if (after) target.after(d.tab); else target.before(d.tab); }
  // Near either end of a row that scrolls: scroll it along.
  const box = tabsEl.getBoundingClientRect();
  if (e.clientX < box.left + 24) tabsEl.scrollLeft -= 12;
  else if (e.clientX > box.right - 24) tabsEl.scrollLeft += 12;
});
function endTabDrag(drop) {
  const d = tabDrag;
  if (!d) return;
  tabDrag = null;
  clearTimeout(d.timer);
  if (!d.active) return;   // a plain click: the tab opens as usual
  d.tab.classList.remove('dragging');
  tabsEl.classList.remove('dragging');
  eatClick = true;
  setTimeout(() => { eatClick = false; }, 400);
  renderLater = false;
  if (drop && d.moved) {
    // Tabs hidden by the tag filter keep their places: only the shown ones move.
    const shown = Array.from(tabsEl.querySelectorAll('.tab')).map((t) => t.dataset.key);
    const on = new Set(shown);
    let j = 0;
    setOrder(S.files.map(fileKey).map((k) => (on.has(k) ? shown[j++] : k)));
  }
  else app.render();   // cancelled: back as they were
}
addEventListener('pointerup', () => endTabDrag(true));
addEventListener('pointercancel', () => endTabDrag(false));
// While a finger drags a tab, the row mustn't scroll under it.
tabsEl.addEventListener('touchmove', (e) => { if (tabDrag && tabDrag.active) e.preventDefault(); }, { passive: false });
tabsEl.addEventListener('click', (e) => {
  if (eatClick && e.target.closest('.tab')) { e.stopPropagation(); e.preventDefault(); eatClick = false; }
}, true);
// Tabs are redrawn often: one listener on the row opens whichever is clicked.
// (The capture listener above stops the click that ends a drag first.)
tabsEl.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) app.show(tab.dataset.key);
});
// A long press on a touch screen starts a drag, so the browser's own menu
// mustn't open on a tab.
tabsEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.tab') && tabDrag && tabDrag.touch) e.preventDefault(); });
