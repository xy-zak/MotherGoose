// Who is on this device: the name in the top bar, picking or changing it,
// the "who are you?" panel on a per-player page, and the referee's strip to
// choose whose copy is shown.
import { $, api, attempt, esc, ic, notice, overlay, PER_PLAYER_HINT, playerName, titleOf, withIcon } from '/_mg/ui.js';
import { activeFile, app, fileKey, meName, previewing, S, whoNow } from './state.js';

// The blue "player dashboard" note says who this device is, with a way to
// change it. The referee needs no name, and an empty roster has none to pick.
export function renderWho() {
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

// The strip above a per-player page. For the referee: whose copy is shown
// (the starting copy · Ana · Ben …), with a warning while the starting copy
// is open, since typing there only reaches players who haven't opened it.
// For a player: whose copy this is, with "not you?".
export function renderPick(f, who) {
  const el = $('pick');
  const referee = S.isHost && !previewing();
  el.hidden = !f.perPlayer || (!referee && !who);
  el.classList.toggle('mine', !referee);
  el.classList.toggle('starting', referee && who === '');
  if (el.hidden) { el.textContent = ''; return; }
  if (!referee) {
    el.setAttribute('role', 'note');
    el.innerHTML = '<span class="pick-label">' + withIcon('player', playerName(S.players, who) + '\'s copy') + '</span>' +
      '<span class="pick-note">only you and the referee see it</span>' +
      (previewing() ? '' : '<button type="button" class="pick-btn" data-not-me>' + withIcon('switch', 'not you?') + '</button>');
    return;
  }
  el.setAttribute('role', 'tablist');
  const btn = (id, html, title) => '<button type="button" class="pick-btn" role="tab" data-who="' + esc(id) + '" aria-selected="' + (id === who) + '" title="' + esc(title) + '">' + html + '</button>';
  el.innerHTML = '<span class="pick-label" title="' + PER_PLAYER_HINT + '">' + withIcon('player', 'whose copy') + '</span>' +
    btn('', withIcon('template', 'starting copy'), 'The starting copy: its entries are copied into each player\'s copy when they first open it') +
    S.players.map((p) => btn(p.id, '<span>' + esc(p.name) + '</span>', p.name + '\'s copy')).join('') +
    (S.players.length ? '' : '<span class="pick-note">No players yet. Add them in the referee\'s dashboard, under PARTY in the campaign panel.</span>') +
    (who === '' ? '<span class="pick-warn">' + ic('warning') + 'Editing the starting copy: only players who haven\'t opened it yet get these values</span>' : '');
}

$('pick').addEventListener('click', (e) => {
  if (e.target.closest('[data-not-me]')) { pickName(); return; }
  const b = e.target.closest('[data-who]');
  const f = activeFile();
  if (!b || !f) return;
  S.pick.set(fileKey(f), b.dataset.who);
  app.savePicks();
  app.show(fileKey(f));
});
// Arrow keys move along the strip, like the tabs.
$('pick').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const all = Array.from($('pick').querySelectorAll('[data-who]'));
  const i = all.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const n = all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
  n.click();
  const again = $('pick').querySelector('[data-who="' + CSS.escape(n.dataset.who) + '"]');
  if (again) again.focus();
});

const rosterButtons = () => '<div class="roster">' + S.players.map((p) =>
  '<button type="button" class="mg-btn players" data-player="' + esc(p.id) + '" aria-pressed="' + (p.id === S.me) + '">' + ic('player', 'deco') + '<span>' + esc(p.name) + '</span></button>').join('') + '</div>';

// In the stage, for a player with no copy to show yet.
export function renderAsk(f) {
  const none = !S.players.length;
  $('whoEyebrow').textContent = titleOf(f);
  $('whoTitle').textContent = none ? 'The referee hasn\'t added players yet.' : 'Who are you?';
  $('whoText').textContent = none
    ? 'Each player gets their own copy of this page. It appears here once the referee adds you to the party.'
    : 'Each player fills in their own copy of this page, seen only by them and the referee. Pick your name:';
  $('whoRoster').innerHTML = none ? '' : rosterButtons() + '<p class="mg-muted">Not on the list? Ask the referee to add you.</p>';
}

const setMe = attempt(async (id, quiet) => {
  const before = S.me;
  await api('POST', '/api/me', { player: id });
  // Per-player pages open afresh as the new name; others keep their place.
  app.dropFrames((k) => k.includes('#'));
  app.reconnectEvents();
  await app.load();
  if (quiet) return;
  notice(id
    ? { text: 'You are', strong: playerName(S.players, id), icon: 'player', action: { label: 'undo', icon: 'reset', run: () => setMe(before, true) } }
    : { text: 'This device has no name now.', icon: 'player', action: before ? { label: 'undo', icon: 'reset', run: () => setMe(before, true) } : null });
  // Focus goes to the page's tab, since the button tapped is gone.
  const t = document.querySelector('.tab[aria-selected="true"]');
  if (t) t.focus();
});

$('whoRoster').addEventListener('click', (e) => {
  const b = e.target.closest('[data-player]');
  if (b) setMe(b.dataset.player);
});

export async function pickName() {
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
