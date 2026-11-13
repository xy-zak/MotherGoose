// The player view's tab row: this device's own order and sizes for the tabs,
// shrinking them to fit, the tab menu, and dragging tabs into a new order.
// Kept on this device, per session: { order: [fileKey…], small: [fileKey…] }.
// Pages not in the order (added since) follow it, in the referee's order.
import { $, esc, ic, titleOf } from '/_mg/ui.js';
import { app, fileKey, S } from './state.js';
import { motion } from '/_mg/fx.js';

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
  return { order: v && Array.isArray(v.order) ? v.order : [], small: v && Array.isArray(v.small) ? v.small : [] };
}
function saveTabPrefs(p) {
  try {
    if (!p.order.length && !p.small.length) localStorage.removeItem(tabKey());
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

function setSmall(key, on) {
  const p = tabPrefs();
  p.small = p.small.filter((k) => k !== key);
  if (on) p.small.push(key);
  saveTabPrefs(p);
  const b = document.querySelector('.tab[data-key="' + CSS.escape(key) + '"]');
  if (b) b.classList.toggle('small', on);
  fitTabs();
}

// Shrinks tabs from the end, other than the open one, until the row fits.
// Group labels go down to their icons first. Only on a tiny screen does the
// open tab shrink too, and after that the row scrolls.
export function fitTabs() {
  if (tabDrag && tabDrag.active) return;
  const box = $('tabs');
  const tabs = Array.from(box.querySelectorAll('.tab'));
  box.classList.remove('tight');
  tabs.forEach((t) => t.classList.remove('auto-small'));
  const over = () => box.scrollWidth > box.clientWidth + 1;
  if (!over()) return;
  box.classList.add('tight');
  for (let i = tabs.length - 1; i >= 0 && over(); i--) {
    const t = tabs[i];
    if (!t.classList.contains('small') && t.getAttribute('aria-selected') !== 'true') t.classList.add('auto-small');
  }
  if (over()) { const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true'); if (sel) sel.classList.add('auto-small'); }
}
let fitFrame = 0;
new ResizeObserver(() => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(fitTabs); }).observe($('tabs'));
if (document.fonts) document.fonts.ready.then(fitTabs);

// ---- the tab menu: right-click, the menu key, or hold on a touch screen ---------------

let menu = null;
function closeMenu(refocus) {
  if (!menu) return;
  const { el, tab } = menu;
  menu = null;
  // It switches off like the popups do, then goes.
  const gone = () => { try { if (el.matches(':popover-open')) el.hidePopover(); } catch (e) {} el.remove(); };
  if (motion() === 'off') gone();
  else { el.classList.add('mg-closing'); setTimeout(gone, motion() === 'full' ? 150 : 120); }
  removeEventListener('pointerdown', menuOutside, true);
  removeEventListener('keydown', menuKey, true);
  removeEventListener('resize', closeMenuNow);
  if (refocus && tab.isConnected) tab.focus();
}
const closeMenuNow = () => closeMenu(false);
const menuOutside = (e) => { if (menu && !menu.el.contains(e.target)) closeMenu(false); };
function menuKey(e) {
  if (!menu) return;
  const items = Array.from(menu.el.querySelectorAll('button:not(:disabled)'));
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    if (n) n.focus();
  }
}

function openMenu(tab, x, y, byKey) {
  closeMenu(false);
  const key = tab.dataset.key;
  const f = S.files.find((v) => fileKey(v) === key);
  if (!f) return;
  const p = tabPrefs();
  const isSmall = p.small.includes(key);
  const group = S.files.filter((v) => v.scope === f.scope);
  const at = group.indexOf(f);
  const item = (act, icon, text, disabled) => '<button type="button" role="menuitem" data-menu="' + act + '"' + (disabled ? ' disabled' : '') + '>' + ic(icon) + '<span>' + esc(text) + '</span></button>';
  const el = document.createElement('div');
  el.className = 'mg-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Tab: ' + titleOf(f));
  if (typeof el.showPopover === 'function') el.setAttribute('popover', 'manual');
  el.innerHTML = '<div class="head">' + esc(titleOf(f)) + '</div>' +
    (isSmall ? item('expand', 'full', 'expand tab') : item('shrink', 'shrink', 'shrink tab')) +
    item('left', 'prev', 'move left', at <= 0) +
    item('right', 'next', 'move right', at >= group.length - 1) +
    '<hr>' +
    item('expand-all', 'full', 'expand all tabs', !p.small.length) +
    item('reset', 'reset', 'reset tab order', !p.order.length);
  document.body.appendChild(el);
  try { if (el.showPopover) el.showPopover(); } catch (e) {}
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  el.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  menu = { el, tab };
  addEventListener('pointerdown', menuOutside, true);
  addEventListener('keydown', menuKey, true);
  addEventListener('resize', closeMenuNow);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu]');
    if (!b || b.disabled) return;
    const act = b.dataset.menu;
    closeMenu(false);
    const keys = S.files.map(fileKey);
    const i = keys.indexOf(key);
    if (act === 'shrink' || act === 'expand') setSmall(key, act === 'shrink');
    else if (act === 'left' || act === 'right') {
      const j = i + (act === 'left' ? -1 : 1);
      [keys[i], keys[j]] = [keys[j], keys[i]];
      setOrder(keys);
    } else if (act === 'expand-all') { const q = tabPrefs(); q.small = []; saveTabPrefs(q); app.render(); }
    else if (act === 'reset') { const q = tabPrefs(); q.order = []; saveTabPrefs(q); S.files = arrange(S.serverFiles); app.render(); }
    const again = document.querySelector('.tab[data-key="' + CSS.escape(key) + '"]');
    if (again && byKey) again.focus();
  });
  const first = el.querySelector('button:not(:disabled)');
  if (first && byKey) first.focus();
}

// ---- dragging tabs into another order -------------------------------------------------
// A mouse drags straight away; a finger holds a moment first (so swiping
// still scrolls), and holding without moving opens the tab menu instead.
// Tabs only move within their own group (players' or referee's pages).


function beginTabDrag() {
  const d = tabDrag;
  if (!d || d.active) return;
  d.active = true;
  closeMenu(false);
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
  if (drop && d.held && !d.moved) {
    renderLater = false;
    app.render();
    const again = document.querySelector('.tab[data-key="' + CSS.escape(d.tab.dataset.key) + '"]') || d.tab;
    const r = again.getBoundingClientRect();
    openMenu(again, r.left, r.bottom + 2, false);
    return;
  }
  renderLater = false;
  if (drop && d.moved) setOrder(Array.from(tabsEl.querySelectorAll('.tab')).map((t) => t.dataset.key));
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
tabsEl.addEventListener('contextmenu', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  e.preventDefault();
  if (tabDrag && tabDrag.touch) return;   // the hold opens it, when the finger lifts
  const byKey = e.clientX === 0 && e.clientY === 0;   // the menu key or Shift+F10
  const r = tab.getBoundingClientRect();
  openMenu(tab, byKey ? r.left : e.clientX, byKey ? r.bottom + 2 : e.clientY, byKey);
});
tabsEl.addEventListener('scroll', closeMenuNow);
