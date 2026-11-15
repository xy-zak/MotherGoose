// Player view (also used by the referee on the host): one tab per page of the
// live campaign, each in a kept-alive iframe so switching tabs never loses
// scroll position.
//
// Per-player pages: each player picks their name from the campaign's party
// (kept by a cookie the server sets) and sees their own copy. The referee
// sees the starting copy or any player's copy, chosen in a strip above the page.
//
// Tabs can be dragged into this device's own order, and shrunk (right-click,
// or hold on a touch screen). When they don't all fit, the ones at the end
// shrink by themselves, so the row never has to scroll.
//
// This module loads the live campaign and draws the page, opens tabs and handles
// the keyboard and full screen. state.js holds what's loaded; tabs.js, who.js
// and tutorial.js are the rest.
import {
  $, agoText, allTags, api, enc, isPage, attempt, audienceText, chips, esc, gameTag, ic, isHidden, isOnly,
  keysList, KIND_NAME, kv, listenEvents, liveTag, notice, overlay, PER_PLAYER_HINT, perPlayerTag,
  playerName, popMenu, SCOPE, scopeTag, serverPort, shortcutAllowed, SHORTCUTS_NOTE, size, titleOf,
  viewUrl, when, withIcon
} from '/_mg/ui.js';
import { tourRunning } from '/_mg/tour.js';
import { bootScreen, switchLinks } from '/_mg/fx.js';
import { activeFile, app, fileKey, frameKey, meName, previewing, S, whoNow } from './state.js';
import { arrange, drawFilterBtn, filterOverlay, fitTabs, tabPrefs, redrawWhenFree, visibleFiles } from './tabs.js';
import { renderWho, renderPick, renderAsk, pickName } from './who.js';
import { markSeen, primeSeen, seenState } from './seen.js';
import { announce, dismissNotice, onServerMessage } from './notices.js';
import { tutorial } from './tutorial.js';
import { isJumpKey, quickJump } from '/_mg/jump.js';

const FULL_KEY = 'mg-full';      // full screen, kept for the campaign it was chosen in
const VIEW_AS_KEY = 'mg-view-as';
const pickKey = () => 'mg-pick:' + (S.session ? S.session.id : '');

// The referee's preview as a player, and whose copy each page shows, are
// kept for this tab (sessionStorage), so a reload doesn't lose them.
try { const v = sessionStorage.getItem(VIEW_AS_KEY); if (v !== null) S.viewAs = v; } catch (e) {}
function savePicks() {
  try { sessionStorage.setItem(pickKey(), JSON.stringify(Array.from(S.pick.entries()))); } catch (e) {}
}
function loadPicks() {
  S.pick.clear();
  try { (JSON.parse(sessionStorage.getItem(pickKey()) || '[]') || []).forEach(([k, v]) => S.pick.set(k, v)); } catch (e) {}
}
app.savePicks = savePicks;

// Whose copy a tab shows: a player id, '' for the starting copy (referee
// only), or null when there is nothing to show yet (no name picked).
function copyFor(f) {
  if (!f.perPlayer) return '';
  if (S.isHost && !previewing()) {
    const p = S.pick.get(fileKey(f)) || '';
    return S.players.some((x) => x.id === p) ? p : '';
  }
  return whoNow() || null;
}

// The frames that may exist right now, so nothing stale survives a roster,
// name or per-player change.
function wantedFrames() {
  const keep = new Set();
  S.files.forEach((f) => {
    if (!f.perPlayer) keep.add(fileKey(f));
    else if (S.isHost && !previewing()) { keep.add(frameKey(f, '')); S.players.forEach((p) => keep.add(frameKey(f, p.id))); }
    else if (whoNow()) keep.add(frameKey(f, whoNow()));
  });
  return keep;
}

// What a redraw would show: when a load changes none of it (players typing
// trigger loads every few seconds), the tab row isn't rebuilt, so its scroll
// position, focus and a press on a tab survive.
function shownState() {
  return JSON.stringify([S.session, S.isHost, S.viewAs, S.me, S.players, S.files.map((f) =>
    [f.scope, f.name, f.title, f.kind, f.modified, f.tags, f.description, f.perPlayer, f.hidden, f.audience, f.allowed])]);
}
let lastShown = '';

function dropFrame(k) {
  const fr = S.frames.get(k);
  if (fr) fr.remove();
  S.frames.delete(k); S.status.delete(k); S.versions.delete(k);
}

async function load() {
  let d;
  const as = S.viewAs !== null ? '?as=' + enc(S.viewAs) : '';   // the server only honours it for the host
  try { d = await api('GET', '/api/active' + as); } catch (e) { return; }  // the event socket says when it's back
  const newId = d.session ? d.session.id : null;
  const oldId = S.session ? S.session.id : null;
  const was = S.session;
  const wasKeys = S.files.map(fileKey), wasActive = S.active;
  if (newId !== oldId) {
    Array.from(S.frames.keys()).forEach(dropFrame);
    S.session = d.session;
    loadPicks();
    S.look.clear();
    if (oldId !== null) S.active = null;
    // Full screen comes back only within the campaign it was chosen in.
    let full = '';
    try { full = localStorage.getItem(FULL_KEY) || ''; } catch (e) {}
    if (newId && full === newId && !document.body.classList.contains('mg-full')) setFull(true, false);
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
  if (!S.isHost) S.viewAs = null;
  S.players = d.players || [];
  S.me = d.me || null;
  // The open page went away (deleted, or no longer shown to this device):
  // say so, without saying why, and stay near where the player was.
  if (newId === oldId && wasActive && !S.files.some((f) => fileKey(f) === wasActive)) {
    const at = Math.max(0, wasKeys.indexOf(wasActive));
    const next = S.files[Math.min(at, S.files.length - 1)];
    S.active = next ? fileKey(next) : null;
    if (S.loaded && !tourRunning()) notice({ text: 'That page is no longer available.', icon: 'info' });
  }
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
  const now = shownState();
  if (now !== lastShown || !S.loaded) { lastShown = now; redrawWhenFree(); }
  else updateSync();
  endedJustNow = S.loaded && !newId && !!oldId ? true : newId ? false : endedJustNow;
  if (S.loaded && newId !== oldId && !tourRunning()) {
    if (newId) bootScreen(liveScreen());
    else bootScreen(endScreen(was));
  }
  S.loaded = true;
}

let wasUp = false;  // the events socket was up at the last load
let endedJustNow = false;  // the session ended while this page was open

// What the boot and shutdown screens say (fx.js types them out).
function liveScreen() {
  const n = S.files.length;
  return {
    lines: [].concat(
      [{ k: S.isHost ? 'opening the player view' : 'connecting to the referee', ok: 'OK' },
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

function render() {
  $('adminLink').hidden = !S.isHost;
  drawFilterBtn();
  drawPagesBtn();
  drawViewAs();
  renderWho();
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.tab');
  const focusKey = focused ? focused.dataset.key : null;
  const has = !!S.session && S.files.length > 0;
  $('stage').hidden = !has;
  $('empty').hidden = has;
  $('sessionName').textContent = S.session ? S.session.name : 'nothing live';
  $('sessionGame').innerHTML = S.session ? gameTag(S.session.gameType) : '';
  document.title = S.session ? S.session.name + ' · MotherGoose' : 'MotherGoose';

  if (!S.session) {
    $('emptyEyebrow').textContent = 'waiting';
    $('emptyTitle').textContent = endedJustNow ? 'Session ended.' : 'Nothing is live yet.';
    $('emptyText').textContent = endedJustNow
      ? 'Your entries are saved. This page wakes up by itself when the referee starts the next session.'
      : 'Keep this page open. It will update by itself when the referee starts the session.';
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
    const look = S.look.has(fileKey(f));
    const mark = look ? 'look' : S.isHost ? '' : seenState(f);
    if (mark) b.title += '\n' + (mark === 'look' ? 'The referee asked you to look at this.' : mark === 'new' ? 'New: you haven\'t opened it yet.' : 'Updated since you last opened it.');
    if (S.isHost && (isHidden(f) || isOnly(f))) {
      b.title += '\n' + (isHidden(f) ? 'Hidden from players. ' : '') + 'Shown to ' + audienceText(f, S.players) + '.';
      if (isHidden(f)) b.classList.add('hid');
    }
    const title = titleOf(f);
    // Shrunk tabs show the start of the name, less a leading article, so
    // "The Map" and "The Letter" don't both read "The".
    const short = title.replace(/^(the|a|an)\s+/i, '');
    b.innerHTML = (i < 9 ? '<span class="n" aria-hidden="true">' + (i + 1) + '</span>' : '') +
      (f.kind !== 'html' ? ic('kind-' + f.kind) : '') +
      (f.perPlayer ? ic('player', 'per') : '') +
      (S.isHost && isHidden(f) ? ic('hidden', 'vis') : S.isHost && isOnly(f) ? ic('only', 'vis') : '') +
      '<span class="t">' + esc(title) + '</span><span class="ts" aria-hidden="true">' + esc(short) + '</span>' +
      (S.isHost && isOnly(f) ? '<span class="aud">' + esc(audienceText(f, S.players)) + '</span>' : '') +
      (mark ? '<span class="seen ' + mark + '" aria-hidden="true">' + (mark === 'look' ? 'look' : mark === 'new' ? 'new' : '') + '</span>' : '') +
      '<span class="mg-vh">' + esc(tabWords(f, mark)) + '</span>';
    tabs.appendChild(b);
  });

  if (!has) { S.active = null; S.shown = null; updateSync(); return; }
  let want = S.active;
  if (!want || !S.files.some((f) => fileKey(f) === want)) {
    const fromHash = decodeURIComponent(location.hash.slice(1));
    want = S.files.some((f) => fileKey(f) === fromHash) ? fromHash : fileKey(S.files[0]);
  }
  show(want, false);
  if (focusKey) { const t = document.querySelector('.tab[data-key="' + CSS.escape(focusKey) + '"]'); if (t) t.focus(); }
}

// tabWords is what a screen reader hears after a tab's name: its kind and
// marks, which sighted players get from icons.
function tabWords(f, mark) {
  const w = [];
  if (f.kind !== 'html') w.push(KIND_NAME[f.kind]);
  if (f.perPlayer) w.push(S.isHost && !previewing() ? 'per player' : 'your own copy');
  if (S.isHost && isHidden(f)) w.push('hidden from players');
  if (S.isHost && isOnly(f)) w.push('shown to ' + audienceText(f, S.players));
  if (f.scope === 'gm') w.push('referee page');
  if (mark === 'new') w.push('new'); else if (mark === 'updated') w.push('updated'); else if (mark === 'look') w.push('the referee asked you to look');
  return w.length ? ', ' + w.join(', ') : '';
}

// ---- the pages button, and the referee's "view as" ---------------------------------

function drawPagesBtn() {
  const b = $('pagesBtn');
  b.hidden = !S.files.length;
  b.innerHTML = withIcon('pages', 'pages') + '<span class="count">' + S.files.length + '</span>';
}

const viewAsLabel = () => !previewing() ? 'referee view' : S.viewAs ? 'as ' + playerName(S.players, S.viewAs) : 'as a player with no name';
function drawViewAs() {
  const b = $('viewAsBtn');
  b.hidden = !S.isHost || !S.session;
  b.innerHTML = withIcon('view', viewAsLabel());
  b.classList.toggle('on', previewing());
  const strip = $('previewStrip');
  strip.hidden = !previewing() || !S.session;
  if (!strip.hidden) {
    strip.innerHTML = ic('view') + '<span>Previewing <b></b>: exactly what that device shows. Typing here still saves.</span>' +
      '<button type="button" class="mg-btn small" data-stop-preview>' + withIcon('close', 'back to the referee view') + '</button>';
    strip.querySelector('b').textContent = S.viewAs ? playerName(S.players, S.viewAs) + '\'s device' : 'a device with no name picked';
  }
}
function setViewAs(v) {
  S.viewAs = v;
  try { if (v === null) sessionStorage.removeItem(VIEW_AS_KEY); else sessionStorage.setItem(VIEW_AS_KEY, v); } catch (e) {}
  Array.from(S.frames.keys()).forEach(dropFrame);   // pages open as the new viewer
  load();
}
$('viewAsBtn').addEventListener('click', () => popMenu($('viewAsBtn'), [
  { label: 'referee view (everything)', icon: 'referee', run: () => setViewAs(null) },
  '-',
  ...S.players.map((p) => ({ label: 'as ' + p.name, icon: 'player', run: () => setViewAs(p.id) })),
  { label: 'as a player with no name', icon: 'player', run: () => setViewAs('') }
], { label: 'View as' }));
$('previewStrip').addEventListener('click', (e) => { if (e.target.closest('[data-stop-preview]')) setViewAs(null); });

function show(key, focusTab) {
  const f = S.files.find((x) => fileKey(x) === key);
  if (!f) return;
  S.active = key;
  try { history.replaceState(null, '', '#' + encodeURIComponent(key)); } catch (e) {}
  const who = copyFor(f);
  renderPick(f, who);
  const fk = who === null ? null : frameKey(f, who);
  // A PDF viewer is heavy: on the host, a per-player PDF keeps one frame,
  // for the copy picked now, rather than one per player. (Pages are light,
  // and keeping theirs keeps each copy's scroll position.)
  if (fk && f.kind === 'pdf' && f.perPlayer) {
    Array.from(S.frames.keys()).forEach((k) => { if (k !== fk && k.startsWith(fileKey(f) + '#')) dropFrame(k); });
  }
  if (fk && !S.frames.has(fk)) {
    const fr = document.createElement('iframe');
    fr.src = viewUrl(S.session.id, f, !isPage(f) ? f.modified : '', who, S.isHost && !previewing());
    fr.title = titleOf(f) + (who ? ': ' + playerName(S.players, who) : f.perPlayer ? ': starting copy' : '');
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
  const changedTab = S.shown !== fk;
  S.shown = fk;
  dismissNotice(key);
  if (S.look.delete(key)) { const m = document.querySelector('.tab[data-key="' + CSS.escape(key) + '"] .seen.look'); if (m) m.remove(); }
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
    if (changedTab || focusTab) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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

// What the connection button says. Players see words (the port means
// nothing to them); the referee sees LIVE:<port>. Before anything is live
// it reads "waiting", not a green LIVE.
const STATUS_TEXT = { live: 'connected', static: 'connected', waiting: 'waiting', connecting: 'connecting', offline: 'offline', closed: 'closed', down: 'offline' };
const STATUS_HINT = {
  live: 'Connected: what you type is saved and shared', static: 'Connected',
  waiting: 'Connected, waiting for the referee to start the session',
  connecting: 'Connecting…', offline: 'Offline: your changes are kept and sent when you\'re back',
  closed: 'This page was closed: what you type here isn\'t saved',
  down: 'Can\'t reach the referee\'s computer: check you\'re on the same Wi-Fi. Your changes are kept and sent when you\'re back'
};

function syncState() {
  if (!S.serverUp) return 'down';
  if (!S.session) return 'waiting';
  if (!S.shown) return 'live';   // nothing open that syncs
  return S.status.get(S.shown) || 'connecting';
}

let connectingTimer = 0;
function updateSync() {
  let st = syncState();
  // "connecting" only shows when it takes a while, so opening a tab doesn't flash amber.
  clearTimeout(connectingTimer);
  if (st === 'connecting') {
    connectingTimer = setTimeout(() => { if (syncState() === 'connecting') drawSync('connecting'); }, 800);
    if (!$('syncBtn').classList.contains('mg-state')) st = 'live';
  }
  drawSync(st);
  markTabs();
}

// markTabs puts a "!" on tabs whose page has lost its connection while the
// server is still there (one page's socket dropped): what's typed there is
// kept and sent once it reconnects. When the server is gone, the status
// says so for every page at once instead.
function markTabs() {
  document.querySelectorAll('#tabs .tab[data-key]').forEach((t) => {
    const key = t.dataset.key;
    let off = false;
    if (S.serverUp) S.status.forEach((st, k) => { if (st === 'offline' && (k === key || k.startsWith(key + '#'))) off = true; });
    let m = t.querySelector('.offmark');
    if (off && !m) {
      m = document.createElement('span');
      m.className = 'offmark';
      m.textContent = '!';
      m.title = 'Reconnecting: changes on this page are kept and sent when it\'s back';
      m.setAttribute('aria-label', 'reconnecting');
      t.appendChild(m);
    } else if (!off && m) m.remove();
  });
}
function drawSync(st) {
  const ok = st === 'live' || st === 'static';
  const btn = $('syncBtn');
  btn.classList.toggle('is-live', ok);
  btn.classList.toggle('mg-state', !ok);
  btn.classList.toggle('err', st === 'down' || st === 'closed');
  btn.classList.toggle('warn', st === 'connecting' || st === 'offline');
  $('syncLabel').textContent = ok && S.isHost ? 'LIVE:' + serverPort() : STATUS_TEXT[st] || st;
  btn.title = (STATUS_HINT[st] || st) + ' (i for details)';
  const fs = $('fullStatus');
  fs.className = 'full-status ' + (ok ? 'ok' : st === 'down' || st === 'closed' ? 'err' : 'warn');
  fs.textContent = ok ? '● connected' : '● ' + (STATUS_TEXT[st] || st);
  fs.hidden = !document.body.classList.contains('mg-full');
  announceConnection(st);
}

// Screen readers hear when the connection drops and comes back, not every flicker.
let lastAnnounced = null;
function announceConnection(st) {
  const bad = st === 'down' || st === 'offline';
  if (lastAnnounced === null) { lastAnnounced = bad; return; }
  if (bad === lastAnnounced) return;
  lastAnnounced = bad;
  const live = $('srStatus');
  if (live) live.textContent = bad ? 'Connection lost. Your changes are kept.' : 'Connected again.';
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
    ['server', S.serverUp ? liveTag() + ' <span class="mg-muted">at ' + esc(location.host) + '</span>'
      : '<span class="mg-state err">unreachable</span> <span class="mg-muted">check this device is on the same Wi-Fi as the referee\'s computer</span>'],
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
        : S.isHost ? (who ? '<b>' + esc(playerName(S.players, who)) + '</b>\'s copy' : 'the starting copy <span class="mg-muted">each player\'s copy starts from it</span>')
        : 'yours, as <b>' + esc(meName()) + '</b> <span class="mg-muted">only you and the referee see it</span>']);
    }
    rows.push(
      ['file', esc(f.name)],
      ['type', f.kind === 'html' ? 'HTML page: entries are saved and synced' : f.kind === 'md' ? 'Markdown page: ticked boxes are saved and synced'
        : f.kind === 'pdf' ? 'PDF: form fields are saved and synced' : KIND_NAME[f.kind]],
      ['size', size(f.size)],
      ['changed', esc(when(f.modified)) + ' <span class="mg-muted">(' + esc(agoText(f.modified)) + ')</span>'],
      ['sync', f.kind === 'image' ? '<span class="mg-muted">nothing to sync</span>' : !S.shown ? '<span class="mg-muted">nothing open</span>'
        : esc(STATUS_HINT[st] || st)]
    );
  }
  overlay({ title: 'Details', icon: 'info', wide: true, body: kv(rows) });
}

async function helpOverlay() {
  const keys = [
    ['f', 'full screen on / off'], ['esc', 'leave full screen'], ['1 – 9', 'jump to a tab'],
    ['[  ]', 'previous / next tab'], ['t', 'filter the tabs by tag'], ['ctrl k  /', 'jump to a page'], ['← →', 'move between tabs (when a tab has focus)'], ['i', 'details'], ['?', 'this help']
  ];
  const mouse = [
    ['drag a tab', 'put the tabs in your own order (on this device)'],
    ['right-click a tab', 'shrink it, move it, or reset the order. On a touch screen, hold the tab']
  ];
  // On a tablet the touch gestures come first; keyboard shortcuts follow,
  // for when a keyboard is attached.
  const touch = matchMedia('(pointer: coarse)').matches;
  const gestures = [
    [ic('pages') + ' pages', 'every page in a list, with search: the quickest way to find one'],
    ['tap the status', 'connection and page details'],
    ['hold a tab', 'shrink it, move it, or reset the order'],
    ['pinch', 'zoom a PDF or a picture; double-tap to zoom in a step'],
    ['tap a checklist line', 'tick its box (Markdown pages)']
  ];
  const keysPart = '<hr class="mg-rule"><div class="mg-section-label">Keyboard shortcuts' + (touch ? ' (with a keyboard)' : '') + '</div>' + keysList(keys) + SHORTCUTS_NOTE;
  const v = await overlay({
    title: 'Help',
    icon: 'help',
    body: '<p><b>New here?</b> The <b>player tutorial</b> walks you through every part of this screen, one step at a time.</p>' +
      (touch ? '<hr class="mg-rule"><div class="mg-section-label">Touch</div>' + kv(gestures) + keysPart
        : keysPart + '<hr class="mg-rule"><div class="mg-section-label">Tabs</div>' + kv(mouse)),
    actions: [{ label: 'player tutorial', value: 'tour', kind: 'primary', icon: 'tutorial' }]
  });
  if (v === 'tour') tutorial();
}


$('sessionBtn').addEventListener('click', detailsOverlay);
$('syncBtn').addEventListener('click', detailsOverlay);
$('helpBtn').addEventListener('click', helpOverlay);
$('whoBtn').addEventListener('click', attempt(pickName));
$('filterBtn').addEventListener('click', filterOverlay);
$('pagesBtn').addEventListener('click', () => jump());

// ---- full screen ------------------------------------------------------------------
// Collapses the app UI to the tab strip, and also asks the browser for real
// full screen where it's supported (not on iPhone). Leaving browser full
// screen with the browser's own controls leaves our mode too.

let ownFullscreen = false;
const root = document.documentElement;
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;

function setFull(on, browserToo = true) {
  document.body.classList.toggle('mg-full', on);
  try { localStorage.setItem(FULL_KEY, on && S.session ? S.session.id : ''); } catch (e) {}
  $('fullStatus').hidden = !on;
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

// The collapsed layout comes back in load(), for the campaign it was chosen
// in (browser full screen needs a click, so not that).
$('fullBtn').innerHTML = withIcon('full', 'full screen');

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
app.dropFrames = (which) => Array.from(S.frames.keys()).filter((k) => !which || which(k)).forEach(dropFrame);
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
