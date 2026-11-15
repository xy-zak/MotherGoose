// Getting started: a popup when the dashboard opens, saying what MotherGoose
// does and how to begin, with the firewall's warning (firewall.js) at the
// top when players can't get in. "do not show again" turns the popup off on
// this device; after that, only the firewall's warning opens by itself, when
// it's needed. The about button (top left) brings Getting started back.
import { esc, ftype, ic, overlay, term, toast, uiBtn, withIcon } from '/_mg/ui.js';
import { app } from './state.js';
import { firewallBox, firewallNeedsAttention, firewallStatus, wireFirewall } from './firewall.js';

const HIDE_KEY = 'mg-hide-start';
const startHidden = () => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch (e) { return false; } };
function setStartHidden(on) {
  try { if (on) localStorage.setItem(HIDE_KEY, '1'); else localStorage.removeItem(HIDE_KEY); } catch (e) { /* storage off: it opens each time */ }
}

// What MotherGoose does, one thing per line, and buttons to learn more.
// Terms, file types and buttons each have their own look (the key at the top
// says which is which). The firewall's box goes in .fw-slot, at the top.
function startBody() {
  const types = ftype('.html') + ' ' + ftype('.md') + ' ' + ftype('.pdf') + ' ' + ftype('.png') + ' ' + ftype('.jpg');
  const feat = (icon, name, text) =>
    '<li><span class="gs-ic">' + ic(icon) + '</span><b class="gs-name">' + esc(name) + '</b><span class="gs-text">' + text + '</span></li>';
  const stepRow = (n, text) => '<li><span class="gs-n">' + n + '</span><span class="gs-text">' + text + '</span></li>';
  return '<div class="fw-slot"></div>' +
    '<p class="gs-lead">MotherGoose shares your game\'s pages with the players\' phones, tablets and laptops, over this computer\'s Wi-Fi or network. No internet or accounts needed.</p>' +
    '<p class="gs-key"><span class="mg-muted">Key:</span>' +
      '<span>' + term('term') + ' <span class="mg-muted">an idea in MotherGoose</span></span>' +
      '<span>' + ftype('.html') + ' <span class="mg-muted">a file type</span></span>' +
      '<span>' + uiBtn('live', 'button') + ' <span class="mg-muted">a button on screen</span></span></p>' +

    '<div class="mg-section-label">What you can do</div>' +
    '<ul class="gs-list">' +
      feat('sessions', 'Campaigns', 'Keep each game in its own ' + term('campaign') + ': its pages, party and entries, ready for every ' + term('session') + ' you play. Give it a ' + term('game type') + ' (the game or rules being played) to tell campaigns apart.') +
      feat('kind-html', 'Pages', 'Add ' + types + ' files with ' + uiBtn('add', 'add') + ', or drop them on a column.') +
      feat('check', 'Live entries', 'Anything typed into an ' + ftype('.html') + ' page, or into a ' + ftype('.pdf') + ' form, is saved and synced live to everyone viewing it.') +
      feat('players', 'Who sees what', term('Players', 'players') + ' pages go to every player. ' + term('Referee', 'referee') + ' pages only open on this computer.') +
      feat('switch', 'Order', 'Drag a page up or down to reorder it: players\' tabs follow the same order. Drag it onto the other column to change who it\'s for.') +
      feat('tag', 'Details', 'Give each page a ' + term('description') + ' and ' + term('tags') + ' with ' + uiBtn('info', 'info') + ', so players know what they\'re looking at.') +
      feat('player', 'Party', 'Add your players to the campaign\'s ' + term('party', 'players') + '. Mark character sheets ' + term('per player', 'players') + ': each player fills in their own copy.') +
      feat('live', 'Go live', uiBtn('live', 'go live', 'go-live') + ' starts a session: the campaign goes on the players\' screens. ' + uiBtn('end', 'end session', 'end-session') + ' takes it off again.') +
      feat('join', 'Joining', uiBtn('join', 'join info') + ' shows the address and QR code players open to join.') +
      feat('export', 'Export', uiBtn('export', 'export filled') + ' downloads a page with every entry baked in, which works offline.') +
      feat('settings', 'Display', uiBtn('settings', 'display') + ' changes the theme, font, icons and animations, for this device.') +
    '</ul>' +

    '<div class="mg-section-label">Your first campaign</div>' +
    '<ol class="gs-list gs-steps">' +
      stepRow(1, 'Type a name, and a ' + term('game type') + ', under ' + term('Campaigns') + ' on the left, then press ' + uiBtn('add', 'new', 'primary') + '.') +
      stepRow(2, 'Drop ' + types + ' files on the ' + term('Players', 'players') + ' or ' + term('Referee', 'referee') + ' column.') +
      stepRow(3, 'Add each player\'s name to the ' + term('party', 'players') + '.') +
      stepRow(4, 'Press ' + uiBtn('live', 'go live', 'go-live') + ', then show the table ' + uiBtn('join', 'join info') + '.') +
    '</ol>' +

    '<div class="mg-section-label">Learn more</div>' +
    '<div class="gs-learn">' +
      '<button type="button" class="mg-btn primary" data-start="tutorial" title="A guided tour of this page, using an example campaign">' + withIcon('tutorial', 'referee tutorial') + '</button>' +
      '<a class="mg-btn players" href="/?tour=1" target="_blank" rel="noopener" data-switch="players" title="Opens the player view in a new tab and starts its tour">' + withIcon('tutorial', 'player tutorial') + '</a>' +
      '<button type="button" class="mg-btn" data-start="guide" title="How to write pages for MotherGoose, also as an AI skill">' + withIcon('guide', 'making HTML pages') + '</button>' +
      '<button type="button" class="mg-btn" data-start="help" title="Keyboard shortcuts (?)">' + withIcon('help', 'keyboard shortcuts') + '</button>' +
      '<button type="button" class="mg-btn" data-prefs title="Theme, font, icons and animations">' + withIcon('settings', 'display settings') + '</button>' +
    '</div>';
}

/**
 * startOverlay opens Getting started. again: opened from the about button,
 * which also turns it back on for the next start.
 */
export async function startOverlay(again) {
  if (again) setStartHidden(false);
  const body = document.createElement('div');
  body.className = 'welcome';
  body.innerHTML = startBody();
  const slot = body.querySelector('.fw-slot');
  const draw = (st) => { slot.innerHTML = firewallBox(st, true); };
  wireFirewall(slot, draw);
  firewallStatus(true).then(draw);
  let next = null;
  const v = await overlay({
    title: 'Getting started', icon: 'info', size: 'xwide', body,
    actions: [
      { label: 'do not show again', value: 'hide', kind: 'quiet', icon: 'close', side: 'left', title: 'Don\'t open this when the dashboard starts (the firewall warning still does, when it\'s needed)' },
      { label: 'close', value: null, kind: 'primary', icon: 'check' }
    ],
    onOpen: (d) => {
      // The "learn more" buttons close the popup, then open what they say.
      d.addEventListener('click', (e) => {
        const b = e.target.closest('[data-start]');
        if (b) { next = b.dataset.start; d.close(); }
      });
    }
  });
  if (v === 'hide') {
    setStartHidden(true);
    toast('Getting started won\'t open when the dashboard starts. The info button at the top left brings it back.');
  }
  if (next && app[next]) app[next]();
}

/** firewallOverlay is the firewall's warning on its own, for a start without Getting started. */
async function firewallOverlay(st) {
  const body = document.createElement('div');
  body.className = 'fw-only';
  const draw = (s) => {
    body.innerHTML = firewallBox(s, true) +
      '<p class="mg-muted mg-small">MotherGoose checks each time the dashboard opens, and says so here when players can\'t get in.</p>';
  };
  wireFirewall(body, draw);
  draw(st);
  await overlay({ title: 'Firewall', icon: 'warning', body, actions: [{ label: 'close', value: null, kind: 'primary', icon: 'check' }] });
}

/**
 * launch runs when the dashboard opens, once per browser tab (a reload
 * doesn't open it again): Getting started, or else the firewall's warning if
 * it's needed.
 */
export async function launch() {
  try {
    if (sessionStorage.getItem('mg-launched')) return;
    sessionStorage.setItem('mg-launched', '1');
  } catch (e) { /* storage off: it opens on every load */ }
  if (!startHidden()) { startOverlay(false); return; }
  const st = await firewallStatus(true);
  if (firewallNeedsAttention(st)) firewallOverlay(st);
}
