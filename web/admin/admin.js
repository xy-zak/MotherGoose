// MotherGoose dashboard: the referee's view, on the host machine only. Two
// panes: the sessions list on the left, the selected session on the right.
// Details, editing and anything destructive open in overlays.
import {
  esc, enc, ago, agoText, when, size, viewUrl, KIND_NAME, toast, api, attempt,
  overlay, confirmDialog, formOverlay, anyOverlayOpen, listenEvents, isTyping,
  ic, withIcon, SCOPE, scopeTag, kindTag, gameTag, chips, parseTags, liveTag,
  filledUrl, canPerPlayer, hasEntries, perPlayerTag, playerName
} from '/_mg/ui.js';

const $ = (id) => document.getElementById(id);
const left = $('left'), right = $('right'), picker = $('picker');
let info = null;          // /api/info: port, LAN addresses, data folder
let sessions = [];        // every session (summaries with files)
let current = null;       // the selected session, or null
let selectedId = null;    // from the URL: #/s/<id>
let pickScope = 'shared';
let refreshQueued = false;

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

function welcome() {
  return '<div class="mg-panel welcome">' +
    '<div class="mg-panel-title"><span class="t">' + ic('info') + 'Getting started</span></div>' +
    '<p>Pick a session on the left, or create one. Give it a <b>game type</b>, the game or rules being played, so you can tell sessions apart.</p>' +
    '<ul>' +
      '<li><b>.html</b> pages (character sheets, handouts): anything typed into them is saved and synced live.</li>' +
      '<li><b>.pdf</b>, <b>.png</b> and <b>.jpg</b> files show rulebooks, maps and art.</li>' +
      '<li><b class="players">Players</b> pages go to every player. <b class="referee">Referee</b> pages open only on this computer.</li>' +
      '<li>Give pages a description and tags with ' + ic('info') + ' so players know what they\'re looking at.</li>' +
      '<li>Add your players to the session\'s <b class="players">party</b>, and mark character sheets <b class="players">per player</b>: each player fills in their own copy.</li>' +
      '<li>Press <b>go live</b> to put a session on the players\' screens.</li>' +
    '</ul>' +
    '<p class="mg-muted">Press <kbd>?</kbd> for keyboard shortcuts, or ' + ic('settings') + ' display to change the theme, font and icons.</p></div>';
}

function fileRow(s, f) {
  const to = other(f.scope);
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
      '<button class="mg-btn small ' + SCOPE[to].cls + '" data-act="move" data-to="' + to + '" title="Move to the ' + SCOPE[to].label + ' pages">' +
        (to === 'gm' ? withIcon('to-referee', 'to referee') : withIcon('to-players', 'to players')) + '</button>' +
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
    '<div class="drop">' + ic('upload') + ' drop <b>.html .pdf .png .jpg</b> here' + (scope === 'gm' ? ': only this computer sees them' : ': every player sees them') + '</div>' +
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
            '<a class="mg-btn players" href="/" target="_blank" rel="noopener" title="The player dashboard: what players see">' + withIcon('view', 'player view') + '</a>'
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

function helpOverlay() {
  const keys = [
    ['n', 'new session'], ['↑ ↓', 'move through the sessions list'], ['enter', 'open the highlighted session'],
    ['e', 'edit the open session'], ['u', 'add files for the players'], ['p', 'add a player to the party'], ['j', 'Join Info: address and QR code'],
    ['?', 'this help'], ['esc', 'close an overlay']
  ];
  overlay({ title: 'Keyboard shortcuts', icon: 'help', body: kv(keys.map((k) => ['<kbd>' + k[0] + '</kbd>', k[1]])) });
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
  else if (act === 'help') helpOverlay();
  else if (act === 'activate') {
    await api('POST', '/api/admin/sessions/' + enc(btn.dataset.id) + '/activate');
    toast('Session is live');
    refresh();
  } else if (act === 'deactivate') {
    await api('DELETE', '/api/admin/active');
    toast('Session ended. Players are back on the waiting screen.');
    refresh();
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
  } else if (act === 'move') {
    await move(row.dataset.scope, row.dataset.name, btn.dataset.to);
  } else if (act === 'file-info') {
    await fileOverlay(row.dataset.scope, row.dataset.name);
  } else if (act === 'rename-player') {
    await renamePlayer(btn.dataset.id);
  } else if (act === 'remove-player') {
    await removePlayer(btn.dataset.id);
  }
}));

picker.addEventListener('change', attempt(() => upload(pickScope, picker.files)));

// ---- keyboard ----------------------------------------------------------------------

document.addEventListener('keydown', attempt(async (e) => {
  if (isTyping(e) || anyOverlayOpen()) return;
  const k = e.key;
  if (k === 'n') { const i = document.querySelector('#newForm input'); if (i) i.focus(); }
  else if (k === 'j') joinOverlay();
  else if (k === '?') helpOverlay();
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

// ---- drag and drop: OS files into a panel, or file rows between panels -------------------

const MG_TYPE = 'application/x-mothergoose-file';
const panelAt = (e) => e.target.closest && e.target.closest('.files-panel');
right.addEventListener('dragstart', (e) => {
  const row = e.target.closest && e.target.closest('.file');
  if (!row) return;
  e.dataTransfer.setData(MG_TYPE, JSON.stringify({ scope: row.dataset.scope, name: row.dataset.name }));
  e.dataTransfer.effectAllowed = 'move';
});
right.addEventListener('dragover', (e) => {
  const col = panelAt(e);
  if (!col) return;
  e.preventDefault();
  document.querySelectorAll('.files-panel.drag').forEach((c) => { if (c !== col) c.classList.remove('drag'); });
  col.classList.add('drag');
});
right.addEventListener('dragleave', (e) => {
  const col = panelAt(e);
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag');
});
right.addEventListener('drop', attempt(async (e) => {
  const col = panelAt(e);
  if (!col) return;
  e.preventDefault();
  col.classList.remove('drag');
  const scope = col.dataset.scope;
  const moved = e.dataTransfer.getData(MG_TYPE);
  if (moved) {
    const f = JSON.parse(moved);
    if (f.scope !== scope) await move(f.scope, f.name, scope);
    return;
  }
  await upload(scope, e.dataTransfer.files);
}));
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
setInterval(() => { if (!document.hidden) refresh(); }, 60000); // keep "edited 2m" fresh
route();
listenEvents(refresh, setServer);
