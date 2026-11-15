// MotherGoose dashboard: the referee's view, on the host machine only. Two
// panes: the campaigns list on the left, the selected campaign on the right.
// (A campaign is stored as a "session" folder; in the UI, a session is one
// evening of play: from "go live" to "end session".)
// Details, editing and anything destructive open in overlays.
//
// This module loads the data, draws both panes and handles clicks and keys.
// The rest is in its own modules: state.js (what's loaded), overlays.js,
// pages.js (uploads and drag and drop) and tutorial.js.
import {
  $, ago, agoText, allTags, api, attempt, chips, confirmDialog, enc, hasTags, savedTags, saveList, tagToggles, toggleTag,
  aboutOverlay, campaignTitle, esc, fitBar, ic, keysList, kindTag, listenEvents, overlay,
  isHidden, perPlayerTag, SCOPE, shortcutAllowed, size, titleOf, toast, uiBtn,
  viewUrl, visTags, withIcon
} from '/_mg/ui.js';
import { A, app, fileCount, livePort, MAX_PLAYERS, playersBase } from './state.js';
import { tourRunning } from '/_mg/tour.js';
import { bootScreen, switchLinks } from '/_mg/fx.js';
import { joinOverlay, dataOverlay, editSession, sessionMenu, sessionOverlay, fileOverlay, renamePlayer, removePlayer, guideOverlay, templateOverlay } from './overlays.js';
import { drawPresence, endSession, goLive, moveBy, pointHere, rowMenu, setPresence, toggleHidden, trashed, watchJoins } from './table.js';
import { upload, enablePageDrag } from './pages.js';
import { tutorial } from './tutorial.js';
import { launch, startOverlay } from './start.js';
import { isJumpKey, quickJump } from '/_mg/jump.js';

// plural: "1 page", "3 pages".
const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

const left = $('left'), right = $('right'), picker = $('picker');

// ---- data -----------------------------------------------------------------------

function route() {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  A.selectedId = m ? decodeURIComponent(m[1]) : null;
  left.classList.remove('open');   // a campaign was picked from the folded list
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
    // A redraw keeps what was half typed in the new-campaign form, and
    // puts focus back on the same control (a campaign, or a page's button).
    const a = document.activeElement;
    const srow = a && a.closest && a.closest('.srow');
    const row = a && a.closest && a.closest('.file');
    const act = a && a.dataset && a.dataset.act;
    const nf = document.getElementById('newForm');
    const typed = nf && { name: nf.elements.name.value, gameType: nf.elements.gameType.value };
    renderLeft();
    renderRight();
    drawHead();
    watchJoins();   // the live session may have just started or ended
    const nf2 = document.getElementById('newForm');
    if (typed && nf2) { nf2.elements.name.value = typed.name; nf2.elements.gameType.value = typed.gameType; }
    if (srow) {
      const again = left.querySelector('.srow[data-id="' + CSS.escape(srow.dataset.id) + '"]');
      if (again) again.focus();
    } else if (row) {
      const r2 = right.querySelector('.file[data-scope="' + row.dataset.scope + '"][data-name="' + CSS.escape(row.dataset.name) + '"]');
      const t = r2 && (act ? r2.querySelector('[data-act="' + act + '"]') : r2);
      if (t) t.focus();
    }
  } catch (e) {
    toast(e.message, true);
  }
}
document.addEventListener('focusout', () => setTimeout(() => { if (A.refreshQueued) refresh(); }, 50));

// ---- left pane: what's live, and the campaigns list ----------------------------------

function renderLeft() {
  const rows = A.sessions.map((s) => {
    const sh = (s.files.shared || []).length, gm = (s.files.gm || []).length;
    return '<a class="srow" href="#/s/' + enc(s.id) + '" data-id="' + esc(s.id) + '"' +
      (s.id === A.selectedId ? ' aria-current="true"' : '') +
      ' title="' + esc(s.name) + (s.gameType ? ' (' + esc(s.gameType) + ')' : '') + ': ' + sh + ' for players, ' + gm + ' for the referee, edited ' + esc(agoText(s.lastEdited)) + '">' +
      '<span class="what">' + campaignTitle(s.name, s.gameType) + '</span>' +
      '<span class="meta"><span>' + plural(sh + gm, 'page') + ' · ' + esc(ago(s.lastEdited)) + '</span>' + (s.active ? livePort() : '') + '</span></a>';
  }).join('');

  const cur = A.sessions.find((s) => s.id === A.selectedId);
  left.innerHTML =
    '<div class="mg-panel list">' +
      '<div class="mg-panel-title"><span class="t">' + ic('sessions') + 'Campaigns</span><span class="side"><span class="count">' + A.sessions.length + '</span></span></div>' +
      // On medium screens the list folds up behind this, above the open campaign.
      '<button type="button" class="mg-btn list-toggle" data-act="toggle-list" aria-expanded="' + left.classList.contains('open') + '">' +
        (cur ? ic('sessions') + '<span class="lbl">' + campaignTitle(cur.name, cur.gameType) + '</span>' : withIcon('sessions', 'choose a campaign')) + '<span class="mg-muted">' + (left.classList.contains('open') ? '▴' : '▾') + '</span></button>' +
      '<form class="new-form" id="newForm">' +
        '<input class="mg-input" name="name" placeholder="new campaign name" maxlength="120" required aria-label="New campaign name" title="New campaign (n)">' +
        '<input class="mg-input game" name="gameType" placeholder="game type" maxlength="60" autocomplete="off" list="gameTypes" aria-label="Game type (optional)">' +
        '<datalist id="gameTypes">' + Array.from(new Set(A.sessions.map((x) => x.gameType).filter(Boolean))).map((g) => '<option value="' + esc(g) + '">').join('') + '</datalist>' +
        '<button class="mg-btn primary small" type="submit" title="Create campaign">' + withIcon('add', 'new') + '</button></form>' +
      '<nav class="slist" aria-label="Campaigns">' +
        (rows || '<p class="empty">No campaigns yet. Create one above, or drop a folder into the data folder\'s <code>sessions/</code>.</p>') +
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

// ---- right pane: the selected campaign -------------------------------------------------

// With no campaign open: a short pointer to the campaigns. What MotherGoose
// does is in Getting started (start.js), a popup.
function noCampaign() {
  return '<div class="mg-panel no-campaign">' +
    '<div class="mg-panel-title"><span class="t">' + ic('sessions') + 'No campaign open</span></div>' +
    '<p>Pick a campaign on the left, or type a name (and a game type) and press ' + uiBtn('add', 'new', 'primary') + ' to make one.</p>' +
    '<div class="gs-learn">' +
      '<button type="button" class="mg-btn" data-act="start" title="What MotherGoose does, and how to begin">' + withIcon('info', 'getting started') + '</button>' +
      '<button type="button" class="mg-btn" data-act="tour" title="A guided tour of this page, using an example campaign">' + withIcon('tutorial', 'referee tutorial') + '</button>' +
    '</div></div>';
}

// ---- tag filter: show only the pages with every chosen tag (this device) ------------------
const filterKey = (s) => 'mg-filter:' + s.id;
const campaignFiles = (s) => [].concat(s.files.shared || [], s.files.gm || []);
const tagFilter = (s) => savedTags(filterKey(s), campaignFiles(s));
function filterBar(s, filter) {
  const tags = allTags(campaignFiles(s));
  if (!tags.length) return '';
  return '<div class="tagfilter" role="group" aria-label="Show only pages tagged">' +
    '<span class="tf-label">' + withIcon('filter', 'filter') + '</span>' + tagToggles(tags, filter, ' data-act="filter-tag"') +
    (filter.length ? '<span class="tf-count mg-muted mg-small" aria-live="polite">' + campaignFiles(s).filter((f) => hasTags(f, filter)).length + ' of ' + plural(campaignFiles(s).length, 'page') + '</span>' +
      '<button type="button" class="mg-btn quiet small compact" data-act="filter-clear" title="Show every page again">' + withIcon('close', 'clear filter') + '</button>' : '') +
    '</div>';
}

function fileRow(s, f, filter) {
  const vis = visTags(f, s.players);
  const players = f.scope === 'shared';
  return '<div class="file' + (isHidden(f) ? ' is-hidden' : '') + '" draggable="true" tabindex="0" data-scope="' + f.scope + '" data-name="' + esc(f.name) + '"' +
    ' aria-label="' + esc(titleOf(f)) + ' (Alt+↑/↓ to move it)"' +
    (filter && filter.length && !hasTags(f, filter) ? ' hidden' : '') + '>' +
    '<span class="kindcol">' + kindTag(f.kind) + '</span>' +
    '<div class="what"><div class="title">' + esc(titleOf(f)) + '</div>' +
      (f.description ? '<div class="desc" title="' + esc(f.description) + '">' + esc(f.description.split('\n')[0]) + '</div>' : '') +
      '<div class="sub"><span class="fname" title="' + esc(f.name) + '">' + esc(f.name) + '</span><span>·</span><span>' + size(f.size) + '</span><span>·</span>' +
      '<span>' + esc(ago(f.modified)) + '</span>' + (f.hasState && !f.perPlayer ? '<span class="mg-tag filled">filled in</span>' : '') +
'</div>' +
      (vis || f.perPlayer || (f.tags && f.tags.length)
        ? '<div class="tagline">' + vis + (f.perPlayer ? perPlayerTag() + playerChips(s, f) : '') + chips(f.tags) + '</div>'
        : '') + '</div>' +
    // Visibility is one control with its word (hide / reveal); open and info
    // stay; everything rarer is in the "⋯" menu, so titles keep their room.
    '<div class="row-actions">' +
      (players
        ? '<button class="mg-btn small vis-btn' + (isHidden(f) ? ' players' : ' quiet') + '" data-act="toggle-hidden" title="' +
            (isHidden(f) ? 'Reveal: players it\'s for see it (you get a moment to undo)' : 'Hide from every player until you reveal it') + '">' +
            withIcon(isHidden(f) ? 'view' : 'hidden', isHidden(f) ? 'reveal' : 'hide') + '</button>'
        : '') +
      '<a class="mg-btn small compact" href="' + viewUrl(s.id, f, '', '', true) + '" target="_blank" rel="noopener" title="' + (f.perPlayer ? 'Open the starting copy on its own (players\' copies are under info)' : 'Open on its own') + '">' + withIcon('open', 'open') + '</a>' +
      '<button class="mg-btn small compact" data-act="file-info" title="Info: details, who sees it, copies">' + withIcon('info', 'info') + '</button>' +
      '<button class="mg-btn small compact quiet" data-act="row-menu" aria-haspopup="menu" title="More: point here, move, clear, delete">' + withIcon('more', 'more') + '</button>' +
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

function column(s, scope, filter) {
  const files = s.files[scope] || [];
  const sc = SCOPE[scope];
  const shown = filter.length ? files.filter((f) => hasTags(f, filter)).length : files.length;
  return '<section class="mg-panel files-panel ' + sc.cls + '" data-scope="' + scope + '">' +
    '<div class="mg-panel-title"><span class="t">' + ic(sc.icon) + sc.title + '</span>' +
      '<span class="side"><span class="count"' + (shown !== files.length ? ' title="' + shown + ' of ' + files.length + ' pages match the filter"' : '') + '>' +
        (shown !== files.length ? shown + '/' : '') + files.length + '</span>' +
      '<button class="mg-btn small ' + sc.cls + '" data-act="pick" data-scope="' + scope + '" title="Add a template or a file for the ' + sc.label + (scope === 'shared' ? ' (u)' : '') + '">' + withIcon('add', 'add') + '</button></span></div>' +
    '<div class="files">' + (files.length ? files.map((f) => fileRow(s, f, filter)).join('') : '<p class="none">No pages yet: use add for a template or a file, or drop files here.</p>') +
      (files.length && !shown ? '<p class="none filtered">No pages here have ' + (filter.length > 1 ? 'all those tags' : 'that tag') + '.</p>' : '') + '</div>' +
    '<div class="drop">' + ic('upload') + ' drop <b>.html .md .pdf .png .jpg</b> here' + (scope === 'gm' ? ': only this computer sees them' : ': every player sees them') +
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
      '<span class="side"><span class="presence-sum mg-muted" hidden></span><span class="count">' + players.length + '</span></span></div></div>' +
    '<p class="mg-muted party-note">Players in this campaign only. Each player picks their name on their own device; per-player pages then show them their own copy.</p>' +
    '<div class="party-row">' +
      (players.length
        ? '<ul class="roster" aria-label="Players">' + players.map((p) =>
            '<li class="pchip compact" data-id="' + esc(p.id) + '"><button type="button" class="pname" data-act="rename-player" data-id="' + esc(p.id) + '" title="Rename ' + esc(p.name) + '">' + ic('player', 'deco') + '<span>' + esc(p.name) + '</span></button>' +
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
  if (!s) { right.innerHTML = noCampaign(); return; }
  const sh = (s.files.shared || []).length, gm = (s.files.gm || []).length;
  const filter = tagFilter(s);
  right.innerHTML =
    '<div class="mg-panel session">' +
      '<div class="mg-panel-title"><span class="t">Campaign</span>' +
        (s.active ? '<span class="side">' + livePort() + '</span>' : '') + '</div>' +
      '<div class="head-row"><h1>' + campaignTitle(s.name, s.gameType) + '</h1>' + (s.gameType ? '' : '<span class="mg-muted mg-small">no game type</span>') + '</div>' +
      '<div class="head-meta">' + sh + ' for players · ' + gm + ' for the referee · edited ' + esc(agoText(s.lastEdited)) + '</div>' +
      '<div class="actions">' +
        '<button class="mg-btn quiet" data-act="edit-session" title="Change the name or game type">' + withIcon('edit', 'edit') + '</button>' +
        '<button class="mg-btn quiet" data-act="reveal" title="Open this campaign\'s folder">' + withIcon('folder', 'open folder') + '</button>' +
        '<button class="mg-btn quiet" data-act="session-info" title="Campaign details">' + withIcon('info', 'info') + '</button>' +
        '<button class="mg-btn quiet" data-act="session-menu" aria-haspopup="menu" title="Export all, duplicate">' + withIcon('more', 'more') + '</button>' +
        '<span class="mg-grow"></span>' +
        // Going live and ending share a place: the one that applies shows.
        (s.active
          ? '<button class="mg-btn end-session" data-act="deactivate" title="End the session: players go back to a waiting screen (undo starts it again)">' + withIcon('end', 'end session') + '</button>'
          : A.sessions.some((x) => x.active)
            ? '<button class="mg-btn go-live" data-act="activate" data-id="' + esc(s.id) + '" title="Another campaign is live: end its session and start this one">' + withIcon('live', 'switch live here') + '</button>'
            : '<button class="mg-btn go-live" data-act="activate" data-id="' + esc(s.id) + '" title="Start a session: put this campaign on every player\'s screen">' + withIcon('live', 'go live') + '</button>') +
        '<span class="act-gap" aria-hidden="true"></span>' +
        '<button class="mg-btn danger" data-act="delete-session" title="Delete this campaign">' + withIcon('delete', 'delete') + '</button>' +
      '</div>' +
      party(s) +
    '</div>' +
    filterBar(s, filter) +
    '<div class="columns">' + column(s, 'shared', filter) + column(s, 'gm', filter) + '</div>';

  drawPresence();
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
    ['n', 'new campaign'], ['↑ ↓', 'move through the campaigns list'], ['enter', 'open the highlighted campaign'],
    ['e', 'edit the open campaign'], ['u', 'add pages for the players'], ['p', 'add a player to the party'], ['j', 'join info: address and QR code'],
    ['ctrl k  /', 'jump to a campaign, page, tag or player'], ['?', 'this help'], ['esc', 'close an overlay']
  ];
  const v = await overlay({
    title: 'Help', icon: 'help',
    body: '<p><b>New here?</b> The <b>referee tutorial</b> walks you through every part of this dashboard, one step at a time, using an example campaign.</p>' +
      '<p><b>Making pages?</b> <b>Making HTML pages</b> explains how to write pages whose fields save and sync. It is also an <b>AI skill</b>: give it to an AI assistant and ask for the page you want.</p>' +
      '<hr class="mg-rule"><div class="mg-section-label">Keyboard shortcuts</div>' + keysList(keys),
    actions: [{ label: 'making HTML pages', value: 'guide', kind: 'quiet', icon: 'guide' }, { label: 'referee tutorial', value: 'tour', kind: 'primary', icon: 'tutorial' }]
  });
  if (v === 'tour') tutorial();
  if (v === 'guide') guideOverlay();
}

// ---- actions -----------------------------------------------------------------------

document.addEventListener('click', attempt(async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.closest('dialog')) return;
  e.preventDefault();
  const row = btn.closest('.file');
  const act = btn.dataset.act;
  if (act === 'join') joinOverlay();
  else if (act === 'data') await dataOverlay();
  else if (act === 'help') await helpOverlay();
  else if (act === 'about') {
    // Getting started from here also turns it back on when the dashboard opens.
    if (await aboutOverlay([{ label: 'getting started', value: 'start', kind: 'quiet', icon: 'help', side: 'left' }]) === 'start') startOverlay(true);
  }
  else if (act === 'start') startOverlay(false);
  else if (act === 'tour') tutorial();
  else if (act === 'activate') {
    await goLive(btn.dataset.id, { start: startScreen });
  } else if (act === 'deactivate') {
    endSession({ end: endScreen });
  } else if (act === 'edit-session') {
    await editSession();
  } else if (act === 'reveal') {
    await api('POST', '/api/admin/sessions/' + enc(A.current.id) + '/reveal');
  } else if (act === 'session-info') {
    await sessionOverlay();
  } else if (act === 'session-menu') {
    sessionMenu(btn);
  } else if (act === 'delete-session') {
    const s = A.current, n = fileCount(s);
    if (await confirmDialog('Delete campaign', 'Delete "' + s.name + '"' + (n ? ' and its ' + n + ' page' + (n === 1 ? '' : 's') + ', with everything typed into them' : '') + '?' +
        (s.active ? ' It is live: its session ends, and players go back to the waiting screen.' : '') +
        ' It stays in the trash (in the data folder) for 30 days.', 'delete campaign')) {
      const r = await api('DELETE', '/api/admin/sessions/' + enc(s.id));
      trashed('Deleted the campaign', s.name, [r && r.trash]);
      location.hash = '#/';
    }
  } else if (act === 'guide') {
    await guideOverlay();
  } else if (act === 'pick') {
    await addChooser(btn.dataset.scope);
  } else if (act === 'file-info') {
    await fileOverlay(row.dataset.scope, row.dataset.name);
  } else if (act === 'toggle-list') {
    left.classList.toggle('open');
    renderLeft();
  } else if (act === 'filter-tag') {
    saveList(filterKey(A.current), toggleTag(tagFilter(A.current), btn.dataset.tag));
    renderRight();
  } else if (act === 'filter-clear') {
    saveList(filterKey(A.current), []);
    renderRight();
  } else if (act === 'toggle-hidden') {
    await toggleHidden(row.dataset.scope, row.dataset.name);
  } else if (act === 'show-page') {
    await pointHere(row.dataset.scope, row.dataset.name);
  } else if (act === 'row-menu') {
    rowMenu(btn, row.dataset.scope, row.dataset.name);
  } else if (act === 'rename-player') {
    await renamePlayer(btn.dataset.id);
  } else if (act === 'remove-player') {
    await removePlayer(btn.dataset.id);
  }
}));

picker.addEventListener('change', attempt(() => upload(A.pickScope, picker.files)));

// "add" asks what to add: a template (a ready-made page) or files from this
// computer. The file picker opens from the click itself, as browsers require.
async function addChooser(scope) {
  let chose = null;
  const opt = (id, icon, name, hint) => '<button type="button" class="mg-opt add-opt" data-add="' + id + '">' + ic(icon) +
    '<span class="txt"><span class="name">' + name + '</span><span class="hint">' + hint + '</span></span></button>';
  await overlay({
    title: 'Add a page for the ' + SCOPE[scope].label, icon: 'add',
    body: '<div class="mg-opts add-choice">' +
      opt('template', 'template', 'template', 'a ready-made page: character sheet, notes, tracker, turn order, clocks, party loot or a handout') +
      opt('file', 'upload', 'file', 'from this computer: .html, .md, .pdf, .png or .jpg. You can also drop files on the column.') + '</div>',
    actions: [{ label: 'cancel', value: null, kind: 'quiet', icon: 'close' }],
    onOpen: (d) => {
      d.querySelector('[data-add]').focus();
      d.addEventListener('click', (e) => {
        const o = e.target.closest('[data-add]');
        if (!o) return;
        chose = o.dataset.add;
        if (chose === 'file') { A.pickScope = scope; picker.value = ''; picker.click(); }
        d.close();
      });
    }
  });
  if (chose === 'template') await templateOverlay(scope);
}

// What the boot and shutdown screens say (fx.js types them out).
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

// Quick jump: every campaign, every page in them, and every party member.
function jump() {
  const items = [];
  A.sessions.forEach((s) => {
    const open = () => { location.hash = '#/s/' + enc(s.id); };
    items.push({ title: s.name, sub: 'campaign' + (s.gameType ? ' · ' + s.gameType : '') + (s.active ? ' · live' : ''), icon: 'sessions', text: s.id, run: open });
    ['shared', 'gm'].forEach((scope) => (s.files[scope] || []).forEach((f) => items.push({
      title: titleOf(f), sub: f.name + ' · ' + SCOPE[scope].label + ' · ' + s.name, icon: 'kind-' + f.kind, cls: SCOPE[scope].cls,
      tags: f.tags, text: f.description,
      run: async () => { await goTo(s.id); fileOverlay(scope, f.name); }
    })));
    (s.players || []).forEach((p) => items.push({
      title: p.name, sub: 'player · ' + s.name, icon: 'player', cls: 'players',
      run: async () => {
        await goTo(s.id);
        const chip = right.querySelector('[data-act="rename-player"][data-id="' + CSS.escape(p.id) + '"]');
        if (chip) { chip.focus(); chip.closest('.pchip').classList.add('flash'); setTimeout(() => chip.closest('.pchip') && chip.closest('.pchip').classList.remove('flash'), 1600); }
      }
    }));
  });
  quickJump({ items, placeholder: 'campaign, page, tag or player', title: 'Jump to' });
}
// goTo opens a campaign and waits until it's drawn.
async function goTo(id) {
  if (A.selectedId === id && A.current && A.current.id === id) return;
  location.hash = '#/s/' + enc(id);
  for (let i = 0; i < 30 && !(A.current && A.current.id === id); i++) await new Promise((r) => setTimeout(r, 50));
}

document.addEventListener('keydown', attempt(async (e) => {
  // Alt+↑/↓ on a focused page moves it: the keyboard's way to reorder.
  const row = e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target.closest && e.target.closest('.file');
  if (row && !document.querySelector('dialog[open]')) { e.preventDefault(); await moveBy(row.dataset.scope, row.dataset.name, e.key === 'ArrowUp' ? -1 : 1); return; }
  if (isJumpKey(e) && !document.querySelector('dialog[open]')) { e.preventDefault(); jump(); return; }
  if (!shortcutAllowed(e)) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); jump(); return; }
  if (k === 'n') { const i = document.querySelector('#newForm input'); if (i) i.focus(); }
  else if (k === 'j') joinOverlay();
  else if (k === '?') { await helpOverlay(); return; }
  else if (k === 'e' && A.current) { e.preventDefault(); await editSession(); return; }
  else if (k === 'u' && A.current) addChooser('shared');
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
app.render = () => { renderLeft(); renderRight(); drawHead(); };

// The header's live campaign: the same place and look as in the player view.
let fitHead = null;
function drawHead() {
  if (!fitHead) fitHead = fitBar(document.querySelector('header.mg-head'));
  const live = A.sessions.find((s) => s.active);
  const seg = $('liveSeg');
  seg.href = live ? '#/s/' + enc(live.id) : '#/';
  seg.title = live ? 'The live campaign: ' + live.name + ' (open it)' : 'No campaign is live';
  seg.innerHTML = live ? campaignTitle(live.name, live.gameType) : '<span class="label mg-muted">nothing live</span>';
  $('liveTag').hidden = !live;
  fitHead();
}
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
app.joinOverlay = joinOverlay;
// What Getting started's "learn more" buttons open.
app.tutorial = tutorial;
app.guide = guideOverlay;
app.help = helpOverlay;
launch();
listenEvents(refresh, setServer, (m) => { if (m.type === 'presence') setPresence(m); });
