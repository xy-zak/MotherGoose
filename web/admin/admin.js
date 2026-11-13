// MotherGoose dashboard: the referee's view, on the host machine only. Two
// panes: the sessions list on the left, the selected session on the right.
// Details, editing and anything destructive open in overlays.
//
// This module loads the data, draws both panes and handles clicks and keys.
// The rest is in its own modules: state.js (what's loaded), overlays.js,
// pages.js (uploads and drag and drop) and tutorial.js.
import {
  $, ago, agoText, api, attempt, chips, confirmDialog, enc,
  esc, ftype, gameTag, ic, keysList, kindTag, listenEvents, overlay,
  perPlayerTag, SCOPE, shortcutAllowed, size, term, titleOf, toast, uiBtn,
  viewUrl, withIcon
} from '/_mg/ui.js';
import { A, app, fileCount, livePort, MAX_PLAYERS, playersBase } from './state.js';
import { tourRunning } from '/_mg/tour.js';
import { bootScreen, switchLinks } from '/_mg/fx.js';
import { joinOverlay, dataOverlay, editSession, sessionOverlay, fileOverlay, renamePlayer, removePlayer } from './overlays.js';
import { upload, enablePageDrag } from './pages.js';
import { tutorial } from './tutorial.js';

const left = $('left'), right = $('right'), picker = $('picker');

// ---- data -----------------------------------------------------------------------

function route() {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  A.selectedId = m ? decodeURIComponent(m[1]) : null;
  refresh();
}

async function refresh() {
  // Don't pull the rug out from under someone typing. (The add-player field
  // is kept as it was across a refresh, so it doesn't need to wait.)
  const a = document.activeElement;
  if (a && a.matches('input:not([type=file]), textarea') && !a.closest('#addPlayer')) {
    A.refreshQueued = true;
    return;
  }
  // The tutorial shows an example session: live updates wait until it's over.
  if (tourRunning() || A.holdRefresh) { A.refreshQueued = true; return; }
  A.refreshQueued = false;
  try {
    if (!A.info) A.info = await api('GET', '/api/info');
    const [list, sess] = await Promise.all([
      api('GET', '/api/admin/sessions'),
      A.selectedId ? api('GET', '/api/admin/sessions/' + enc(A.selectedId)).catch(() => null) : null
    ]);
    A.sessions = list;
    A.current = sess;
    if (A.selectedId && !sess) { location.hash = '#/'; return; } // deleted elsewhere
    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.srow');
    renderLeft();
    renderRight();
    if (focused) {
      const again = left.querySelector('.srow[data-id="' + CSS.escape(focused.dataset.id) + '"]');
      if (again) again.focus();
    }
  } catch (e) {
    toast(e.message, true);
  }
}
document.addEventListener('focusout', () => setTimeout(() => { if (A.refreshQueued) refresh(); }, 50));

// ---- left pane: what's live, and the sessions list ----------------------------------

function renderLeft() {
  const rows = A.sessions.map((s) => {
    const sh = (s.files.shared || []).length, gm = (s.files.gm || []).length;
    return '<a class="srow" href="#/s/' + enc(s.id) + '" data-id="' + esc(s.id) + '"' +
      (s.id === A.selectedId ? ' aria-current="true"' : '') +
      ' title="' + esc(s.name) + (s.gameType ? ' (' + esc(s.gameType) + ')' : '') + ': ' + sh + ' for players, ' + gm + ' for the referee, edited ' + esc(agoText(s.lastEdited)) + '">' +
      '<span class="what"><span class="name">' + esc(s.name) + '</span>' + gameTag(s.gameType) + '</span>' +
      '<span class="meta"><span>' + sh + '·' + gm + ' · ' + esc(ago(s.lastEdited)) + '</span>' + (s.active ? livePort() : '') + '</span></a>';
  }).join('');

  left.innerHTML =
    '<div class="mg-panel list">' +
      '<div class="mg-panel-title"><span class="t">' + ic('sessions') + 'Sessions</span><span class="side"><span class="count">' + A.sessions.length + '</span></span></div>' +
      '<form class="new-form" id="newForm">' +
        '<input class="mg-input" name="name" placeholder="new session name" maxlength="120" required aria-label="New session name" title="New session (n)">' +
        '<input class="mg-input game" name="gameType" placeholder="game type" maxlength="60" autocomplete="off" aria-label="Game type (optional)">' +
        '<button class="mg-btn primary small" type="submit" title="Create session">' + withIcon('add', 'new') + '</button></form>' +
      '<nav class="slist" aria-label="Sessions">' +
        (rows || '<p class="empty">No sessions yet. Create one above, or drop a folder into the data folder\'s <code>sessions/</code>.</p>') +
      '</nav>' +
    '</div>';
}

// The new-session form is redrawn with the list: listen once, on the pane.
left.addEventListener('submit', attempt(async (e) => {
  if (e.target.id !== 'newForm') return;
  e.preventDefault();
  const f = e.target.elements;
  const s = await api('POST', '/api/admin/sessions', { name: f.name.value, gameType: f.gameType.value });
  e.target.reset();
  document.activeElement.blur();
  location.hash = '#/s/' + enc(s.id);
}));

// ---- right pane: the selected session -------------------------------------------------

// The start page, with no session open: what MotherGoose does, one thing per
// line, and buttons to learn more. Terms, file types and buttons each have
// their own look (the key at the top says which is which).
function welcome() {
  const types = ftype('.html') + ' ' + ftype('.pdf') + ' ' + ftype('.png') + ' ' + ftype('.jpg');
  const feat = (icon, name, text) =>
    '<li><span class="gs-ic">' + ic(icon) + '</span><b class="gs-name">' + esc(name) + '</b><span class="gs-text">' + text + '</span></li>';
  const stepRow = (n, text) => '<li><span class="gs-n">' + n + '</span><span class="gs-text">' + text + '</span></li>';
  return '<div class="mg-panel welcome">' +
    '<div class="mg-panel-title"><span class="t">' + ic('info') + 'Getting started</span></div>' +
    '<p class="gs-lead">MotherGoose shares your game\'s pages with the players\' phones, tablets and laptops, over this computer\'s Wi-Fi or network. No internet or accounts needed.</p>' +
    '<p class="gs-key"><span class="mg-muted">Key:</span>' +
      '<span>' + term('term') + ' <span class="mg-muted">an idea in MotherGoose</span></span>' +
      '<span>' + ftype('.html') + ' <span class="mg-muted">a file type</span></span>' +
      '<span>' + uiBtn('live', 'button') + ' <span class="mg-muted">a button on screen</span></span></p>' +

    '<div class="mg-section-label">What you can do</div>' +
    '<ul class="gs-list">' +
      feat('sessions', 'Sessions', 'Keep one ' + term('session') + ' per game night or campaign. Give it a ' + term('game type') + ' (the game or rules being played) to tell sessions apart.') +
      feat('kind-html', 'Pages', 'Add ' + types + ' files with ' + uiBtn('add', 'add') + ', or drop them on a column.') +
      feat('check', 'Live entries', 'Anything typed into an ' + ftype('.html') + ' page, or into a ' + ftype('.pdf') + ' form, is saved and synced live to everyone viewing it.') +
      feat('players', 'Who sees what', term('Players', 'players') + ' pages go to every player. ' + term('Referee', 'referee') + ' pages only open on this computer.') +
      feat('switch', 'Order', 'Drag a page up or down to reorder it: players\' tabs follow the same order. Drag it onto the other column to change who it\'s for.') +
      feat('tag', 'Details', 'Give each page a ' + term('description') + ' and ' + term('tags') + ' with ' + uiBtn('info', 'info') + ', so players know what they\'re looking at.') +
      feat('player', 'Party', 'Add your players to the session\'s ' + term('party', 'players') + '. Mark character sheets ' + term('per player', 'players') + ': each player fills in their own copy.') +
      feat('live', 'Go live', uiBtn('live', 'go live', 'go-live') + ' puts a session on the players\' screens; ' + uiBtn('end', 'end session', 'end-session') + ' takes it off again.') +
      feat('join', 'Joining', uiBtn('join', 'Join Info') + ' shows the address and QR code players open to join.') +
      feat('export', 'Export', uiBtn('export', 'export filled') + ' downloads a page with every entry baked in, which works offline.') +
      feat('settings', 'Display', uiBtn('settings', 'display') + ' changes the theme, font, icons and animations, for this device.') +
    '</ul>' +

    '<div class="mg-section-label">Your first session</div>' +
    '<ol class="gs-list gs-steps">' +
      stepRow(1, 'Type a name, and a ' + term('game type') + ', under ' + term('Sessions') + ' on the left, then press ' + uiBtn('add', 'new', 'primary') + '.') +
      stepRow(2, 'Drop ' + types + ' files on the ' + term('Players', 'players') + ' or ' + term('Referee', 'referee') + ' column.') +
      stepRow(3, 'Add each player\'s name to the ' + term('party', 'players') + '.') +
      stepRow(4, 'Press ' + uiBtn('live', 'go live', 'go-live') + ', then show the table ' + uiBtn('join', 'Join Info') + '.') +
    '</ol>' +

    '<div class="mg-section-label">Learn more</div>' +
    '<div class="gs-learn">' +
      '<button type="button" class="mg-btn primary" data-act="tour" title="A guided tour of this page, using an example session">' + withIcon('tutorial', 'referee tutorial') + '</button>' +
      '<a class="mg-btn players" href="/?tour=1" target="_blank" rel="noopener" data-switch="players" title="Opens the player dashboard in a new tab and starts its tour">' + withIcon('tutorial', 'player tutorial') + '</a>' +
      '<button type="button" class="mg-btn" data-act="help" title="Keyboard shortcuts (?)">' + withIcon('help', 'keyboard shortcuts') + '</button>' +
      '<button type="button" class="mg-btn" data-prefs title="Theme, font, icons and animations">' + withIcon('settings', 'display settings') + '</button>' +
    '</div></div>';
}

function fileRow(s, f) {
  return '<div class="file" draggable="true" data-scope="' + f.scope + '" data-name="' + esc(f.name) + '">' +
    '<span class="kindcol">' + kindTag(f.kind) + '</span>' +
    '<div class="what"><div class="title">' + esc(titleOf(f)) + '</div>' +
      (f.description ? '<div class="desc" title="' + esc(f.description) + '">' + esc(f.description.split('\n')[0]) + '</div>' : '') +
      '<div class="sub"><span class="fname" title="' + esc(f.name) + '">' + esc(f.name) + '</span><span>·</span><span>' + size(f.size) + '</span><span>·</span>' +
      '<span>' + esc(ago(f.modified)) + '</span>' + (f.hasState && !f.perPlayer ? '<span class="mg-tag filled">filled in</span>' : '') +
'</div>' +
      (f.perPlayer || (f.tags && f.tags.length)
        ? '<div class="tagline">' + (f.perPlayer ? perPlayerTag() + playerChips(s, f) : '') + chips(f.tags) + '</div>'
        : '') + '</div>' +
    '<div class="row-actions">' +
      '<a class="mg-btn small compact" href="' + viewUrl(s.id, f) + '" target="_blank" rel="noopener" title="' + (f.perPlayer ? 'Open the template on its own (players\' copies are under info)' : 'Open on its own') + '">' + withIcon('open', 'open') + '</a>' +
      '<button class="mg-btn small compact" data-act="file-info" title="Info: rename, description, tags, per player, export, delete">' + withIcon('info', 'info') + '</button>' +
    '</div></div>';
}

// Each player in the party, named on a per-player page's row: shaded once
// they have filled in their copy.
function playerChips(s, f) {
  const players = s.players || [];
  if (!players.length) return '<span class="mg-muted pc-none">no players in the party yet</span>';
  return '<span class="pcs">' + players.map((p) => {
    const filled = !!(f.playerState && f.playerState[p.id]);
    return '<span class="pc' + (filled ? ' filled' : '') + '" title="' + esc(p.name) + (filled ? ' has filled in their copy' : ' hasn\'t filled in their copy yet') + '">' +
      ic(filled ? 'check' : 'player', 'deco') + '<span>' + esc(p.name) + '</span></span>';
  }).join('') + '</span>';
}

function column(s, scope) {
  const files = s.files[scope] || [];
  const sc = SCOPE[scope];
  return '<section class="mg-panel files-panel ' + sc.cls + '" data-scope="' + scope + '">' +
    '<div class="mg-panel-title"><span class="t">' + ic(sc.icon) + sc.title + '</span>' +
      '<span class="side"><span class="count">' + files.length + '</span>' +
      '<button class="mg-btn small ' + sc.cls + '" data-act="pick" data-scope="' + scope + '" title="Add files for the ' + sc.label + (scope === 'shared' ? ' (u)' : '') + '">' + withIcon('add', 'add') + '</button></span></div>' +
    '<div class="files">' + (files.length ? files.map((f) => fileRow(s, f)).join('') : '<p class="none">No pages yet.</p>') + '</div>' +
    '<div class="drop">' + ic('upload') + ' drop <b>.html .pdf .png .jpg</b> here' + (scope === 'gm' ? ': only this computer sees them' : ': every player sees them') +
      (files.length ? '<br><span class="mg-muted">drag pages to reorder them, or onto the other column</span>' : '') + '</div>' +
    '</section>';
}

// The session's roster, in the lower part of the session panel, below a
// rule labelled like a panel title. Players pick their name from it on their
// own device; per-player pages give each of them their own copy.
function party(s) {
  const players = s.players || [];
  const full = players.length >= MAX_PLAYERS;
  return '<section class="party" aria-label="Party">' +
    '<div class="party-divider"><div class="mg-panel-title"><span class="t">' + ic('players') + 'Party</span>' +
      '<span class="side"><span class="count">' + players.length + '</span></span></div></div>' +
    '<p class="mg-muted party-note">Players in this session only. Each player picks their name on their own device; per-player pages then show them their own copy.</p>' +
    '<div class="party-row">' +
      (players.length
        ? '<ul class="roster" aria-label="Players">' + players.map((p) =>
            '<li class="pchip compact"><button type="button" class="pname" data-act="rename-player" data-id="' + esc(p.id) + '" title="Rename ' + esc(p.name) + '">' + ic('player', 'deco') + '<span>' + esc(p.name) + '</span></button>' +
            '<button type="button" class="pdel" data-act="remove-player" data-id="' + esc(p.id) + '" title="Remove ' + esc(p.name) + ' from the party">' + withIcon('close', 'remove') + '</button></li>').join('') + '</ul>'
        : '<span class="mg-muted">No players yet.</span>') +
      '<form class="add-player" id="addPlayer">' +
        '<input class="mg-input" name="name" placeholder="' + (full ? MAX_PLAYERS + ' players at most' : 'player name') + '" maxlength="40" required aria-label="New player\'s name" title="Add a player (p)"' + (full ? ' disabled' : '') + '>' +
        '<button class="mg-btn players small" type="submit"' + (full ? ' disabled' : '') + ' title="Add this player to the party">' + withIcon('add-player', 'add') + '</button>' +
      '</form>' +
    '</div>' +
    '</section>';
}

function renderRight() {
  const s = A.current;
  // A name half typed into the add-player field survives the redraw.
  const was = document.querySelector('#addPlayer input');
  const typed = was && { value: was.value, focus: was === document.activeElement, at: was.selectionStart };
  if (!s) { right.innerHTML = welcome(); return; }
  const sh = (s.files.shared || []).length, gm = (s.files.gm || []).length;
  right.innerHTML =
    '<div class="mg-panel session">' +
      '<div class="mg-panel-title"><span class="t">Session</span>' +
        (s.active ? '<span class="side">' + livePort() + '</span>' : '') + '</div>' +
      '<div class="head-row"><h1>' + esc(s.name) + '</h1>' + (s.gameType ? gameTag(s.gameType) : '<span class="mg-muted" style="font-size: var(--fs-small)">no game type</span>') + '</div>' +
      '<div class="head-meta">' + sh + ' for players · ' + gm + ' for the referee · edited ' + esc(agoText(s.lastEdited)) + '</div>' +
      '<div class="actions">' +
        (s.active
          ? '<a class="mg-btn players" href="/" target="_blank" rel="noopener" data-switch="players" title="The player dashboard: what players see">' + withIcon('view', 'player view') + '</a>'
          : '<button class="mg-btn go-live" data-act="activate" data-id="' + esc(s.id) + '">' + withIcon('live', 'go live') + '</button>') +
        '<span class="sep"></span>' +
        '<button class="mg-btn quiet" data-act="edit-session" title="Change the name or game type">' + withIcon('edit', 'edit') + '</button>' +
        '<button class="mg-btn quiet" data-act="reveal" title="Open this session\'s folder">' + withIcon('folder', 'open folder') + '</button>' +
        '<button class="mg-btn quiet" data-act="session-info" title="Session details">' + withIcon('info', 'info') + '</button>' +
        '<span class="mg-grow"></span>' +
        (s.active ? '<button class="mg-btn end-session" data-act="deactivate" title="End the session: players go back to a waiting screen">' + withIcon('end', 'end session') + '</button>' : '') +
        '<button class="mg-btn danger" data-act="delete-session" title="Delete this session">' + withIcon('delete', 'delete') + '</button>' +
      '</div>' +
      party(s) +
    '</div>' +
    '<div class="columns">' + column(s, 'shared') + column(s, 'gm') + '</div>';

  const input = document.querySelector('#addPlayer input');
  if (typed && !input.disabled) {
    input.value = typed.value;
    if (typed.focus) { input.focus(); try { input.setSelectionRange(typed.at, typed.at); } catch (e) {} }
  }
}

right.addEventListener('submit', attempt(async (e) => {
  if (e.target.id !== 'addPlayer') return;
  e.preventDefault();
  const input = e.target.elements.name;
  const p = await api('POST', playersBase(A.current), { name: input.value });
  toast('Added ' + p.name + ' to the party');
  input.value = '';  // stays focused, ready for the next name
  await refresh();
}));
async function helpOverlay() {
  const keys = [
    ['n', 'new session'], ['↑ ↓', 'move through the sessions list'], ['enter', 'open the highlighted session'],
    ['e', 'edit the open session'], ['u', 'add files for the players'], ['p', 'add a player to the party'], ['j', 'Join Info: address and QR code'],
    ['?', 'this help'], ['esc', 'close an overlay']
  ];
  const v = await overlay({
    title: 'Help', icon: 'help',
    body: '<p><b>New here?</b> The <b>referee tutorial</b> walks you through every part of this dashboard, one step at a time, using an example session.</p>' +
      '<hr class="mg-rule"><div class="mg-section-label">Keyboard shortcuts</div>' + keysList(keys),
    actions: [{ label: 'referee tutorial', value: 'tour', kind: 'primary', icon: 'tutorial' }]
  });
  if (v === 'tour') tutorial();
}

// ---- actions -----------------------------------------------------------------------

document.addEventListener('click', attempt(async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.closest('dialog')) return;
  e.preventDefault();
  const row = btn.closest('.file');
  const act = btn.dataset.act;
  if (act === 'join') joinOverlay();
  else if (act === 'data') dataOverlay();
  else if (act === 'help') await helpOverlay();
  else if (act === 'tour') tutorial();
  else if (act === 'activate') {
    const s = A.sessions.find((x) => x.id === btn.dataset.id) || A.current;
    const was = A.sessions.find((x) => x.active && x.id !== s.id);
    await api('POST', '/api/admin/sessions/' + enc(btn.dataset.id) + '/activate');
    refresh();
    await bootScreen(startScreen(s, was));
    toast('Session is live');
  } else if (act === 'deactivate') {
    const s = A.sessions.find((x) => x.active);
    await api('DELETE', '/api/admin/active');
    refresh();
    if (s) await bootScreen(endScreen(s));
    toast('Session ended. Players are back on the waiting screen.');
  } else if (act === 'edit-session') {
    await editSession();
  } else if (act === 'reveal') {
    await api('POST', '/api/admin/sessions/' + enc(A.current.id) + '/reveal');
  } else if (act === 'session-info') {
    await sessionOverlay();
  } else if (act === 'delete-session') {
    const n = fileCount(A.current);
    if (await confirmDialog('Delete session', 'Delete "' + A.current.name + '"' + (n ? ' and its ' + n + ' file' + (n === 1 ? '' : 's') + ', with everything typed into them' : '') + '? This can\'t be undone.', 'delete session')) {
      await api('DELETE', '/api/admin/sessions/' + enc(A.current.id));
      toast('Session deleted');
      location.hash = '#/';
    }
  } else if (act === 'pick') {
    A.pickScope = btn.dataset.scope;
    picker.value = '';
    picker.click();
  } else if (act === 'file-info') {
    await fileOverlay(row.dataset.scope, row.dataset.name);
  } else if (act === 'rename-player') {
    await renamePlayer(btn.dataset.id);
  } else if (act === 'remove-player') {
    await removePlayer(btn.dataset.id);
  }
}));

picker.addEventListener('change', attempt(() => upload(A.pickScope, picker.files)));

// What the boot and shutdown screens say (fx.js types them out).
const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
function startScreen(s, was) {
  const sh = (s.files.shared || []).length, gm = (s.files.gm || []).length, np = (s.players || []).length;
  return {
    lines: [].concat(
      was ? [{ k: 'closing "' + was.name + '"', ok: 'OK' }] : [],
      [{ k: 'opening "' + s.name + '"', ok: 'OK' }],
      s.gameType ? [{ k: 'game: ' + s.gameType }] : [],
      [{ k: plural(sh, 'page') + ' for players · ' + gm + ' for the referee' },
       { k: plural(np, 'player') + ' in the party' },
       { k: 'broadcasting on port ' + (A.info ? A.info.port : location.port), ok: 'OK' }]),
    big: 'SESSION LIVE'
  };
}
function endScreen(s) {
  return {
    end: true,
    lines: [{ k: 'saving everyone\'s entries', ok: 'OK' }, { k: 'closing "' + s.name + '"', ok: 'OK' }, { k: 'players: back to the waiting screen', ok: 'OK' }],
    big: 'SESSION ENDED'
  };
}

// ---- keyboard ----------------------------------------------------------------------

document.addEventListener('keydown', attempt(async (e) => {
  if (!shortcutAllowed(e)) return;
  const k = e.key;
  if (k === 'n') { const i = document.querySelector('#newForm input'); if (i) i.focus(); }
  else if (k === 'j') joinOverlay();
  else if (k === '?') { await helpOverlay(); return; }
  else if (k === 'e' && A.current) { e.preventDefault(); await editSession(); return; }
  else if (k === 'u' && A.current) { A.pickScope = 'shared'; picker.value = ''; picker.click(); }
  else if (k === 'p' && A.current) { const i = document.querySelector('#addPlayer input'); if (i && !i.disabled) i.focus(); }
  else if (k === 'ArrowDown' || k === 'ArrowUp') {
    const rows = Array.from(left.querySelectorAll('.srow'));
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement.closest ? document.activeElement.closest('.srow') : null);
    const from = at >= 0 ? at : rows.findIndex((r) => r.dataset.id === A.selectedId);
    const next = rows[Math.max(0, Math.min(rows.length - 1, from + (k === 'ArrowDown' ? 1 : -1)))] || rows[0];
    next.focus();
  } else return;
  e.preventDefault();
}));
// ---- live updates ------------------------------------------------------------------------

// The header only speaks up when something is wrong: LIVE is shown in the
// sessions list and the SESSION panel already.
function setServer(up) {
  const el = $('serverState');
  el.hidden = up;
  el.title = 'Can\'t reach the server. Is MotherGoose still running?';
}

app.refresh = refresh;
app.render = () => { renderLeft(); renderRight(); };
app.route = route;
enablePageDrag(right);

window.addEventListener('hashchange', route);
switchLinks();
// Updates arrive as events; this only keeps "edited 2m" ticking over, and
// covers an event missed somehow.
setInterval(() => { if (!document.hidden) refresh(); }, 60000);
// The timer skips hidden tabs: catch up as soon as the referee looks again.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
route();
listenEvents(refresh, setServer);
