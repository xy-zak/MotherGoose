// At the table: what the referee does while a session runs. Who is
// connected (presence), revealing a page with a moment to undo, pointing
// players to a page, a page row's "⋯" menu (move up/down, to the other side,
// clear, delete), and starting, switching and ending a session without
// spoiling anything by accident.
import { api, audienceText, confirmDialog, enc, isHidden, notice, playerName, popMenu, SCOPE, titleOf, toast } from '/_mg/ui.js';
import { A, app, fileBase, other } from './state.js';
import { bootScreen } from '/_mg/fx.js';

// ---- presence: which players' devices are connected ---------------------------------

/** setPresence keeps the latest presence event and marks the party chips. */
export function setPresence(m) {
  A.presence = m;
  drawPresence();
}

/** presenceOf is how many devices picked a player in the live campaign. */
export const presenceOf = (s, pid) => (A.presence && s && s.active && A.presence.session === s.id && A.presence.players[pid]) || 0;

/** connectedCount is how many players' devices are connected to the live campaign. */
export function connectedCount(s) {
  const p = A.presence;
  if (!p || !s || !s.active || p.session !== s.id) return null;
  return Object.values(p.players).reduce((a, b) => a + b, 0) + (p.unnamed || 0);
}

// drawPresence marks each party chip: connected (a dot and a word, never
// colour alone) or not, and two devices on one name. Called after every
// redraw and every presence event.
export function drawPresence() {
  const s = A.current;
  document.querySelectorAll('.pchip[data-id]').forEach((li) => {
    const n = presenceOf(s, li.dataset.id);
    li.classList.toggle('here', n > 0);
    li.classList.toggle('twice', n > 1);
    let tag = li.querySelector('.pres');
    if (!s || !s.active) { if (tag) tag.remove(); return; }
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'pres';
      li.querySelector('.pname').appendChild(tag);
    }
    tag.textContent = n > 1 ? n + ' devices' : n ? 'here' : 'away';
    li.title = n > 1 ? 'Two or more devices picked this name' : n ? 'Connected' : 'Not connected';
  });
  const out = document.querySelector('.presence-sum');
  const n = connectedCount(s);
  if (out) {
    out.hidden = n === null;
    if (n !== null) {
      const unnamed = (A.presence && A.presence.unnamed) || 0;
      out.textContent = n + ' device' + (n === 1 ? '' : 's') + ' connected' + (unnamed ? ' · ' + unnamed + ' without a name' : '');
    }
  }
}

// ---- revealing, hiding and pointing players to a page --------------------------------

const pending = new Map();   // fileKey -> cancels a reveal still waiting

/**
 * toggleHidden hides a players' page at once, or reveals it after a 4 s
 * notice with "undo": a mis-click on a hidden clue can be taken back before
 * any player sees it.
 */
export async function toggleHidden(scope, name) {
  const f = (A.current.files[scope] || []).find((x) => x.name === name);
  if (!f) return;
  const key = scope + '/' + name, base = fileBase(A.current, scope, name), players = A.current.players;
  if (!isHidden(f)) {
    await api('PUT', base + '/meta', { hidden: true });
    toast('Hid ' + titleOf(f) + ' from players');
    app.refresh();
    return;
  }
  if (pending.has(key)) return;
  let undone = false;
  const close = notice({
    text: 'Revealing', strong: titleOf(f) + ' to ' + audienceText(f, players) + '…', icon: 'view', ms: 4000,
    action: { label: 'undo', icon: 'reset', run: () => { undone = true; pending.delete(key); toast('Still hidden: ' + titleOf(f)); } },
    onTimeout: async () => {
      pending.delete(key);
      if (undone) return;
      try {
        await api('PUT', base + '/meta', { hidden: false });
        toast('Revealed ' + titleOf(f));
      } catch (e) { toast(e.message, true); }
      app.refresh();
    }
  });
  pending.set(key, close);
}

/** pointHere asks every player who can see a page to look at it now. */
export async function pointHere(scope, name) {
  const f = (A.current.files[scope] || []).find((x) => x.name === name);
  if (!f) return;
  const r = await api('POST', fileBase(A.current, scope, name) + '/show');
  const n = r && r.devices || 0;
  toast(n ? 'Pointed ' + n + ' device' + (n === 1 ? '' : 's') + ' to ' + titleOf(f) : 'No player\'s device that can see ' + titleOf(f) + ' is connected', !n);
}

// ---- a page row's "⋯" menu -----------------------------------------------------------

/** rowMenu opens the rarer actions for a page: everything that isn't open, info or hide/reveal. */
export function rowMenu(btn, scope, name) {
  const s = A.current;
  const files = s.files[scope] || [];
  const at = files.findIndex((x) => x.name === name);
  const f = files[at];
  if (!f) return;
  const to = other(scope);
  popMenu(btn, [
    { label: 'point here', icon: 'point', disabled: !(scope === 'shared' && s.active && !isHidden(f)), run: () => pointHere(scope, name).catch((e) => toast(e.message, true)) },
    '-',
    { label: 'move up', icon: 'up', disabled: at <= 0, run: () => moveBy(scope, name, -1) },
    { label: 'move down', icon: 'down', disabled: at >= files.length - 1, run: () => moveBy(scope, name, 1) },
    { label: 'move to ' + SCOPE[to].label, icon: to === 'gm' ? 'to-referee' : 'to-players', run: () => move(scope, name, to) },
    '-',
    { label: 'clear entries', icon: 'reset', danger: true, disabled: !(f.hasState && !f.perPlayer), run: () => clearEntries(scope, name) },
    { label: 'delete', icon: 'delete', danger: true, run: () => deletePage(scope, name) }
  ], { label: 'More for ' + titleOf(f) });
}

/** moveBy moves a page one place up (-1) or down (1) in its column. */
export async function moveBy(scope, name, delta) {
  const names = (A.current.files[scope] || []).map((x) => x.name);
  const i = names.indexOf(name), j = i + delta;
  if (i < 0 || j < 0 || j >= names.length) return;
  [names[i], names[j]] = [names[j], names[i]];
  await api('PUT', '/api/admin/sessions/' + enc(A.current.id) + '/order', { scope, names });
  await app.refresh();
  const row = document.querySelector('.file[data-scope="' + scope + '"][data-name="' + CSS.escape(name) + '"]');
  if (row) row.focus();
}

// ---- moving, clearing and deleting pages -----------------------------------------------

/** move puts a page on the other side (players or referee). */
export async function move(scope, name, to) {
  const r = await api('PATCH', fileBase(A.current, scope, name), { scope: to });
  toast('Moved ' + name + ' to the ' + SCOPE[to].label + (r && r.hidden ? ': hidden, because the session is live. Reveal it when ready.' : ''));
  app.refresh();
}

/**
 * clearEntries clears what was typed into a page, or into one copy of a
 * per-player page (player: '' is the starting copy), keeping it in the trash
 * with a moment to undo. It resolves true when cleared.
 */
export async function clearEntries(scope, name, player) {
  const f = (A.current.files[scope] || []).find((x) => x.name === name);
  if (!f) return false;
  const copy = player === undefined ? '' : player;
  const whose = player === undefined ? '"' + titleOf(f) + '"'
    : copy ? playerName(A.current.players, copy) + '\'s copy of "' + titleOf(f) + '"' : 'the starting copy of "' + titleOf(f) + '"';
  if (!(await confirmDialog('Clear entries', 'Clear everything typed into ' + whose + '? Anyone viewing it reloads empty.' +
      (player === '' ? ' Players\' own copies are kept.' : ''), 'clear entries', { icon: 'reset' }))) return false;
  const r = await api('DELETE', fileBase(A.current, scope, name) + '/state' + (copy ? '?player=' + enc(copy) : ''));
  trashed('Cleared the entries of', titleOf(f), [r && r.trash]);
  app.refresh();
  return true;
}

/** clearAllCopies clears every player's copy of a per-player page, after asking. */
export async function clearAllCopies(scope, name) {
  const f = (A.current.files[scope] || []).find((x) => x.name === name);
  if (!f) return false;
  const filled = (A.current.players || []).filter((p) => f.playerState && f.playerState[p.id]);
  if (!filled.length) return false;
  if (!(await confirmDialog('Clear every copy', 'Clear what ' + filled.map((p) => p.name).join(', ') + ' typed into their copies of "' + titleOf(f) + '"? The starting copy is kept.', 'clear every copy', { icon: 'reset' }))) return false;
  const tids = [];
  for (const p of filled) tids.push((await api('DELETE', fileBase(A.current, scope, name) + '/state?player=' + enc(p.id)) || {}).trash);
  trashed('Cleared ' + filled.length + ' cop' + (filled.length === 1 ? 'y' : 'ies') + ' of', titleOf(f), tids);
  app.refresh();
  return true;
}

/** deletePage moves a page to the trash, after asking. It resolves true when deleted. */
export async function deletePage(scope, name) {
  const f = (A.current.files[scope] || []).find((x) => x.name === name);
  if (!f) return false;
  const live = A.current.active && scope === 'shared' ? ' Players looking at it lose it now.' : '';
  if (!(await confirmDialog('Delete page', 'Delete "' + titleOf(f) + '"' + (f.perPlayer ? ' and every player\'s copy of it' : f.hasState ? ' and everything typed into it' : '') + '?' + live +
      ' It stays in the trash (in the data folder) for 30 days.', 'delete page'))) return false;
  const r = await api('DELETE', fileBase(A.current, scope, name));
  trashed('Deleted', titleOf(f), [r && r.trash]);
  app.refresh();
  return true;
}

// ---- the trash: undoing a delete or a clear ---------------------------------------------

/**
 * trashed says what went to the trash, with "undo" to put it back (every
 * item, for an action that made several).
 */
export function trashed(text, strong, tids) {
  const ids = (tids || []).filter(Boolean);
  if (!ids.length) { toast(text + ' ' + strong); return; }
  notice({
    text, strong, icon: 'delete', ms: 10000,
    action: { label: 'undo', icon: 'reset', run: async () => { for (const id of ids) await restoreTrash(id, true); toast('Put back: ' + strong); app.refresh(); } }
  });
}

/** restoreTrash puts a trash item back; quiet leaves the toast and refresh to the caller. */
export async function restoreTrash(id, quiet) {
  try {
    const it = await api('POST', '/api/admin/trash/' + enc(id) + '/restore');
    if (!quiet) { toast('Put back: ' + trashLabel(it)); app.refresh(); }
    return it;
  } catch (e) { toast(e.message, true); return null; }
}

/** trashLabel names a trash item for people. */
export function trashLabel(it) {
  const page = it.title || it.name;
  if (it.kind === 'campaign') return 'the campaign ' + it.sessionName;
  if (it.kind === 'player') return it.title + ' (party of ' + it.sessionName + ')' + (it.copies ? ', with their entries' : '');
  if (it.kind === 'entries') return 'entries of ' + page + (it.player ? ' (' + it.player + '\'s copy)' : '') + ' in ' + it.sessionName;
  return page + ' in ' + it.sessionName;
}

// ---- starting, switching and ending a session --------------------------------------------

/**
 * goLive starts a session. When another campaign is live it asks first,
 * since going live there ends that session for every player.
 */
export async function goLive(id, screens) {
  const s = A.sessions.find((x) => x.id === id) || A.current;
  const was = A.sessions.find((x) => x.active && x.id !== s.id);
  if (was && !(await confirmDialog('Switch the live campaign',
    '"' + was.name + '" is live. Switching ends its session for every player and starts "' + s.name + '".', 'switch live here', { icon: 'live' }))) return;
  const noPages = !(s.files.shared || []).length;
  const noParty = (s.files.shared || []).some((f) => f.perPlayer) && !(s.players || []).length;
  await api('POST', '/api/admin/sessions/' + enc(s.id) + '/activate');
  app.refresh();
  await bootScreen(screens.start(s, was));
  notice({ text: 'Session started:', strong: s.name, icon: 'live', action: { label: 'join info', icon: 'join', run: () => app.joinOverlay() } });
  if (noPages) notice({ text: 'There are no players\' pages yet: players will see an empty campaign.', icon: 'warning', ms: 10000 });
  if (noParty) notice({ text: 'There are per-player pages but no party: add players so each gets their own copy.', icon: 'warning', ms: 10000 });
}

let ending = false;   // an "end session" on its way to the server

/**
 * endSession ends the live session at once, so players are released
 * straight away. The notice that follows has "undo", which starts the
 * same campaign again.
 */
export async function endSession(screens) {
  const s = A.sessions.find((x) => x.active);
  if (!s || ending) return;
  ending = true;
  try {
    await api('DELETE', '/api/admin/active');
  } catch (e) { toast(e.message, true); return; } finally { ending = false; }
  app.refresh();
  await bootScreen(screens.end(s));
  notice({
    text: 'Session ended:', strong: s.name + '. Players are back on the waiting screen.', icon: 'end', ms: 10000,
    action: { label: 'undo', icon: 'reset', run: async () => {
      try { await api('POST', '/api/admin/sessions/' + enc(s.id) + '/activate'); toast('The session goes on'); } catch (e) { toast(e.message, true); }
      app.refresh();
    } }
  });
}
