// Player view (also used by the referee on the host): one tab per page of the
// live campaign, each in a kept-alive iframe so switching tabs never loses
// scroll position.
//
// Per-player pages: each player picks their name from the campaign's party
// (kept by a cookie the server sets) and sees their own copy. The referee
// sees the template or any player's copy, chosen in a strip above the page.
//
// Tabs can be dragged into this device's own order, and shrunk (right-click,
// or hold on a touch screen). When they don't all fit, the ones at the end
// shrink by themselves, so the row never has to scroll.
//
// This module loads the live campaign and draws the page, opens tabs and handles
// the keyboard and full screen. state.js holds what's loaded; tabs.js, who.js
// and tutorial.js are the rest.
import {
  $, agoText, allTags, api, isPage, attempt, audienceText, chips, esc, gameTag, hasTags, ic, isHidden, isOnly, savedList, saveList,
  keysList, KIND_NAME, kv, listenEvents, liveTag, notice, overlay, PER_PLAYER_HINT, perPlayerTag,
  playerName, SCOPE, scopeTag, serverPort, shortcutAllowed, SHORTCUTS_NOTE, size, titleOf,
  viewUrl, when, withIcon
} from '/_mg/ui.js';
import { tourRunning } from '/_mg/tour.js';
import { bootScreen, switchLinks } from '/_mg/fx.js';
import { activeFile, app, fileKey, frameKey, meName, S } from './state.js';
import { arrange, fitTabs, tabPrefs, redrawWhenFree } from './tabs.js';
import { renderWho, renderPick, renderAsk, pickName } from './who.js';
import { markSeen, primeSeen, seenState } from './seen.js';
import { tutorial } from './tutorial.js';
import { isJumpKey, quickJump } from '/_mg/jump.js';

const FULL_KEY = 'mg-full';

// Whose copy a tab shows: a player id, '' for the template (referee only), or
// null when there is nothing to show yet (a player who hasn't picked a name).
function copyFor(f) {
  if (!f.perPlayer) return '';
  if (S.isHost) {
    const p = S.pick.get(fileKey(f)) || '';
    return S.players.some((x) => x.id === p) ? p : '';
  }
  return S.me || null;
}

// The frames that may exist right now, so nothing stale survives a roster,
// name or per-player change.
function wantedFrames() {
  const keep = new Set();
  S.files.forEach((f) => {
    if (!f.perPlayer) keep.add(fileKey(f));
    else if (S.isHost) { keep.add(frameKey(f, '')); S.players.forEach((p) => keep.add(frameKey(f, p.id))); }
    else if (S.me) keep.add(frameKey(f, S.me));
  });
  return keep;
}

function dropFrame(k) {
  const fr = S.frames.get(k);
  if (fr) fr.remove();
  S.frames.delete(k); S.status.delete(k); S.versions.delete(k);
}

async function load() {
  let d;
  try { d = await api('GET', '/api/active'); } catch (e) { return; }  // the event socket says when it's back
  const newId = d.session ? d.session.id : null;
  const oldId = S.session ? S.session.id : null;
  const was = S.session;
  if (newId !== oldId) {
    Array.from(S.frames.keys()).forEach(dropFrame);
    S.pick.clear();
    if (oldId !== null) S.active = null;
  }
  // What was there before, to tell players about pages that arrive (or are
  // replaced) while they watch. Not on the first load, a session change or
  // a reconnect, when "new" would mean everything.
  const before = S.loaded && newId === oldId && S.serverUp && wasUp
    ? new Map(S.serverFiles.map((f) => [fileKey(f), f.modified])) : null;
  wasUp = S.serverUp;
  S.session = d.session;
  S.serverFiles = d.files || [];
  S.files = arrange(S.serverFiles);
  S.isHost = !!d.isHost;
  S.players = d.players || [];
  S.me = d.me || null;
  const keep = wantedFrames();
  const live = new Map(S.files.map((f) => [fileKey(f), f]));
  Array.from(S.frames.keys()).forEach((k) => {
    if (!keep.has(k)) { dropFrame(k); return; }
    const fr = S.frames.get(k), f = live.get(fr.dataset.file);
    // The viewers aren't told when their file is replaced: reload them.
    if (!isPage(f) && S.versions.get(k) !== f.modified) {
      S.versions.set(k, f.modified);
      fr.src = viewUrl(S.session.id, f, f.modified, fr.dataset.who);
    }
  });
  if (S.session && !S.isHost) {
    primeSeen();
    if (before) announce(before);
  }
  redrawWhenFree();
  if (S.loaded && newId !== oldId && !tourRunning()) {
    if (newId) bootScreen(liveScreen());
    else bootScreen(endScreen(was));
  }
  S.loaded = true;
}

let wasUp = false;  // the events socket was up at the last load
const notices = new Map();  // fileKey -> closes its notice, once the page is opened

// Tells the player about pages that appeared or were replaced since the last
// load, each with a button to open it. The open tab needs no notice.
function announce(before) {
  if (tourRunning()) return;
  S.files.forEach((f) => {
    const k = fileKey(f);
    if (k === S.active) { if (before.get(k) !== f.modified) markSeen(f); return; }
    const was = before.get(k);
    if (was === undefined) notices.set(k, notice({ text: 'New page:', strong: titleOf(f), action: { label: 'open', run: () => show(k, true) } }));
    else if (was !== f.modified) notices.set(k, notice({ text: 'Updated:', strong: titleOf(f), icon: 'reset', action: { label: 'open', run: () => show(k, true) } }));
  });
}

// The referee asked every player who can see a page to look at it. The
// player chooses: nothing switches by itself.
let showing = null;
async function onServerMessage(m) {
  if (m.type !== 'show' || typeof m.key !== 'string' || S.isHost) return;
  let f = S.files.find((x) => fileKey(x) === m.key);
  if (!f) { await load(); f = S.files.find((x) => fileKey(x) === m.key); }
  if (!f || showing === m.key || tourRunning()) return;
  if (S.active === m.key && !document.hidden) {
    notice({ text: 'The referee is pointing at this page:', strong: titleOf(f), icon: 'show' });
    return;
  }
  showing = m.key;
  const body = document.createElement('div');
  body.innerHTML = '<p>The referee wants everyone to look at:</p><p class="show-title"></p>';
  body.querySelector('.show-title').textContent = titleOf(f);
  const v = await overlay({
    title: 'Look at this', icon: 'show', body,
    actions: [{ label: 'later', value: null, kind: 'quiet', icon: 'close' }, { label: 'go to it', value: 'go', kind: 'primary', icon: 'open' }]
  });
  showing = null;
  if (v === 'go' && S.files.some((x) => fileKey(x) === m.key)) show(m.key, true);
}

// What the boot and shutdown screens say (fx.js types them out).
function liveScreen() {
  const n = S.files.length;
  return {
    lines: [].concat(
      [{ k: S.isHost ? 'opening the player dashboard' : 'connecting to the referee', ok: 'OK' },
       { k: 'loading "' + S.session.name + '"', ok: 'OK' }],
      S.session.gameType ? [{ k: 'game: ' + S.session.gameType }] : [],
      [{ k: n + ' page' + (n === 1 ? '' : 's') + (meName() ? ' · you are ' + meName() : '') }]),
    big: 'SESSION LIVE'
  };
}
function endScreen(was) {
  return {
    end: true,
    lines: [{ k: 'saving your entries', ok: 'OK' }, { k: 'closing "' + (was ? was.name : 'the session') + '"', ok: 'OK' }, { k: 'waiting for the referee' }],
    big: 'SESSION ENDED'
  };
}

// ---- tag filter: only the tabs with every chosen tag (this device, per campaign) ----------
const filterKey = () => 'mg-tabfilter:' + (S.session ? S.session.id : '');
function tabFilter() {
  const lower = allTags(S.files).map((t) => t.toLowerCase());
  return savedList(filterKey()).filter((t) => lower.includes(t.toLowerCase()));
}
// The tabs on show: those matching the filter, and always the open one.
function visibleFiles() {
  const filter = tabFilter();
  return filter.length ? S.files.filter((f) => hasTags(f, filter) || fileKey(f) === S.active) : S.files;
}
function drawFilterBtn() {
  const tags = allTags(S.files), filter = tabFilter();
  const b = $('filterBtn');
  b.hidden = !tags.length;
  b.classList.toggle('on', filter.length > 0);
  b.setAttribute('aria-pressed', String(filter.length > 0));
  b.innerHTML = withIcon('filter', filter.length ? filter.join(' + ') : 'filter');
  b.title = filter.length ? 'Showing only pages tagged ' + filter.join(' and ') + ' (t)' : 'Show only pages with a tag (t)';
}
async function filterOverlay() {
  const tags = allTags(S.files);
  if (!tags.length) return;
  const body = document.createElement('div');
  const draw = () => {
    const on = new Set(tabFilter().map((t) => t.toLowerCase()));
    body.innerHTML = '<p class="mg-muted">Show only the tabs with every tag you pick. Kept on this device.</p>' +
      '<div class="tf-chips">' + tags.map((t) => '<button type="button" class="mg-chip tf" data-tag="' + esc(t) + '" aria-pressed="' + on.has(t.toLowerCase()) + '">' + esc(t) + '</button>').join('') + '</div>';
  };
  draw();
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    const now = tabFilter(), i = now.findIndex((x) => x.toLowerCase() === b.dataset.tag.toLowerCase());
    if (i >= 0) now.splice(i, 1); else now.push(b.dataset.tag);
    saveList(filterKey(), now);
    draw();
    render();
  });
  const v = await overlay({ title: 'Filter tabs', icon: 'filter', body, actions: [{ label: 'show all', value: 'all', kind: 'quiet', icon: 'close' }, { label: 'done', value: null, kind: 'primary', icon: 'check' }] });
  if (v === 'all') { saveList(filterKey(), []); render(); }
}

function render() {
  $('adminLink').hidden = !S.isHost;
  drawFilterBtn();
  renderWho();
  const has = !!S.session && S.files.length > 0;
  $('stage').hidden = !has;
  $('empty').hidden = has;
  $('sessionName').textContent = S.session ? S.session.name : 'nothing live';
  $('sessionGame').innerHTML = S.session ? gameTag(S.session.gameType) : '';
  document.title = S.session ? S.session.name + ' · MotherGoose' : 'MotherGoose';

  if (!S.session) {
    $('emptyEyebrow').textContent = 'waiting';
    $('emptyTitle').textContent = 'Nothing is live yet.';
    $('emptyText').textContent = 'Keep this page open. It will update by itself when the referee starts the session.';
  } else if (!S.files.length) {
    $('emptyEyebrow').textContent = S.session.name;
    $('emptyTitle').textContent = 'No pages here yet.';
    $('emptyText').textContent = S.isHost
      ? 'Add pages to this campaign from the referee\'s dashboard, or drop them into its folder.'
      : 'The referee is still setting things up. Pages will appear here automatically.';
  }

  const tabs = $('tabs');
  tabs.textContent = '';
  // When both audiences are present (the referee on the host), each group of
  // tabs starts with a label in its colour.
  const grouped = S.files.some((f) => f.scope === 'gm');
  const small = new Set(tabPrefs().small);
  let lastScope = null;
  visibleFiles().forEach((f, i) => {
    if (grouped && lastScope !== f.scope) {
      const g = document.createElement('span');
      g.className = 'tab-group ' + SCOPE[f.scope].cls;
      g.setAttribute('aria-hidden', 'true');
      g.innerHTML = withIcon(SCOPE[f.scope].icon, SCOPE[f.scope].label);
      tabs.appendChild(g);
    }
    lastScope = f.scope;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab ' + SCOPE[f.scope].cls + (small.has(fileKey(f)) ? ' small' : '');
    b.setAttribute('role', 'tab');
    b.dataset.key = fileKey(f);
    b.dataset.scope = f.scope;
    b.title = titleOf(f) + (f.description ? ': ' + f.description : '') + '  (' + SCOPE[f.scope].label + (i < 9 ? ', key ' + (i + 1) : '') + ')' +
      (f.perPlayer ? '\n' + PER_PLAYER_HINT + (S.isHost ? '. Pick whose copy above the page.' : '.') : '') +
      '\nDrag to reorder. Right-click (or hold) to shrink it.';
    const mark = S.isHost ? '' : seenState(f);
    if (mark) b.title += '\n' + (mark === 'new' ? 'New: you haven\'t opened it yet.' : 'Updated since you last opened it.');
    if (S.isHost && (isHidden(f) || isOnly(f))) {
      b.title += '\n' + (isHidden(f) ? 'Hidden from players. ' : '') + 'Shown to ' + audienceText(f, S.players) + '.';
    }
    b.innerHTML = (i < 9 ? '<span class="n">' + (i + 1) + '</span>' : '') +
      (f.kind !== 'html' ? ic('kind-' + f.kind) : '') +
      (f.perPlayer ? ic('player', 'per') : '') +
      (S.isHost && isHidden(f) ? ic('hidden', 'vis') : S.isHost && isOnly(f) ? ic('only', 'vis') : '') +
      '<span class="t">' + esc(titleOf(f)) + '</span>' +
      (mark ? '<span class="seen ' + mark + '" aria-label="' + (mark === 'new' ? 'new' : 'updated') + '"></span>' : '');
    tabs.appendChild(b);
  });

  if (!has) { S.active = null; S.shown = null; updateSync(); return; }
  let want = S.active;
  if (!want || !S.files.some((f) => fileKey(f) === want)) {
    const fromHash = decodeURIComponent(location.hash.slice(1));
    want = S.files.some((f) => fileKey(f) === fromHash) ? fromHash : fileKey(S.files[0]);
  }
  show(want, false);
}

function show(key, focusTab) {
  const f = S.files.find((x) => fileKey(x) === key);
  if (!f) return;
  S.active = key;
  try { history.replaceState(null, '', '#' + encodeURIComponent(key)); } catch (e) {}
  const who = copyFor(f);
  renderPick(f, who);
  const fk = who === null ? null : frameKey(f, who);
  if (fk && !S.frames.has(fk)) {
    const fr = document.createElement('iframe');
    fr.src = viewUrl(S.session.id, f, !isPage(f) ? f.modified : '', who);
    fr.title = titleOf(f) + (who ? ': ' + playerName(S.players, who) : f.perPlayer ? ': template' : '');
    if (!isPage(f)) fr.className = 'viewer';
    fr.setAttribute('allow', 'fullscreen');
    fr.dataset.file = fileKey(f);
    fr.dataset.who = who;
    S.frames.set(fk, fr);
    S.versions.set(fk, f.modified);
    // Pages and PDFs report their sync status; images have nothing to sync.
    S.status.set(fk, f.kind === 'image' ? 'static' : 'connecting');
    $('frames').appendChild(fr);
  }
  S.shown = fk;
  if (notices.has(key)) { notices.get(key)(); notices.delete(key); }
  if (!S.isHost && seenState(f)) {
    markSeen(f);
    const mark = document.querySelector('.tab[data-key="' + CSS.escape(key) + '"] .seen');
    if (mark) mark.remove();
  }
  S.frames.forEach((fr, k) => { fr.hidden = k !== fk; });
  $('who').hidden = !!fk;
  if (!fk) renderAsk(f);
  let on = null;
  document.querySelectorAll('.tab').forEach((b) => {
    const is = b.dataset.key === key;
    b.setAttribute('aria-selected', is ? 'true' : 'false');
    b.tabIndex = is ? 0 : -1; // roving focus: arrow keys move within the tab list
    if (is) on = b;
  });
  fitTabs();   // the open tab is never one of those shrunk to fit
  if (on) {
    on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focusTab) on.focus();
  }
  updateSync();
}


function step(delta) {
  const list = visibleFiles();
  const i = list.findIndex((f) => fileKey(f) === S.active);
  if (i < 0 || !list.length) return;
  show(fileKey(list[(i + delta + list.length) % list.length]), true);
}

// ---- connection state ----------------------------------------------------------

const STATUS_TEXT = { live: 'live', static: 'live', connecting: 'connecting', offline: 'reconnecting', closed: 'closed' };

function syncState() {
  if (!S.serverUp) return 'down';
  if (!S.shown) return 'live';   // nothing open that syncs
  return S.status.get(S.shown) || 'connecting';
}

function updateSync() {
  const st = syncState();
  const text = st === 'down' ? 'server offline' : STATUS_TEXT[st] || st;
  const live = st === 'live' || st === 'static';
  const btn = $('syncBtn');
  btn.classList.toggle('is-live', live);
  btn.classList.toggle('mg-state', !live);
  btn.classList.toggle('err', st === 'down' || st === 'closed');
  btn.classList.toggle('warn', !live && st !== 'down' && st !== 'closed');
  $('syncLabel').textContent = live ? 'LIVE:' + serverPort() : st === 'down' ? 'OFFLINE' : text;
  btn.title = (live ? 'Connected and syncing' : 'Sync: ' + text) + ' (i for details)';
}

// Status reports from pages (posted by inject.js) and the PDF viewer.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || e.data.mg !== 'status') return;
  S.frames.forEach((fr, k) => { if (fr.contentWindow === e.source) S.status.set(k, e.data.status); });
  updateSync();
});

// ---- overlays -------------------------------------------------------------------

function detailsOverlay() {
  const f = activeFile();
  const st = syncState();
  const rows = [
    ['campaign', S.session ? esc(S.session.name) + ' <span class="mg-muted">live now</span>' : '<span class="mg-muted">none live</span>'],
    ['game', S.session && S.session.gameType ? gameTag(S.session.gameType) : '<span class="mg-muted">not set</span>'],
    ['you are', S.isHost ? 'the referee (this is the host computer)'
      : S.me ? '<b>' + esc(meName()) + '</b> <span class="mg-muted">a player, on this device</span>'
      : 'a player' + (S.players.length ? ' <span class="mg-muted">no name picked yet: use "who are you?" at the top</span>' : '')],
    ['server', S.serverUp ? liveTag() + ' <span class="mg-muted">at ' + esc(location.host) + '</span>' : '<span class="mg-state err">unreachable</span>'],
  ];
  if (f) {
    const who = copyFor(f);
    rows.push(
      ['page', '<b>' + esc(titleOf(f)) + '</b>'],
      ['about', f.description ? '<span class="desc">' + esc(f.description) + '</span>' : '<span class="mg-muted">no description</span>'],
      ['tags', chips(f.tags) || '<span class="mg-muted">none</span>'],
      ['for', scopeTag(f.scope) + (f.perPlayer ? ' ' + perPlayerTag() : '')]
    );
    if (f.perPlayer) {
      rows.push(['copy', who === null ? '<span class="mg-muted">none yet: ' + (S.players.length ? 'pick your name first' : 'the referee hasn\'t added players') + '</span>'
        : S.isHost ? (who ? '<b>' + esc(playerName(S.players, who)) + '</b>\'s copy' : 'the template <span class="mg-muted">starting values for each player\'s copy</span>')
        : 'yours, as <b>' + esc(meName()) + '</b> <span class="mg-muted">only you and the referee see it</span>']);
    }
    rows.push(
      ['file', esc(f.name)],
      ['type', f.kind === 'html' ? 'HTML page: entries are saved and synced' : f.kind === 'md' ? 'Markdown page: ticked boxes are saved and synced'
        : f.kind === 'pdf' ? 'PDF: form fields are saved and synced' : KIND_NAME[f.kind]],
      ['size', size(f.size)],
      ['changed', esc(when(f.modified)) + ' <span class="mg-muted">(' + esc(agoText(f.modified)) + ')</span>'],
      ['sync', f.kind === 'image' ? '<span class="mg-muted">nothing to sync</span>' : !S.shown ? '<span class="mg-muted">nothing open</span>'
        : st === 'live' ? 'saved and syncing' : esc(STATUS_TEXT[st] || st)]
    );
  }
  overlay({ title: 'Campaign details', icon: 'info', wide: true, body: kv(rows) });
}

async function helpOverlay() {
  const keys = [
    ['f', 'full screen on / off'], ['esc', 'leave full screen'], ['1 – 9', 'jump to a tab'],
    ['[  ]', 'previous / next tab'], ['t', 'filter the tabs by tag'], ['ctrl k  /', 'jump to a page'], ['← →', 'move between tabs (when a tab has focus)'], ['i', 'campaign details'], ['?', 'this help']
  ];
  const mouse = [
    ['drag a tab', 'put the tabs in your own order (on this device)'],
    ['right-click a tab', 'shrink it, move it, or reset the order. On a touch screen, hold the tab']
  ];
  const v = await overlay({
    title: 'Help',
    icon: 'help',
    body: '<p><b>New here?</b> The <b>player tutorial</b> walks you through every part of this screen, one step at a time.</p>' +
      '<hr class="mg-rule"><div class="mg-section-label">Keyboard shortcuts</div>' +
      keysList(keys) + SHORTCUTS_NOTE +
      '<hr class="mg-rule"><div class="mg-section-label">Tabs</div>' + kv(mouse),
    actions: [{ label: 'player tutorial', value: 'tour', kind: 'primary', icon: 'tutorial' }]
  });
  if (v === 'tour') tutorial();
}


$('sessionBtn').addEventListener('click', detailsOverlay);
$('syncBtn').addEventListener('click', detailsOverlay);
$('helpBtn').addEventListener('click', helpOverlay);
$('whoBtn').addEventListener('click', attempt(pickName));
$('filterBtn').addEventListener('click', filterOverlay);

// ---- full screen ------------------------------------------------------------------
// Collapses the app UI to the tab strip, and also asks the browser for real
// full screen where it's supported (not on iPhone). Leaving browser full
// screen with the browser's own controls leaves our mode too.

let ownFullscreen = false;
const root = document.documentElement;
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;

function setFull(on, browserToo = true) {
  document.body.classList.toggle('mg-full', on);
  try { localStorage.setItem(FULL_KEY, on ? '1' : ''); } catch (e) {}
  const b = $('fullBtn');
  b.innerHTML = on ? withIcon('shrink', 'shrink') : withIcon('full', 'full screen');
  b.title = on ? 'Shrink: show the app bar again (f or esc)' : 'Full screen (f)';
  b.setAttribute('aria-pressed', String(on));
  fitTabs();
  if (on && browserToo && !fsElement()) {
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (req) {
      try {
        Promise.resolve(req.call(root)).then(() => { ownFullscreen = true; }, () => {});
      } catch (e) {}
    }
  } else if (!on && fsElement() && ownFullscreen) {
    ownFullscreen = false;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) try { Promise.resolve(exit.call(document)).catch(() => {}); } catch (e) {}
  }
}
const onFsChange = () => {
  if (!fsElement() && ownFullscreen) { ownFullscreen = false; setFull(false); }
};
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
$('fullBtn').addEventListener('click', () => setFull(!document.body.classList.contains('mg-full')));

// Restore the collapsed layout (browser full screen needs a click, so not that).
$('fullBtn').innerHTML = withIcon('full', 'full screen');
let wasFull = false;
try { wasFull = localStorage.getItem(FULL_KEY) === '1'; } catch (e) {}
if (wasFull) setFull(true, false);

// ---- keyboard ----------------------------------------------------------------------

// Quick jump: every tab, by title, file name, description or tag.
function jump() {
  if (!S.files.length) return;
  quickJump({
    title: 'Jump to a page', placeholder: 'page or #tag',
    items: S.files.map((f) => ({
      title: titleOf(f), sub: SCOPE[f.scope].label + (f.perPlayer ? ' · per player' : ''), icon: 'kind-' + f.kind, cls: SCOPE[f.scope].cls,
      tags: f.tags, text: f.name + ' ' + (f.description || ''), run: () => show(fileKey(f), true)
    }))
  });
}

document.addEventListener('keydown', (e) => {
  if (isJumpKey(e) && !document.querySelector('dialog[open]')) { e.preventDefault(); jump(); return; }
  if (!shortcutAllowed(e)) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); jump(); return; }
  if (k === 'f') { setFull(!document.body.classList.contains('mg-full')); }
  else if (k === 'Escape' && document.body.classList.contains('mg-full')) { setFull(false); }
  else if (/^[1-9]$/.test(k) && visibleFiles()[+k - 1]) { show(fileKey(visibleFiles()[+k - 1]), true); }
  else if (k === 't' && allTags(S.files).length) { filterOverlay(); }
  else if (k === '[') { step(-1); }
  else if (k === ']') { step(1); }
  else if ((k === 'ArrowRight' || k === 'ArrowLeft') && e.target.closest && e.target.closest('.tabs')) { step(k === 'ArrowRight' ? 1 : -1); }
  else if (k === 'i') { detailsOverlay(); }
  else if (k === '?') { helpOverlay(); }
  else return;
  e.preventDefault();
});

// ---- live updates ---------------------------------------------------------------------

// Opened by "player tutorial" on the referee's start page: start the tour
// once the page is in and has switched on.
const wantTour = new URLSearchParams(location.search).has('tour');
if (wantTour) history.replaceState(null, '', location.pathname + location.hash);

app.render = render;
app.show = show;
app.load = load;
// After picking another name: frames reopen as the new player, and the
// events socket reconnects so the server knows who this device is now.
app.dropFrames = () => Array.from(S.frames.keys()).forEach(dropFrame);
app.setFull = setFull;
app.detailsOverlay = detailsOverlay;

switchLinks();
const events = listenEvents(load, (up) => { S.serverUp = up; updateSync(); }, onServerMessage);
app.reconnectEvents = () => events.reconnect();
load().then(async () => {
  if (!wantTour) return;
  for (let i = 0; i < 20 && document.documentElement.classList.contains('mg-arrive'); i++) await new Promise((r) => setTimeout(r, 100));
  tutorial();
});
