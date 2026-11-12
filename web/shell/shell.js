// Player view (also used by the referee on the host): one tab per page of the
// live session, each in a kept-alive iframe so switching tabs never loses
// scroll position.
//
// Per-player pages: each player picks their name from the session's roster
// (kept by a cookie the server sets) and sees their own copy. The referee
// sees the template or any player's copy, chosen in a strip above the page.
import {
  esc, agoText, size, when, viewUrl, KIND_NAME, overlay, listenEvents, isTyping, anyOverlayOpen,
  SHORTCUTS_NOTE, ic, withIcon, SCOPE, scopeTag, gameTag, chips, liveTag, serverPort,
  api, attempt, perPlayerTag, playerName, PER_PLAYER_HINT
} from '/_mg/ui.js';
import { startTour, tourRunning } from '/_mg/tour.js';

const $ = (id) => document.getElementById(id);
const S = {
  session: null, files: [], isHost: false, serverUp: false,
  players: [],         // the live session's roster: [{ id, name }]
  me: null,            // this device's player id in it, or null
  active: null,        // the open tab: fileKey
  shown: null,         // the frame on screen: frameKey, or null (the "who are you?" panel)
  pick: new Map(),     // referee only: fileKey -> whose copy is shown ('' = the template)
  frames: new Map(),   // frameKey -> iframe
  status: new Map(),   // frameKey -> sync status reported by the page or viewer
  versions: new Map()  // frameKey -> modified time the frame was loaded with (PDFs, images)
};
const FULL_KEY = 'mg-full';

const fileKey = (f) => f.scope + '/' + f.name;
// A per-player page has one frame per copy: "shared/sheet.html#ana", and
// "shared/sheet.html#" for the template.
const frameKey = (f, who) => f.perPlayer ? fileKey(f) + '#' + who : fileKey(f);
const label = (f) => f.title || f.name.replace(/\.[^.]+$/, '');
const activeFile = () => S.files.find((f) => fileKey(f) === S.active);
const meName = () => S.me ? playerName(S.players, S.me) : '';

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
  try {
    const r = await fetch('/api/active', { cache: 'no-store' });
    d = await r.json();
  } catch (e) { return; }
  const newId = d.session ? d.session.id : null;
  const oldId = S.session ? S.session.id : null;
  if (newId !== oldId) {
    Array.from(S.frames.keys()).forEach(dropFrame);
    S.pick.clear();
    if (oldId !== null) S.active = null;
  }
  S.session = d.session;
  S.files = d.files || [];
  S.isHost = !!d.isHost;
  S.players = d.players || [];
  S.me = d.me || null;
  const keep = wantedFrames();
  const live = new Map(S.files.map((f) => [fileKey(f), f]));
  Array.from(S.frames.keys()).forEach((k) => {
    if (!keep.has(k)) { dropFrame(k); return; }
    const fr = S.frames.get(k), f = live.get(fr.dataset.file);
    // The viewers aren't told when their file is replaced: reload them.
    if (f.kind !== 'html' && S.versions.get(k) !== f.modified) {
      S.versions.set(k, f.modified);
      fr.src = viewUrl(S.session.id, f, f.modified, fr.dataset.who);
    }
  });
  render();
}

// The blue "player dashboard" note says who this device is, with a way to
// change it. The referee needs no name, and an empty roster has none to pick.
function renderWho() {
  const name = S.isHost ? '' : meName();  // the host may have picked one in the past
  const ask = !S.isHost && S.players.length > 0;
  $('meName').hidden = !name;
  $('meName').innerHTML = '<span> · </span><b>' + esc(name) + '</b>';
  const b = $('whoBtn');
  b.hidden = !ask;
  b.classList.toggle('ask', !name);
  // Phones show the name in this button instead (see the page's CSS).
  b.innerHTML = name ? withIcon('switch', 'not you?') + '<span class="sm-name">' + esc(name) + '</span>' : withIcon('player', 'who are you?');
  b.title = name ? 'You are ' + name + ' on this device. Not you? Pick another name' : 'Pick your name, so per-player pages show your own copy';
}

function render() {
  $('adminLink').hidden = !S.isHost;
  renderWho();
  const has = !!S.session && S.files.length > 0;
  $('stage').hidden = !has;
  $('empty').hidden = has;
  $('sessionName').textContent = S.session ? S.session.name : 'no session';
  $('sessionGame').innerHTML = S.session ? gameTag(S.session.gameType) : '';
  document.title = S.session ? S.session.name + ' · MotherGoose' : 'MotherGoose';

  if (!S.session) {
    $('emptyEyebrow').textContent = 'waiting';
    $('emptyTitle').textContent = "The referee hasn't opened a session yet.";
    $('emptyText').textContent = 'Keep this page open. It will update by itself when the session starts.';
  } else if (!S.files.length) {
    $('emptyEyebrow').textContent = S.session.name;
    $('emptyTitle').textContent = 'No pages here yet.';
    $('emptyText').textContent = S.isHost
      ? 'Add pages to this session from the referee\'s dashboard, or drop them into its folder.'
      : 'The referee is still setting things up. Pages will appear here automatically.';
  }

  const tabs = $('tabs');
  tabs.textContent = '';
  // When both audiences are present (the referee on the host), each group of
  // tabs starts with a label in its colour.
  const grouped = S.files.some((f) => f.scope === 'gm');
  let lastScope = null;
  S.files.forEach((f, i) => {
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
    b.className = 'tab ' + SCOPE[f.scope].cls;
    b.setAttribute('role', 'tab');
    b.dataset.key = fileKey(f);
    b.title = label(f) + (f.description ? ': ' + f.description : '') + '  (' + SCOPE[f.scope].label + (i < 9 ? ', key ' + (i + 1) : '') + ')' +
      (f.perPlayer ? '\n' + PER_PLAYER_HINT + (S.isHost ? '. Pick whose copy above the page.' : '.') : '');
    b.innerHTML = (i < 9 ? '<span class="n">' + (i + 1) + '</span>' : '') +
      (f.kind !== 'html' ? ic('kind-' + f.kind) : '') +
      (f.perPlayer ? ic('player', 'per') : '') +
      '<span>' + esc(label(f)) + '</span>';
    b.addEventListener('click', () => show(fileKey(f)));
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
    fr.src = viewUrl(S.session.id, f, f.kind !== 'html' ? f.modified : '', who);
    fr.title = label(f) + (who ? ': ' + playerName(S.players, who) : f.perPlayer ? ': template' : '');
    if (f.kind !== 'html') fr.className = 'viewer';
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
  S.frames.forEach((fr, k) => { fr.hidden = k !== fk; });
  $('who').hidden = !!fk;
  if (!fk) renderAsk(f);
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.key === key;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1; // roving focus: arrow keys move within the tab list
    if (on) {
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (focusTab) b.focus();
    }
  });
  updateSync();
}

// The referee's strip above a per-player page: template · Ana · Ben …
function renderPick(f, who) {
  const el = $('pick');
  el.hidden = !(S.isHost && f.perPlayer);
  if (el.hidden) { el.textContent = ''; return; }
  const btn = (id, html, title) => '<button type="button" class="pick-btn" role="tab" data-who="' + esc(id) + '" aria-selected="' + (id === who) + '" title="' + esc(title) + '">' + html + '</button>';
  el.innerHTML = '<span class="pick-label" title="' + PER_PLAYER_HINT + '">' + withIcon('player', 'whose copy') + '</span>' +
    btn('', withIcon('template', 'template'), 'The template: its entries are the starting values for each player\'s copy') +
    S.players.map((p) => btn(p.id, '<span>' + esc(p.name) + '</span>', p.name + '\'s copy')).join('') +
    (S.players.length ? '' : '<span class="pick-note">No players yet. Add them in the referee\'s dashboard, in the PARTY panel.</span>');
}

$('pick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-who]');
  const f = activeFile();
  if (!b || !f) return;
  S.pick.set(fileKey(f), b.dataset.who);
  show(fileKey(f));
});

const rosterButtons = () => '<div class="roster">' + S.players.map((p) =>
  '<button type="button" class="mg-btn players" data-player="' + esc(p.id) + '" aria-pressed="' + (p.id === S.me) + '">' + ic('player', 'deco') + '<span>' + esc(p.name) + '</span></button>').join('') + '</div>';

// In the stage, for a player with no copy to show yet.
function renderAsk(f) {
  const none = !S.players.length;
  $('whoEyebrow').textContent = label(f);
  $('whoTitle').textContent = none ? 'The referee hasn\'t added players yet.' : 'Who are you?';
  $('whoText').textContent = none
    ? 'Each player gets their own copy of this page. It appears here once the referee adds you to the party.'
    : 'Each player fills in their own copy of this page, seen only by them and the referee. Pick your name:';
  $('whoRoster').innerHTML = none ? '' : rosterButtons() + '<p class="mg-muted">Not on the list? Ask the referee to add you.</p>';
}

const setMe = attempt(async (id) => {
  await api('POST', '/api/me', { player: id });
  await load();
});

$('whoRoster').addEventListener('click', (e) => {
  const b = e.target.closest('[data-player]');
  if (b) setMe(b.dataset.player);
});

async function pickName() {
  if (!S.players.length) return;
  const body = document.createElement('div');
  body.className = 'who-pick';
  body.innerHTML = '<p>' + (S.me ? 'This device is <b>' + esc(meName()) + '</b>. Pick another name' : 'Pick your name') +
    ' to see your own copy of per-player pages.</p>' + rosterButtons() +
    '<p class="mg-muted">Not on the list? Ask the referee to add you.</p>';
  let chosen;  // undefined: closed without a choice
  const v = await overlay({
    title: S.me ? 'Not you?' : 'Who are you?',
    icon: 'player',
    body,
    actions: S.me ? [{ label: 'forget my name', value: 'clear', kind: 'quiet', icon: 'close' }] : [],
    onOpen: (d) => {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-player]');
        if (b) { chosen = b.dataset.player; d.close(); }
      });
      const mine = body.querySelector('[aria-pressed="true"]') || body.querySelector('[data-player]');
      if (mine) mine.focus();
    }
  });
  if (v === 'clear') chosen = null;
  if (chosen !== undefined && chosen !== S.me) await setMe(chosen);
}

function step(delta) {
  const i = S.files.findIndex((f) => fileKey(f) === S.active);
  if (i < 0 || !S.files.length) return;
  show(fileKey(S.files[(i + delta + S.files.length) % S.files.length]), true);
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
    ['session', S.session ? esc(S.session.name) : '<span class="mg-muted">none live</span>'],
    ['game', S.session && S.session.gameType ? gameTag(S.session.gameType) : '<span class="mg-muted">not set</span>'],
    ['you are', S.isHost ? 'the referee (this is the host computer)'
      : S.me ? '<b>' + esc(meName()) + '</b> <span class="mg-muted">a player, on this device</span>'
      : 'a player' + (S.players.length ? ' <span class="mg-muted">no name picked yet: use "who are you?" at the top</span>' : '')],
    ['server', S.serverUp ? liveTag() + ' <span class="mg-muted">at ' + esc(location.host) + '</span>' : '<span class="mg-state err">unreachable</span>'],
  ];
  if (f) {
    const who = copyFor(f);
    rows.push(
      ['page', '<b>' + esc(label(f)) + '</b>'],
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
      ['type', f.kind === 'html' ? 'HTML page: entries are saved and synced' : f.kind === 'pdf' ? 'PDF: form fields are saved and synced' : KIND_NAME[f.kind]],
      ['size', size(f.size)],
      ['changed', esc(when(f.modified)) + ' <span class="mg-muted">(' + esc(agoText(f.modified)) + ')</span>'],
      ['sync', f.kind === 'image' ? '<span class="mg-muted">nothing to sync</span>' : !S.shown ? '<span class="mg-muted">nothing open</span>'
        : st === 'live' ? 'saved and syncing' : esc(STATUS_TEXT[st] || st)]
    );
  }
  const body = '<dl class="mg-kv">' + rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>';
  overlay({ title: 'Session details', icon: 'info', wide: true, body });
}

async function helpOverlay() {
  const keys = [
    ['f', 'full screen on / off'], ['esc', 'leave full screen'], ['1 – 9', 'jump to a tab'],
    ['[  ]', 'previous / next tab'], ['← →', 'move between tabs (when a tab has focus)'], ['i', 'session details'], ['?', 'this help']
  ];
  const v = await overlay({
    title: 'Help',
    icon: 'help',
    body: '<p><b>New here?</b> The <b>player tutorial</b> walks you through every part of this screen, one step at a time.</p>' +
      '<hr class="mg-rule"><div class="mg-section-label">Keyboard shortcuts</div>' +
      '<dl class="mg-kv">' + keys.map((k) => '<dt><kbd>' + k[0] + '</kbd></dt><dd>' + k[1] + '</dd>').join('') + '</dl>' + SHORTCUTS_NOTE,
    actions: [{ label: 'player tutorial', value: 'tour', kind: 'primary', icon: 'tutorial' }]
  });
  if (v === 'tour') tutorial();
}

// ---- the tutorial -------------------------------------------------------------------
// It tours this screen as it is right now: parts that aren't showing (no
// session yet, no party) are explained without a highlight, or left out.

const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
const lastDialog = () => { const all = document.querySelectorAll('dialog[open]'); return all[all.length - 1] || null; };

function tourSteps() {
  const has = !!S.session && S.files.length > 0;
  const f = activeFile();
  const host = S.isHost;
  const steps = [];
  const add = (section, title, text, target, extra) => steps.push(Object.assign({ section, title, text, target }, extra));

  add('Welcome', host ? 'The player dashboard, on the host' : 'The player dashboard',
    (host
      ? '<p>This is what players see, as it looks on the host computer: here it also shows the <b class="referee">referee</b> pages, which players never get.</p>'
      : '<p>This is where the referee\'s pages for the game appear: character sheets, handouts, maps and rules.</p>') +
    '<p>This tour shows every part of the screen, one at a time. Use <b>next</b> and <b>back</b> (or <kbd>←</kbd> <kbd>→</kbd>), or click the timeline at the bottom to jump. <kbd>esc</kbd> ends the tour.</p>');

  add('Top bar', 'Where you are', () =>
    '<p>The <span class="players">blue</span> label says this is the <b class="players">player dashboard</b>' + (meName() ? ', and who you are on this device: <b>' + esc(meName()) + '</b>' : '') + '.</p>' +
    (S.players.length || host ? '' : '<p>When the referee adds players to the party, a <b>who are you?</b> button appears next to it, to pick your name.</p>'),
    ['#info .mg-brand', '#where']);
  if (shown($('whoBtn'))) {
    add('Top bar', S.me ? 'Not you?' : 'Who are you?', () =>
      '<p>' + (S.me ? 'This device is <b>' + esc(meName()) + '</b>. Tap here to pick another name, or to forget it.' : 'Pick your name from the referee\'s party.') + '</p>' +
      '<p>Pages marked <b class="players">per player</b>, like character sheets, then show you your own copy: only you and the referee see what you type in it.</p>', '#whoBtn');
  }
  add('Top bar', 'The session', () =>
    '<p>' + (S.session ? 'The session that is live: <b>' + esc(S.session.name) + '</b>' + (S.session.gameType ? ', playing ' + esc(S.session.gameType) : '') + '.' : 'The live session\'s name shows here once the referee starts one.') + '</p>' +
    '<p>Click it for the session details (shortcut <kbd>i</kbd>).</p>', '#sessionBtn', { optional: true });
  add('Top bar', 'Connection', '<p>Whether this device is connected and syncing:</p>' +
    '<ul><li><span class="mg-live">LIVE:' + esc(serverPort()) + '</span> connected: what you type is saved and shared</li>' +
    '<li><b style="color: var(--warn-ink)">connecting</b> / <b style="color: var(--warn-ink)">reconnecting</b>: hold on, it catches up by itself</li>' +
    '<li><b style="color: var(--danger)">OFFLINE</b>: the referee\'s computer can\'t be reached</li></ul>' +
    '<p>Click it for the session details' + (shown($('sessionBtn')) ? '' : ': the session, who you are and the open page') + '.</p>', '#syncBtn');
  if (shown($('adminLink'))) {
    add('Top bar', 'Referee\'s dashboard', '<p>Back to the <b class="referee">referee\'s dashboard</b>, where sessions, pages and the party are managed. It only opens on this computer.</p>', '#adminLink');
  }
  add('Top bar', 'Display and help', '<p>' + ic('settings') + ' <b>display</b>: colour theme, font (including fonts for low vision and dyslexia), and whether buttons show icons, text or both. Settings belong to this device only.</p>' +
    '<p>' + ic('help') + ' <b>help</b>: keyboard shortcuts, and this tutorial (<kbd>?</kbd>).</p>', ['#info [data-prefs]', '#helpBtn']);

  add('Session details', 'Session details', '<p>Opened from the session name or the connection button: the session, the game, who this device is, and the server it is connected to.</p>' +
    (f ? '<p>Then the page in the open tab: its description and tags, who it is for, ' + (f.perPlayer ? 'whose copy is shown, ' : '') +
      'its type and size, when it last changed, and whether it is saving and syncing.</p>' : ''),
    (d) => d && d.querySelector('.mg-kv'), { scene: 'details' });
  add('Pages', 'Tabs', has
    ? '<p>Each page of the session has a tab. Click one to open it: every tab keeps its place when you switch.</p>' +
      '<ul><li>the number is its key: <kbd>1</kbd> – <kbd>9</kbd> jump straight to it, <kbd>[</kbd> <kbd>]</kbd> step through</li>' +
      '<li>' + ic('kind-pdf') + ' PDFs and ' + ic('kind-image') + ' images have an icon</li>' +
      '<li>' + ic('player') + ' marks a <b class="players">per-player</b> page: you get your own copy</li></ul>' +
      '<p>Hover a tab to read its description.</p>'
    : '<p>The session\'s pages appear here as tabs, as soon as the referee adds them. You don\'t need to reload.</p>',
    has ? '#tabs' : '.tabbar');
  if (document.querySelector('.tab-group')) {
    add('Pages', 'Players and referee', '<p>On the host, tabs come in two groups: <b class="players">players</b> pages, which every player has, and <b class="referee">referee</b> pages, which open only on this computer.</p>', '.tab-group');
  }
  add('Pages', 'Full screen', '<p>Hides the top bar so the page gets the whole screen, leaving only a slim row of tabs. Press it again, or <kbd>esc</kbd>, to get the bar back.</p>' +
    '<p>Shortcut: <kbd>f</kbd>.</p>', '#fullBtn');

  if (shown($('pick'))) {
    add('The page', 'Whose copy', '<p>This page is per player. Pick which copy to see: the <b>template</b> (the starting values for each new copy) or any player\'s own copy.</p>' +
      '<p>What you type into a player\'s copy goes straight to them.</p>', '#pick');
  }
  if (has && shown($('who'))) {
    add('The page', 'Your own copy', '<p>This page is per player, so each player has their own copy. Pick your name here and it opens.</p>' +
      '<p>Not on the list? Ask the referee to add you to the party.</p>', '#who .mg-notice');
  } else if (has) {
    add('The page', 'The page', '<p>The open page. Anything typed into a page or a PDF form is saved and synced live to everyone viewing it' +
      (f && f.perPlayer ? ' (for a per-player page: you and the referee)' : '') + '.</p>' +
      '<p>PDFs and images open in a viewer, with its own controls to zoom and turn pages.</p>', '#frames');
  } else {
    add('The page', 'Waiting', '<p>' + (S.session ? 'The referee is still setting things up.' : 'No session is running yet.') +
      ' Keep this page open: it updates by itself when there is something to see.</p>', '#empty .mg-notice');
  }

  add('Done', 'That\'s it', '<p>Run it again any time: ' + ic('help') + ' <b>help</b>, then ' + ic('tutorial') + ' <b>player tutorial</b>.</p>' +
    (host ? '' : '<p>Have fun at the table.</p>'), '#helpBtn');
  return steps;
}

function tutorial() {
  if (tourRunning()) return;
  // The top bar is part of the tour: bring it back if full screen hid it.
  const wasFull = document.body.classList.contains('mg-full');
  if (wasFull) setFull(false);
  startTour({
    name: 'Player tutorial',
    steps: tourSteps(),
    scenes: {
      details: { label: 'Session details', from: ['#sessionBtn', '#syncBtn'], open: () => { detailsOverlay(); return lastDialog(); } }
    },
    onEnd: () => { if (wasFull) setFull(true, false); }
  });
}

$('sessionBtn').addEventListener('click', detailsOverlay);
$('syncBtn').addEventListener('click', detailsOverlay);
$('helpBtn').addEventListener('click', helpOverlay);
$('whoBtn').addEventListener('click', attempt(pickName));

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

document.addEventListener('keydown', (e) => {
  if (isTyping(e) || anyOverlayOpen()) return;
  const k = e.key;
  if (k === 'f') { setFull(!document.body.classList.contains('mg-full')); }
  else if (k === 'Escape' && document.body.classList.contains('mg-full')) { setFull(false); }
  else if (/^[1-9]$/.test(k) && S.files[+k - 1]) { show(fileKey(S.files[+k - 1]), true); }
  else if (k === '[') { step(-1); }
  else if (k === ']') { step(1); }
  else if ((k === 'ArrowRight' || k === 'ArrowLeft') && e.target.closest && e.target.closest('.tabs')) { step(k === 'ArrowRight' ? 1 : -1); }
  else if (k === 'i') { detailsOverlay(); }
  else if (k === '?') { helpOverlay(); }
  else return;
  e.preventDefault();
});

// ---- live updates ---------------------------------------------------------------------

listenEvents(load, (up) => { S.serverUp = up; updateSync(); });
load();
