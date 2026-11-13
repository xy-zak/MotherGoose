// MotherGoose dashboard: the referee's view, on the host machine only. Two
// panes: the sessions list on the left, the selected session on the right.
// Details, editing and anything destructive open in overlays.
import {
  esc, enc, ago, agoText, when, size, viewUrl, KIND_NAME, toast, api, attempt,
  overlay, confirmDialog, formOverlay, anyOverlayOpen, listenEvents, isTyping,
  ic, withIcon, SCOPE, scopeTag, kindTag, gameTag, chips, parseTags, liveTag,
  filledUrl, canPerPlayer, hasEntries, perPlayerTag, playerName, term, ftype, uiBtn
} from '/_mg/ui.js';
import { startTour, tourRunning } from '/_mg/tour.js';
import { bootScreen, switchLinks } from '/_mg/fx.js';

const $ = (id) => document.getElementById(id);
const left = $('left'), right = $('right'), picker = $('picker');
let info = null;          // /api/info: port, LAN addresses, data folder
let sessions = [];        // every session (summaries with files)
let current = null;       // the selected session, or null
let selectedId = null;    // from the URL: #/s/<id>
let pickScope = 'shared';
let refreshQueued = false;
let holdRefresh = false;  // a dragged page is being put in its place: the redraw waits

const livePort = () => liveTag(info ? String(info.port) : '');
const fileCount = (s) => (s.files.shared || []).length + (s.files.gm || []).length;
const titleOf = (f) => f.title || f.name.replace(/\.[^.]+$/, '');
const other = (scope) => (scope === 'gm' ? 'shared' : 'gm');
const fileBase = (s, scope, name) => '/api/admin/sessions/' + enc(s.id) + '/files/' + scope + '/' + enc(name);
const playersBase = (s) => '/api/admin/sessions/' + enc(s.id) + '/players';
const MAX_PLAYERS = 24;
// Who has entries in a per-player page, from the roster's point of view.
const filledCount = (s, f) => (s.players || []).filter((p) => f.playerState && f.playerState[p.id]).length;

// ---- data -----------------------------------------------------------------------

function route() {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  selectedId = m ? decodeURIComponent(m[1]) : null;
  refresh();
}

async function refresh() {
  // Don't pull the rug out from under someone typing. (The add-player field
  // is kept as it was across a refresh, so it doesn't need to wait.)
  const a = document.activeElement;
  if (a && a.matches('input:not([type=file]), textarea') && !a.closest('#addPlayer')) {
    refreshQueued = true;
    return;
  }
  // The tutorial shows an example session: live updates wait until it's over.
  if (tourRunning() || holdRefresh) { refreshQueued = true; return; }
  refreshQueued = false;
  try {
    if (!info) info = await api('GET', '/api/info');
    const [list, sess] = await Promise.all([
      api('GET', '/api/admin/sessions'),
      selectedId ? api('GET', '/api/admin/sessions/' + enc(selectedId)).catch(() => null) : null
    ]);
    sessions = list;
    current = sess;
    if (selectedId && !sess) { location.hash = '#/'; return; } // deleted elsewhere
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
document.addEventListener('focusout', () => setTimeout(() => { if (refreshQueued) refresh(); }, 50));

// ---- left pane: what's live, and the sessions list ----------------------------------

function renderLeft() {
  const live = sessions.find((s) => s.active);
  const rows = sessions.map((s) => {
    const sh = (s.files.shared || []).length, gm = (s.files.gm || []).length;
    return '<a class="srow" href="#/s/' + enc(s.id) + '" data-id="' + esc(s.id) + '"' +
      (s.id === selectedId ? ' aria-current="true"' : '') +
      ' title="' + esc(s.name) + (s.gameType ? ' (' + esc(s.gameType) + ')' : '') + ': ' + sh + ' for players, ' + gm + ' for the referee, edited ' + esc(agoText(s.lastEdited)) + '">' +
      '<span class="what"><span class="name">' + esc(s.name) + '</span>' + gameTag(s.gameType) + '</span>' +
      '<span class="meta"><span>' + sh + '·' + gm + ' · ' + esc(ago(s.lastEdited)) + '</span>' + (s.active ? livePort() : '') + '</span></a>';
  }).join('');

  left.innerHTML =
    '<div class="mg-panel">' +
      '<div class="mg-panel-title"><span class="t">' + ic('server') + 'Running</span>' +
        (live ? '<span class="side">' + livePort() + '</span>' : '') + '</div>' +
      (live
        ? '<div class="head-row"><a href="#/s/' + enc(live.id) + '"><b>' + esc(live.name) + '</b></a>' + gameTag(live.gameType) + '</div>' +
          '<div class="actions"><button class="mg-btn warn small" data-act="deactivate" title="End the live session">' + withIcon('end', 'end session') + '</button>' +
          '<button class="mg-btn quiet small" data-act="join" title="Address and QR code for players">' + withIcon('join', 'Join Info') + '</button></div>'
        : '<p class="mg-muted">Nothing is running. Players see a waiting screen.</p>') +
    '</div>' +
    '<div class="mg-panel list">' +
      '<div class="mg-panel-title"><span class="t">' + ic('sessions') + 'Sessions</span><span class="side"><span class="count">' + sessions.length + '</span></span></div>' +
      '<form class="new-form" id="newForm">' +
        '<input class="mg-input" name="name" placeholder="new session name" maxlength="120" required aria-label="New session name" title="New session (n)">' +
        '<input class="mg-input game" name="gameType" placeholder="game type" maxlength="60" autocomplete="off" aria-label="Game type (optional)">' +
        '<button class="mg-btn primary small" type="submit" title="Create session">' + withIcon('add', 'new') + '</button></form>' +
      '<nav class="slist" aria-label="Sessions">' +
        (rows || '<p class="empty">No sessions yet. Create one above, or drop a folder into the data folder\'s <code>sessions/</code>.</p>') +
      '</nav>' +
    '</div>';

  $('newForm').addEventListener('submit', attempt(async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const s = await api('POST', '/api/admin/sessions', { name: f.name.value, gameType: f.gameType.value });
    e.target.reset();
    document.activeElement.blur();
    location.hash = '#/s/' + enc(s.id);
  }));
}

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
      feat('live', 'Go live', uiBtn('live', 'go live', 'go-live') + ' puts a session on the players\' screens; ' + uiBtn('end', 'end session', 'warn') + ' takes it off again.') +
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

// The session's roster. Players pick their name from it on their own device;
// per-player pages give each of them their own copy.
function party(s) {
  const players = s.players || [];
  const full = players.length >= MAX_PLAYERS;
  return '<section class="mg-panel players party">' +
    '<div class="mg-panel-title"><span class="t">' + ic('players') + 'Party</span>' +
      '<span class="side"><span class="count">' + players.length + '</span></span></div>' +
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
  const s = current;
  // A name half typed into the add-player field survives the redraw.
  const was = document.querySelector('#addPlayer input');
  const typed = was && { value: was.value, focus: was === document.activeElement, at: was.selectionStart };
  if (!s) { right.innerHTML = welcome(); return; }
  const sh = (s.files.shared || []).length, gm = (s.files.gm || []).length;
  right.innerHTML =
    '<div class="mg-panel">' +
      '<div class="mg-panel-title"><span class="t">Session</span>' +
        (s.active ? '<span class="side">' + livePort() + '</span>' : '') + '</div>' +
      '<div class="head-row"><h1>' + esc(s.name) + '</h1>' + (s.gameType ? gameTag(s.gameType) : '<span class="mg-muted" style="font-size: var(--fs-small)">no game type</span>') + '</div>' +
      '<div class="head-meta">' + sh + ' for players · ' + gm + ' for the referee · edited ' + esc(agoText(s.lastEdited)) + '</div>' +
      '<div class="actions">' +
        (s.active
          ? '<button class="mg-btn warn" data-act="deactivate">' + withIcon('end', 'end session') + '</button>' +
            '<a class="mg-btn players" href="/" target="_blank" rel="noopener" data-switch="players" title="The player dashboard: what players see">' + withIcon('view', 'player view') + '</a>'
          : '<button class="mg-btn go-live" data-act="activate" data-id="' + esc(s.id) + '">' + withIcon('live', 'go live') + '</button>') +
        '<span class="sep"></span>' +
        '<button class="mg-btn quiet" data-act="edit-session" title="Change the name or game type">' + withIcon('edit', 'edit') + '</button>' +
        '<button class="mg-btn quiet" data-act="reveal" title="Open this session\'s folder">' + withIcon('folder', 'open folder') + '</button>' +
        '<button class="mg-btn quiet" data-act="session-info" title="Session details">' + withIcon('info', 'info') + '</button>' +
        '<span class="mg-grow"></span>' +
        '<button class="mg-btn danger" data-act="delete-session" title="Delete this session">' + withIcon('delete', 'delete') + '</button>' +
      '</div>' +
    '</div>' +
    party(s) +
    '<div class="columns">' + column(s, 'shared') + column(s, 'gm') + '</div>';

  const input = document.querySelector('#addPlayer input');
  if (typed && !input.disabled) {
    input.value = typed.value;
    if (typed.focus) { input.focus(); try { input.setSelectionRange(typed.at, typed.at); } catch (e) {} }
  }
  $('addPlayer').addEventListener('submit', attempt(async (e) => {
    e.preventDefault();
    const p = await api('POST', playersBase(current), { name: input.value });
    toast('Added ' + p.name + ' to the party');
    document.querySelector('#addPlayer input').value = '';  // stays focused, ready for the next name
    await refresh();
  }));
}

// ---- overlays -----------------------------------------------------------------------

const kv = (rows) => '<dl class="mg-kv">' + rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>';

function joinOverlay() {
  const urls = (info && info.urls) || [];
  const others = urls.slice(1).map((u) => '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + '</a>').join('<br>');
  const body = urls.length
    ? '<div class="mg-section-label">Players open</div>' +
      '<a class="join-url" href="' + esc(info.primary) + '" target="_blank" rel="noopener">' + esc(info.primary) + '</a>' +
      '<div class="qr"><img src="/api/qr.png" alt="QR code for ' + esc(info.primary) + '"></div>' +
      '<p class="mg-muted">Players need to be on the same Wi-Fi or network as this computer. They can scan the code with a phone camera.</p>' +
      (others ? '<hr class="mg-rule"><div class="mg-section-label">If that doesn\'t work, try</div><p>' + others + '</p>' : '')
    : '<p>No network connection found. Connect this computer to Wi-Fi or a LAN, then reload.</p>';
  overlay({ title: 'Join Info', icon: 'join', body });
}

function dataOverlay() {
  overlay({
    title: 'Data folder',
    icon: 'data',
    wide: true,
    body: kv([['location', '<code>' + esc(info ? info.dataDir : '') + '</code>']]) +
      '<pre class="tree">data/\n  config.json              which session is live\n  sessions/\n    the-sunken-keep/\n      session.json         name, game type, page descriptions and tags\n' +
      '      shared/              players\' pages\n      gm/                  referee\'s pages (this computer only)\n      state/               what people typed (managed for you)\n        players/           each player\'s copy of per-player pages</pre>' +
      '<p class="mg-muted">Copy .html, .pdf, .png or .jpg files into <code>shared/</code> (players) or <code>gm/</code> (referee) and they appear within a couple of seconds. Back up by copying the whole folder.</p>'
  });
}

async function editSession() {
  const s = current;
  const v = await formOverlay({
    title: 'Edit session', icon: 'edit',
    fields: [
      { name: 'name', label: 'Name', value: s.name, max: 120, required: true },
      { name: 'gameType', label: 'Game type', hint: 'the game or rules you\'re playing', value: s.gameType, max: 60 }
    ]
  });
  if (!v) return;
  await api('PATCH', '/api/admin/sessions/' + enc(s.id), { name: v.name, gameType: v.gameType });
  toast('Saved');
  refresh();
}

async function sessionOverlay() {
  const s = current;
  const v = await overlay({
    title: 'Session: ' + s.name,
    icon: 'info',
    wide: true,
    body: kv([
      ['name', esc(s.name)], ['game type', s.gameType ? gameTag(s.gameType) : '<span class="mg-muted">not set</span>'],
      ['id', '<code>' + esc(s.id) + '</code>'],
      ['status', s.active ? livePort() : 'not running'],
      ['pages', (s.files.shared || []).length + ' for players, ' + (s.files.gm || []).length + ' for the referee'],
      ['party', (s.players || []).length ? (s.players || []).map((p) => esc(p.name)).join(', ') : '<span class="mg-muted">no players yet</span>'],
      ['created', esc(when(s.created))], ['last edit', esc(when(s.lastEdited))],
      ['folder', '<code>' + esc(s.dir) + '</code>']
    ]),
    actions: [{ label: 'edit', value: 'edit', icon: 'edit', kind: 'quiet' }, { label: 'open folder', value: 'reveal', icon: 'folder' }]
  });
  if (v === 'reveal') await api('POST', '/api/admin/sessions/' + enc(s.id) + '/reveal');
  if (v === 'edit') await editSession();
}

// Per-player pages: the template and each player's copy, with who has
// entries and what can be done with each copy.
function copiesList(s, f) {
  const row = (who, name, note, filled) =>
    '<li class="copy' + (who ? '' : ' template') + '">' +
      '<span class="who">' + ic(who ? 'player' : 'template', 'deco') + '<b>' + esc(name) + '</b><span class="mg-muted">' + note + '</span></span>' +
      '<span class="state">' + (filled ? '<span class="mg-tag filled">filled in</span>' : '<span class="mg-muted">no entries</span>') + '</span>' +
      '<span class="acts">' +
        '<a class="mg-btn quiet small compact" href="' + viewUrl(s.id, f, '', who) + '" target="_blank" rel="noopener" title="Open ' + esc(who ? name + '\'s copy' : 'the template') + '">' + withIcon('open', 'open') + '</a>' +
        '<a class="mg-btn quiet small compact" href="' + filledUrl(s.id, f, who) + '"' + (f.kind === 'pdf' ? ' target="_blank" rel="noopener"' : ' download') +
          ' title="Export ' + esc(who ? name + '\'s copy' : 'the template') + ' filled in' + (f.kind === 'pdf' ? ' (opens the viewer, which downloads it)' : '') + '">' + withIcon('export', 'export filled') + '</a>' +
        '<button type="button" class="mg-btn quiet small compact" data-copy-reset="' + esc(who) + '"' + (filled ? '' : ' disabled') + ' title="Clear ' + esc(who ? name + '\'s entries' : 'the template\'s entries') + '">' + withIcon('reset', 'reset') + '</button>' +
      '</span></li>';
  const players = s.players || [];
  return '<div><div class="mg-section-label">' + ic('player') + ' Copies</div>' +
    '<ul class="copies">' + row('', 'template', 'starting values', f.hasState) +
      players.map((p) => row(p.id, p.name, '', !!(f.playerState && f.playerState[p.id]))).join('') + '</ul></div>' +
    (players.length ? '' : '<p class="mg-muted">No players in the party yet: add them in the PARTY panel.</p>');
}

// The info popup is where a page is edited: name, description, tags and the
// per-player switch are saved together with "save"; party changes (when the
// page is per player) apply straight away, as in the PARTY panel.
async function fileOverlay(scope, name) {
  const s = current;
  const f = (s.files[scope] || []).find((x) => x.name === name);
  if (!f) return;
  const base = fileBase(s, scope, name);
  const per = !!f.perPlayer;
  const perOk = canPerPlayer(Object.assign({}, f, { scope }));
  const dot = f.name.lastIndexOf('.');
  const stem = f.name.slice(0, dot), ext = f.name.slice(dot);

  const body = document.createElement('div');
  body.className = 'finfo';
  body.innerHTML =
    '<form class="fform" id="fform" autocomplete="off">' +
      '<label class="mg-field"><span>File name <span class="hint">the type (' + esc(ext) + ') stays the same</span></span>' +
        '<span class="fname-row"><input class="mg-input" name="stem" value="' + esc(stem) + '" maxlength="190" required aria-label="File name"><span class="ext">' + esc(ext) + '</span></span></label>' +
      '<label class="mg-field"><span>Description <span class="hint">' + (scope === 'gm' ? 'only you see this' : 'players see this') + '</span></span>' +
        '<textarea class="mg-input" name="description" maxlength="1000" placeholder="What is this page? When should players open it?">' + esc(f.description || '') + '</textarea></label>' +
      '<label class="mg-field"><span>Tags <span class="hint">separated by commas</span></span>' +
        '<input class="mg-input" name="tags" value="' + esc((f.tags || []).join(', ')) + '" placeholder="map, level 2, handout"></label>' +
      (perOk
        ? '<label class="pp-toggle"><input type="checkbox" name="perPlayer"' + (per ? ' checked' : '') + '>' +
            '<span><b>' + ic('player', 'deco') + ' Per player</b><span class="hint">Every player in the party fills in their own copy, seen only by them and you. ' +
            'Entries already in the page become each player\'s starting values. Turning it off keeps their copies for later.</span></span></label>'
        : '') +
      '<button type="submit" hidden></button>' +
    '</form>' +
    '<div class="fparty" id="fparty"' + (per ? '' : ' hidden') + '></div>' +
    '<div class="fcopies" id="fcopies"></div>' +
    '<hr class="mg-rule">' +
    kv([
      ['for', scopeTag(scope) + ' <span class="mg-muted">' + (scope === 'gm' ? 'this computer only' : per ? 'each player their own copy, when the session is live' : 'every player, when the session is live') + '</span>'],
      ['type', kindTag(f.kind) + ' ' + KIND_NAME[f.kind]],
      ['size', size(f.size)], ['changed', esc(when(f.modified)) + ' <span class="mg-muted">(' + esc(agoText(f.modified)) + ')</span>'],
      ['entries', !hasEntries(f) ? '<span class="mg-muted">not applicable</span>'
        : per ? filledCount(s, f) + ' of ' + (s.players || []).length + ' players' + (f.hasState ? ', and the template' : '')
        : f.hasState ? '<span class="mg-tag filled">filled in</span>' : 'none yet']
    ]) +
    (hasEntries(f) ? '<p class="mg-muted">Export filled downloads a copy with ' + (per ? 'that copy\'s entries' : 'every entry') + ' baked in' +
      (f.kind === 'pdf' ? ': it opens the PDF viewer, which fills in the fields and downloads the PDF.' : '. It works offline.') + '</p>' : '');

  const form = body.querySelector('#fform');
  const partyEl = body.querySelector('#fparty');
  const copiesEl = body.querySelector('#fcopies');

  // The party and each copy, redrawn after every party change.
  function drawParty() {
    const sess = current;
    const players = sess.players || [];
    const full = players.length >= MAX_PLAYERS;
    partyEl.innerHTML =
      '<div class="mg-section-label">' + ic('players') + ' Party</div>' +
      '<p class="mg-muted fnote">The party of this whole session. Adding or removing a player applies straight away.</p>' +
      '<div class="party-row">' +
        (players.length
          ? '<ul class="roster" aria-label="Players">' + players.map((p) =>
              '<li class="pchip compact"><span class="pname">' + ic('player', 'deco') + '<span>' + esc(p.name) + '</span></span>' +
              '<button type="button" class="pdel" data-fremove="' + esc(p.id) + '" title="Remove ' + esc(p.name) + ' from the party">' + withIcon('close', 'remove') + '</button></li>').join('') + '</ul>'
          : '<span class="mg-muted">No players yet.</span>') +
        '<span class="add-player"><input class="mg-input" id="fnewp" placeholder="' + (full ? MAX_PLAYERS + ' players at most' : 'player name') + '" maxlength="40" aria-label="New player\'s name"' + (full ? ' disabled' : '') + '>' +
          '<button class="mg-btn players small" type="button" data-fadd' + (full ? ' disabled' : '') + ' title="Add this player to the party">' + withIcon('add-player', 'add') + '</button></span>' +
      '</div>';
    const live = (sess.files[scope] || []).find((x) => x.name === name) || f;
    // Copies only exist once per player is saved.
    copiesEl.innerHTML = live.perPlayer ? copiesList(sess, live) : '';
  }
  drawParty();

  async function reloadSession() {
    current = await api('GET', '/api/admin/sessions/' + enc(s.id));
    drawParty();
  }

  async function save(d) {
    const v = Object.fromEntries(new FormData(form).entries());
    const newStem = (v.stem || '').trim();
    if (!newStem) { toast('The file name can\'t be empty', true); return; }
    let target = name;
    const changed = [];
    if (newStem !== stem) {
      await api('PATCH', base, { name: newStem + ext });
      target = newStem + ext;
      changed.push('renamed to ' + target);
    }
    const metaBody = { description: v.description || '', tags: parseTags(v.tags) };
    const wantPer = perOk && !!v.perPlayer;
    if (perOk) metaBody.perPlayer = wantPer;
    await api('PUT', fileBase(s, scope, target) + '/meta', metaBody);
    if (perOk && wantPer !== per) changed.push(wantPer ? 'now per player' : 'shared again: everyone sees one copy');
    toast((changed.length ? target + ' ' + changed.join(', ') : 'Saved details for ' + target));
    d.close();
  }

  const actions = [];
  if (!per) actions.push({ label: 'open', href: viewUrl(s.id, f), kind: 'quiet', icon: 'open' });
  if (!per && hasEntries(f)) actions.push({ label: 'export filled', href: filledUrl(s.id, f), download: f.kind === 'html', icon: 'export', kind: 'quiet' });
  if (!per && f.hasState) actions.push({ label: 'reset entries', value: 'reset', kind: 'danger', icon: 'reset' });
  const to = other(scope);
  actions.push({ label: 'move to ' + SCOPE[to].label, value: 'move', kind: SCOPE[to].cls, icon: to === 'gm' ? 'to-referee' : 'to-players' });
  actions.push({ label: 'delete', value: 'delete', kind: 'danger', icon: 'delete' });
  actions.push({ label: 'save', value: 'save', kind: 'primary', icon: 'check' });

  let reset;  // a copy to reset, from the list: '' is the template
  const v = await overlay({
    title: titleOf(f),
    icon: 'info',
    wide: true,
    body,
    actions,
    onOpen: (d) => {
      const first = form.querySelector('textarea');
      if (first) first.focus();
      // Save keeps the popup open if something fails, so nothing typed is lost.
      const saveBtn = d.querySelector('.mg-dialog-foot .primary');
      saveBtn.addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        attempt(save)(d);
      }, { capture: true });
      form.addEventListener('submit', (e) => { e.preventDefault(); attempt(save)(d); });
      // Ticking per player shows the party, so players can be added before saving.
      const pp = form.querySelector('[name=perPlayer]');
      if (pp) pp.addEventListener('change', () => { partyEl.hidden = !pp.checked; });
      d.addEventListener('click', attempt(async (e) => {
        const r = e.target.closest('[data-copy-reset]');
        if (r && !r.disabled) { reset = r.dataset.copyReset; d.close(); return; }
        const rm = e.target.closest('[data-fremove]');
        if (rm) { if (await removePlayer(rm.dataset.fremove)) await reloadSession(); return; }
        if (e.target.closest('[data-fadd]')) await addFromPopup();
      }));
      d.addEventListener('keydown', attempt(async (e) => {
        if (e.key === 'Enter' && e.target.id === 'fnewp') { e.preventDefault(); await addFromPopup(); }
      }));
      async function addFromPopup() {
        const i = d.querySelector('#fnewp');
        const n = (i.value || '').trim();
        if (!n) return;
        const p = await api('POST', playersBase(s), { name: n });
        toast('Added ' + p.name + ' to the party');
        await reloadSession();
        const again = d.querySelector('#fnewp');
        if (again) again.focus();
      }
    }
  });
  if (reset !== undefined) {
    const whose = reset ? playerName(current.players, reset) + '\'s copy of "' + f.name + '"' : 'the template of "' + f.name + '"';
    if (await confirmDialog('Reset entries', 'Clear everything typed into ' + whose + '? Anyone viewing it reloads empty.' +
        (reset ? '' : ' Players\' copies are kept.'), 'clear entries')) {
      await api('DELETE', base + '/state' + (reset ? '?player=' + enc(reset) : ''));
      toast('Entries cleared');
    }
  } else if (v === 'reset' && await confirmDialog('Reset entries', 'Clear everything typed into "' + f.name + '"? Every device viewing it reloads empty.', 'clear entries')) {
    await api('DELETE', base + '/state');
    toast('Entries cleared');
  } else if (v === 'move') {
    await move(scope, name, to);
    return;
  } else if (v === 'delete' && await confirmDialog('Delete file', 'Delete "' + f.name + '"' + (per ? ' and every player\'s copy of it' : f.hasState ? ' and everything typed into it' : '') + '? This can\'t be undone.', 'delete file')) {
    await api('DELETE', base);
    toast('Deleted ' + f.name);
  }
  refresh();
}

// ---- the party -------------------------------------------------------------------------

async function renamePlayer(id) {
  const p = (current.players || []).find((x) => x.id === id);
  if (!p) return;
  const v = await formOverlay({
    title: 'Rename player', icon: 'player',
    fields: [{ name: 'name', label: 'Name', hint: 'their copies stay theirs', value: p.name, max: 40, required: true }]
  });
  if (!v || v.name.trim() === p.name) return;
  await api('PATCH', playersBase(current) + '/' + enc(id), { name: v.name });
  toast('Renamed ' + p.name + ' to ' + v.name.trim());
  refresh();
}

async function removePlayer(id) {
  const p = (current.players || []).find((x) => x.id === id);
  if (!p) return false;
  const choice = await confirmDialog('Remove player', 'Remove ' + p.name + ' from the party? Their device goes back to "who are you?" on per-player pages.', 'remove player', {
    choice: {
      label: p.name + '\'s entries',
      options: [
        { value: 'keep', label: 'keep them', hint: 'adding ' + p.name + ' again brings them back' },
        { value: 'delete', label: 'delete them', hint: 'every per-player page they filled in. This can\'t be undone.' }
      ]
    }
  });
  if (!choice) return false;
  await api('DELETE', playersBase(current) + '/' + enc(id) + (choice === 'delete' ? '?entries=delete' : ''));
  toast('Removed ' + p.name + (choice === 'delete' ? ' and their entries' : '. Their entries are kept.'));
  refresh();
  return true;
}

async function helpOverlay() {
  const keys = [
    ['n', 'new session'], ['↑ ↓', 'move through the sessions list'], ['enter', 'open the highlighted session'],
    ['e', 'edit the open session'], ['u', 'add files for the players'], ['p', 'add a player to the party'], ['j', 'Join Info: address and QR code'],
    ['?', 'this help'], ['esc', 'close an overlay']
  ];
  const v = await overlay({
    title: 'Help', icon: 'help',
    body: '<p><b>New here?</b> The <b>referee tutorial</b> walks you through every part of this dashboard, one step at a time, using an example session.</p>' +
      '<hr class="mg-rule"><div class="mg-section-label">Keyboard shortcuts</div>' + kv(keys.map((k) => ['<kbd>' + k[0] + '</kbd>', k[1]])),
    actions: [{ label: 'referee tutorial', value: 'tour', kind: 'primary', icon: 'tutorial' }]
  });
  if (v === 'tour') tutorial();
}

// ---- the tutorial ----------------------------------------------------------------------
// It tours an example session, so every part of the page is there to show
// (a per-player page, a party, both columns) whatever the real sessions hold.
// Nothing in it is saved: the real sessions come back when the tour ends.

const TOUR_ID = 'example-tour';
function exampleSession() {
  const now = new Date().toISOString();
  const minsAgo = (min) => new Date(Date.now() - min * 60000).toISOString();
  const page = (scope, name, kind, o) => Object.assign({ name, title: '', kind, scope, size: 0, modified: now, hasState: false, description: '', tags: [], perPlayer: false }, o);
  return {
    id: TOUR_ID, name: 'The Sunken Keep (example)', gameType: 'Mörk Borg', active: false,
    created: minsAgo(60 * 24 * 3), lastEdited: minsAgo(4), dir: '(an example for the tutorial: not on disk)',
    players: [{ id: 'ana', name: 'Ana' }, { id: 'ben', name: 'Ben' }, { id: 'cass', name: 'Cass' }],
    files: {
      shared: [
        page('shared', 'tavern-rumours.html', 'html', { title: 'Tavern rumours', size: 6200, modified: minsAgo(12), hasState: true,
          description: 'What the regulars at the Drowned Rat whisper about.\nOpen it when the party first reaches town.', tags: ['handout', 'town'] }),
        page('shared', 'character-sheet.html', 'html', { title: 'Character sheet', size: 18400, modified: minsAgo(4), perPlayer: true,
          playerState: { ana: true, ben: true }, description: 'Your character: stats, gear and scars.', tags: ['sheet'] }),
        page('shared', 'keep-map.png', 'image', { title: 'Map of the keep', size: 820000, modified: minsAgo(60 * 26), tags: ['map', 'level 1'] })
      ],
      gm: [
        page('gm', 'gm-notes.html', 'html', { title: 'Referee notes', size: 9100, modified: minsAgo(30), hasState: true, description: 'Secrets, timings and the drowned bell.' }),
        page('gm', 'monster-stats.pdf', 'pdf', { title: 'Monster stats', size: 2400000, modified: minsAgo(60 * 50) })
      ]
    }
  };
}

const lastDialog = () => { const all = document.querySelectorAll('dialog[open]'); return all[all.length - 1] || null; };
const field = (name) => (d) => { const el = d && d.querySelector('[name="' + name + '"]'); return el && el.closest('.mg-field'); };
const ROW = '.file[data-name="tavern-rumours.html"]';

function tourSteps() {
  const live = sessions.find((s) => s.active && s.id !== TOUR_ID);
  return [
    { section: 'Welcome', title: 'The referee\'s dashboard', text:
      '<p>This tour shows every part of this page, one at a time. Use <b>next</b> and <b>back</b> (or <kbd>←</kbd> <kbd>→</kbd>), or click the timeline at the bottom to jump.</p>' +
      '<p>To show everything, it opens an example session, <b>The Sunken Keep</b>. Nothing in it is saved, and your own sessions aren\'t touched. <kbd>esc</kbd> ends the tour.</p>' },

    { section: 'Top bar', title: 'The top bar', target: 'header.top', text:
      '<ul><li><b>MOTHERGOOSE</b>: back to the start, with no session open</li>' +
      '<li>the <b class="referee">referee\'s dashboard</b> label: this page only opens on this computer, the host</li>' +
      '<li>' + ic('join') + ' <b>Join Info</b>: the address players open (<kbd>j</kbd>)</li>' +
      '<li>' + ic('data') + ' <b>data folder</b>: where everything is kept on this computer</li>' +
      '<li>' + ic('view') + ' <b class="players">player view</b>: see exactly what players see</li>' +
      '<li>' + ic('settings') + ' <b>display</b>: theme, font and icons, for this device</li>' +
      '<li>' + ic('help') + ' <b>help</b>: shortcuts and this tutorial (<kbd>?</kbd>)</li></ul>' },
    { section: 'Top bar', title: 'Join Info', scene: 'join', target: (d) => d, text:
      '<p>Players open this address in a browser, or scan the code with a phone camera. They need to be on the same Wi-Fi or network as this computer.</p>' +
      '<p>If the first address doesn\'t work, try the others listed below it.</p>' },

    { section: 'Sessions', title: 'Running', target: '#left > .mg-panel:first-child', text: () =>
      '<p>Which session players see right now' + (live ? ': <b>' + esc(live.name) + '</b>' : '') + '. Only one session is live at a time.</p>' +
      '<p>While one is live, <b>end session</b> sends players back to a waiting screen.' +
      (live ? '' : ' Nothing is live at the moment, so players see the waiting screen.') + '</p>' },
    { section: 'Sessions', title: 'Your sessions', target: '#left > .mg-panel.list', text:
      '<p>Create a session with a name and, optionally, the <b>game type</b> (the game or rules being played). Shortcut: <kbd>n</kbd>.</p>' +
      '<p>Below is every session, newest edit first; the example is selected. <b>3·2</b> counts the pages for players · for the referee, then how long since the last edit. <kbd>↑</kbd> <kbd>↓</kbd> and <kbd>enter</kbd> open one.</p>' },

    { section: 'Session', title: 'The open session', target: '#right > .mg-panel:first-child', text:
      '<p>Its name, game type and page counts, with:</p>' +
      '<ul><li>' + ic('live') + ' <b>go live</b>: put it on every player\'s screen. While live, it becomes <b>end session</b></li>' +
      '<li>' + ic('edit') + ' <b>edit</b> the name or game type (<kbd>e</kbd>)</li>' +
      '<li>' + ic('folder') + ' <b>open folder</b> on this computer, to add files by hand</li>' +
      '<li>' + ic('info') + ' <b>info</b>: id, party, dates and where it\'s stored</li>' +
      '<li>' + ic('delete') + ' <b>delete</b> it with all its pages and entries (it asks first)</li></ul>' },

    { section: 'Party', title: 'The party', target: '.party', text:
      '<p>The players in this session. Each player picks their name from this list on their own device, and <b class="players">per player</b> pages then show them their own copy.</p>' +
      '<p>Click a name to rename it; ' + ic('close') + ' removes a player (you choose whether to keep their entries). Add players by name on the right (<kbd>p</kbd>), up to 24.</p>' },

    { section: 'Pages', title: 'Players and referee', target: '.columns', text:
      '<p><b class="players">Players</b> pages go to every player while the session is live. <b class="referee">Referee</b> pages only open on this computer.</p>' +
      '<p>Add <b>.html</b> pages (anything typed in is saved and synced live), <b>.pdf</b> files (form fields sync too) or <b>.png</b> / <b>.jpg</b> images with ' + ic('add') + ' <b>add</b> (<kbd>u</kbd>), or drop them on a column. Drag pages to reorder them, or across to change who they\'re for.</p>' },
    { section: 'Pages', title: 'A page', target: ROW, text:
      '<p>Each page is a card: type, title, description, file name, size and last change. <span class="mg-tag filled">filled in</span> means someone has typed into it.</p>' +
      '<ul><li>' + ic('open') + ' <b>open</b> it on its own, in a new tab</li>' +
      '<li>' + ic('info') + ' <b>info</b>: its details, where it is edited (next)</li></ul>' +
      '<p>Drag a card up or down to reorder the pages (players\' tabs follow), or onto the other column to change who it\'s for.</p>' },
    { section: 'Pages', title: 'A per-player page', target: '.file[data-name="character-sheet.html"] .tagline', text:
      '<p><b class="players">Per player</b>: every player fills in their own copy, seen only by them and you. Each name gets a ' + ic('check') + ' once that player has filled in their copy.</p>' },

    { section: 'Page info', title: 'Name, description, tags', scene: 'info', target: [field('stem'), field('description'), field('tags')], text:
      '<p>The <b>info</b> popup of the example\'s <b>Tavern rumours</b> handout.</p>' +
      '<ul><li><b>File name</b>: rename it; its type stays the same</li>' +
      '<li><b>Description</b>: what it is and when to open it. Players see it, unless it\'s a referee page</li>' +
      '<li><b>Tags</b>: short labels, separated by commas</li></ul>' +
      '<p>Changes are kept only when you press <b>save</b>.</p>' },
    { section: 'Page info', title: 'Per player', scene: 'info', target: '.pp-toggle', text:
      '<p>Tick it and every player in the party fills in their own copy instead of sharing one. What\'s already typed in becomes their starting values; turning it off later keeps their copies.</p>' +
      '<p class="mg-muted">Only players\' HTML and PDF pages can be per player.</p>' },
    { section: 'Page info', title: 'Details and actions', scene: 'info', target: ['.finfo > .mg-kv', '.mg-dialog-foot'], text:
      '<p>Who it\'s for, type, size, last change and entries. Then:</p>' +
      '<ul><li>' + ic('export') + ' <b>export filled</b>: a copy with every entry baked in, which works offline</li>' +
      '<li>' + ic('to-referee') + ' <b>move to referee</b> / <b>players</b>: the same as dragging it onto the other column</li>' +
      '<li>' + ic('reset') + ' <b>reset entries</b> or ' + ic('delete') + ' <b>delete</b> the page (both ask first)</li>' +
      '<li>' + ic('check') + ' <b>save</b> your changes</li></ul>' },

    { section: 'Per-player copies', title: 'Party and copies', scene: 'sheet', target: ['#fparty', '#fcopies'], text:
      '<p>A per-player page\'s popup (the example\'s <b>Character sheet</b>) also shows the party, to add or remove players straight away.</p>' +
      '<p>Then every copy: the <b>template</b> holds each new copy\'s starting values, then each player\'s own. For each: ' + ic('open') + ' <b>open</b>, ' + ic('export') + ' <b>export filled</b> or ' + ic('reset') + ' <b>reset</b>.</p>' },

    { section: 'Done', title: 'That\'s the dashboard', target: 'header [data-act="help"]', text:
      '<p>When this tour ends, your own sessions come back. To get going: create a session, add pages and players, then press <b>go live</b>.</p>' +
      '<p>Run it again any time: ' + ic('help') + ' <b>help</b>, then ' + ic('tutorial') + ' <b>referee tutorial</b>.</p>' }
  ];
}

function tutorial() {
  if (tourRunning()) return;
  const example = exampleSession();
  sessions = [example].concat(sessions.filter((s) => s.id !== TOUR_ID));
  current = example;
  selectedId = TOUR_ID;
  renderLeft();
  renderRight();
  startTour({
    name: 'Referee tutorial',
    steps: tourSteps(),
    scenes: {
      join: { label: 'Join Info', from: 'header [data-act="join"]', open: () => { joinOverlay(); return lastDialog(); } },
      info: { label: 'Tavern rumours, info', from: ROW + ' [data-act="file-info"]', open: () => { fileOverlay('shared', 'tavern-rumours.html'); return lastDialog(); } },
      sheet: { label: 'Character sheet, info', from: '.file[data-name="character-sheet.html"] [data-act="file-info"]',
        open: () => { fileOverlay('shared', 'character-sheet.html'); return lastDialog(); } }
    },
    onEnd: route   // back to the session in the address, with fresh data
  });
}

// ---- actions -----------------------------------------------------------------------

async function upload(scope, files) {
  const list = Array.from(files || []);
  if (!list.length || !current) return;
  const fd = new FormData();
  fd.append('scope', scope);
  list.forEach((f) => fd.append('files', f, f.name));
  const res = await api('POST', '/api/admin/sessions/' + enc(current.id) + '/files', fd);
  let msg = res.saved.length ? 'Added ' + res.saved.length + ' file' + (res.saved.length === 1 ? '' : 's') + ' for the ' + SCOPE[scope].label : '';
  if (res.errors && res.errors.length) msg += (msg ? '. ' : '') + 'Skipped: ' + res.errors.join('; ');
  toast(msg, !res.saved.length);
  refresh();
}

async function move(scope, name, to) {
  await api('PATCH', fileBase(current, scope, name), { scope: to });
  toast('Moved ' + name + ' to the ' + SCOPE[to].label);
  refresh();
}

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
    const s = sessions.find((x) => x.id === btn.dataset.id) || current;
    const was = sessions.find((x) => x.active && x.id !== s.id);
    await api('POST', '/api/admin/sessions/' + enc(btn.dataset.id) + '/activate');
    refresh();
    await bootScreen(startScreen(s, was));
    toast('Session is live');
  } else if (act === 'deactivate') {
    const s = sessions.find((x) => x.active);
    await api('DELETE', '/api/admin/active');
    refresh();
    if (s) await bootScreen(endScreen(s));
    toast('Session ended. Players are back on the waiting screen.');
  } else if (act === 'edit-session') {
    await editSession();
  } else if (act === 'reveal') {
    await api('POST', '/api/admin/sessions/' + enc(current.id) + '/reveal');
  } else if (act === 'session-info') {
    await sessionOverlay();
  } else if (act === 'delete-session') {
    const n = fileCount(current);
    if (await confirmDialog('Delete session', 'Delete "' + current.name + '"' + (n ? ' and its ' + n + ' file' + (n === 1 ? '' : 's') + ', with everything typed into them' : '') + '? This can\'t be undone.', 'delete session')) {
      await api('DELETE', '/api/admin/sessions/' + enc(current.id));
      toast('Session deleted');
      location.hash = '#/';
    }
  } else if (act === 'pick') {
    pickScope = btn.dataset.scope;
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

picker.addEventListener('change', attempt(() => upload(pickScope, picker.files)));

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
       { k: 'broadcasting on port ' + (info ? info.port : location.port), ok: 'OK' }]),
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
  if (isTyping(e) || anyOverlayOpen()) return;
  const k = e.key;
  if (k === 'n') { const i = document.querySelector('#newForm input'); if (i) i.focus(); }
  else if (k === 'j') joinOverlay();
  else if (k === '?') { await helpOverlay(); return; }
  else if (k === 'e' && current) { e.preventDefault(); await editSession(); return; }
  else if (k === 'u' && current) { pickScope = 'shared'; picker.value = ''; picker.click(); }
  else if (k === 'p' && current) { const i = document.querySelector('#addPlayer input'); if (i && !i.disabled) i.focus(); }
  else if (k === 'ArrowDown' || k === 'ArrowUp') {
    const rows = Array.from(left.querySelectorAll('.srow'));
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement.closest ? document.activeElement.closest('.srow') : null);
    const from = at >= 0 ? at : rows.findIndex((r) => r.dataset.id === selectedId);
    const next = rows[Math.max(0, Math.min(rows.length - 1, from + (k === 'ArrowDown' ? 1 : -1)))] || rows[0];
    next.focus();
  } else return;
  e.preventDefault();
}));

// ---- drag and drop: OS files into a panel; pages up and down, or across --------------
// A page dragged within its column is put where the marker shows; dragged to
// the other column, it is moved there and put in that place. Files dropped
// from the computer are added to the column.

const MG_TYPE = 'application/x-mothergoose-file';
const panelAt = (e) => e.target.closest && e.target.closest('.files-panel');
let dragged = null;   // { scope, name, row } while a page is dragged
const isPageDrag = (e) => !!dragged || Array.from(e.dataTransfer.types || []).includes(MG_TYPE);

// Where in a column's list a drop at y lands: the index among the other pages,
// and the y (in the list's own box) to draw the marker at.
function dropSpot(col, y) {
  const list = col.querySelector('.files');
  const rows = Array.from(list.querySelectorAll('.file')).filter((r) => r !== (dragged && dragged.row));
  const top = list.getBoundingClientRect().top;
  let i = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  if (i < 0) i = rows.length;
  let at;
  if (!rows.length) at = 2;
  else if (i < rows.length) at = rows[i].getBoundingClientRect().top - top - 4;
  else at = rows[rows.length - 1].getBoundingClientRect().bottom - top + 2;
  return { index: i, rows, at, list };
}

function clearMarks() {
  document.querySelectorAll('.drop-mark').forEach((m) => m.remove());
  document.querySelectorAll('.files-panel.drag').forEach((c) => c.classList.remove('drag'));
}

right.addEventListener('dragstart', (e) => {
  const row = e.target.closest && e.target.closest('.file');
  if (!row) return;
  dragged = { scope: row.dataset.scope, name: row.dataset.name, row };
  e.dataTransfer.setData(MG_TYPE, JSON.stringify({ scope: row.dataset.scope, name: row.dataset.name }));
  e.dataTransfer.effectAllowed = 'move';
  requestAnimationFrame(() => row.classList.add('dragging'));   // after the drag image is taken
});
right.addEventListener('dragend', () => {
  if (dragged) dragged.row.classList.remove('dragging');
  dragged = null;
  clearMarks();
});
right.addEventListener('dragover', (e) => {
  const col = panelAt(e);
  if (!col) return;
  e.preventDefault();
  document.querySelectorAll('.files-panel.drag').forEach((c) => { if (c !== col) c.classList.remove('drag'); });
  document.querySelectorAll('.drop-mark').forEach((m) => { if (!col.contains(m)) m.remove(); });
  const page = isPageDrag(e);
  // The column is shaded for files from the computer and for pages coming
  // across; a page moving within its own column only gets the marker.
  col.classList.toggle('drag', !page || !dragged || dragged.scope !== col.dataset.scope);
  if (!page) return;
  e.dataTransfer.dropEffect = 'move';
  const spot = dropSpot(col, e.clientY);
  let mark = spot.list.querySelector('.drop-mark');
  if (!mark) {
    mark = document.createElement('div');
    mark.className = 'drop-mark';
    mark.setAttribute('aria-hidden', 'true');
    spot.list.appendChild(mark);
  }
  mark.style.top = spot.at + 'px';
});
right.addEventListener('dragleave', (e) => {
  const col = panelAt(e);
  if (col && !col.contains(e.relatedTarget)) {
    col.classList.remove('drag');
    col.querySelectorAll('.drop-mark').forEach((m) => m.remove());
  }
});
right.addEventListener('drop', attempt(async (e) => {
  const col = panelAt(e);
  if (!col) return;
  e.preventDefault();
  const scope = col.dataset.scope;
  const raw = e.dataTransfer.getData(MG_TYPE);
  if (!raw) { clearMarks(); await upload(scope, e.dataTransfer.files); return; }
  const f = JSON.parse(raw);
  const spot = dropSpot(col, e.clientY);
  clearMarks();
  const names = spot.rows.map((r) => r.dataset.name);
  names.splice(spot.index, 0, f.name);
  const before = Array.from(col.querySelectorAll('.file')).map((r) => r.dataset.name);
  if (f.scope === scope && names.join('/') === before.join('/')) return;   // put back where it was
  await placePage(f.scope, f.name, scope, names, spot);
}));

// Moves (if need be) and orders a dropped page. The row goes to its new place
// at once; the redraw waits until the server has both changes.
async function placePage(fromScope, name, scope, names, spot) {
  const row = right.querySelector('.file[data-scope="' + fromScope + '"][data-name="' + CSS.escape(name) + '"]');
  if (row) {
    const none = spot.list.querySelector('.none');
    if (none) none.remove();
    spot.list.insertBefore(row, spot.rows[spot.index] || null);
    row.dataset.scope = scope;
  }
  holdRefresh = true;
  try {
    if (fromScope !== scope) {
      await api('PATCH', fileBase(current, fromScope, name), { scope });
      toast('Moved ' + name + ' to the ' + SCOPE[scope].label);
    }
    await api('PUT', '/api/admin/sessions/' + enc(current.id) + '/order', { scope, names });
  } finally {
    holdRefresh = false;
    refresh();
  }
}

// Dropping a file outside a panel shouldn't navigate away from the dashboard.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---- live updates ------------------------------------------------------------------------

// The header only speaks up when something is wrong: LIVE is shown in the
// RUNNING and SESSION panels already.
function setServer(up) {
  const el = $('serverState');
  el.hidden = up;
  el.title = 'Can\'t reach the server. Is MotherGoose still running?';
}

window.addEventListener('hashchange', route);
switchLinks();
setInterval(() => { if (!document.hidden) refresh(); }, 60000); // keep "edited 2m" fresh
route();
listenEvents(refresh, setServer);
