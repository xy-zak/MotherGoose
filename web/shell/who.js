// Who is on this device: the name in the top bar, picking or changing it,
// the "who are you?" panel on a per-player page, and the referee's strip to
// choose whose copy is shown.
import { $, api, attempt, esc, ic, overlay, PER_PLAYER_HINT, titleOf, withIcon } from '/_mg/ui.js';
import { activeFile, app, fileKey, meName, S } from './state.js';

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

// The referee's strip above a per-player page: template · Ana · Ben …
export function renderPick(f, who) {
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
  app.show(fileKey(f));
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

const setMe = attempt(async (id) => {
  await api('POST', '/api/me', { player: id });
  await app.load();
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
