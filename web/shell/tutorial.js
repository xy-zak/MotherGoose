// The player tutorial. It tours this screen as it is right now: parts that
// aren't showing (nothing live yet, no party) are explained without a
// highlight, or left out.
import { $, esc, ic, lastDialog, liveTag } from '/_mg/ui.js';
import { activeFile, app, meName, S } from './state.js';
import { startTour, tourRunning } from '/_mg/tour.js';

const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;

function tourSteps() {
  const has = !!S.session && S.files.length > 0;
  const f = activeFile();
  const host = S.isHost;
  // On a tablet the tour talks about taps and holds, and leaves out keys.
  const touch = matchMedia('(pointer: coarse)').matches;
  const key = (html) => touch ? '' : html;
  const click = touch ? 'Tap' : 'Click';
  const steps = [];
  const add = (section, title, text, target, extra) => steps.push(Object.assign({ section, title, text, target }, extra));

  add('Welcome', host ? 'The player view, on the host' : 'The player view',
    (host
      ? '<p>This is what players see, as it looks on the host computer: here it also shows the <b class="referee">referee</b> pages, which players never get.</p>'
      : '<p>This is where the referee\'s pages for the game appear: character sheets, handouts, maps and rules.</p>') +
    '<p>This tour shows every part of the screen, one at a time. Use <b>next</b> and <b>back</b>' + key(' (or <kbd>←</kbd> <kbd>→</kbd>)') + ', or ' + click.toLowerCase() + ' the timeline at the bottom to jump.' + key(' <kbd>esc</kbd> ends the tour.') + '</p>');

  add('Top bar', 'Where you are', () =>
    '<p>The <span class="players">blue</span> label says this is the <b class="players">player view</b>' + (meName() ? ', and who you are on this device: <b>' + esc(meName()) + '</b>' : '') + '.</p>' +
    (S.players.length || host ? '' : '<p>When the referee adds players to the party, a <b>who are you?</b> button appears next to it, to pick your name.</p>'),
    ['#info .mg-brand', '#where']);
  if (shown($('whoBtn'))) {
    add('Top bar', S.me ? 'Not you?' : 'Who are you?', () =>
      '<p>' + (S.me ? 'This device is <b>' + esc(meName()) + '</b>. Tap here to pick another name, or to forget it.' : 'Pick your name from the referee\'s party.') + '</p>' +
      '<p>Pages marked <b class="players">per player</b>, like character sheets, then show you your own copy: only you and the referee see what you type in it.</p>', '#whoBtn');
  }
  add('Top bar', 'The campaign', () =>
    '<p>' + (S.session ? 'The campaign that is live: <b>' + esc(S.session.name) + '</b>' + (S.session.gameType ? ', playing ' + esc(S.session.gameType) : '') + '.' : 'The campaign\'s name shows here once the referee starts the session.') + '</p>' +
    '<p>' + click + ' it for the details' + key(' (shortcut <kbd>i</kbd>)') + '.</p>', '#sessionBtn', { optional: true });
  add('Top bar', 'Connection', '<p>Whether this device is connected and syncing:</p>' +
    '<ul><li>' + liveTag() + ' connected: what you type is saved and shared</li>' +
    '<li><b style="color: var(--warn-ink)">connecting</b> / <b style="color: var(--warn-ink)">reconnecting</b>: hold on, it catches up by itself</li>' +
    '<li><b style="color: var(--danger)">OFFLINE</b>: the referee\'s computer can\'t be reached</li></ul>' +
    '<p>' + click + ' it for the details' + (shown($('sessionBtn')) ? '' : ': the campaign, who you are and the open page') + '.</p>' +
    '<p>A tab marked <b style="color: var(--warn-ink)">!</b> is reconnecting on its own: what you type there is kept and sent when it\'s back.</p>', '#syncBtn');
  if (shown($('adminLink'))) {
    add('Top bar', 'Referee\'s dashboard', '<p>Back to the <b class="referee">referee\'s dashboard</b>, where campaigns, pages and the party are managed. It only opens on this computer.</p>', '#adminLink');
  }
  add('Top bar', 'Display and help', '<p>' + ic('settings') + ' <b>display</b>: colour theme, font (including fonts for low vision and dyslexia), and whether buttons show icons, text or both. Settings belong to this device only.</p>' +
    '<p>' + ic('help') + ' <b>help</b>: ' + (touch ? 'touch gestures' : 'keyboard shortcuts') + ', and this tutorial' + key(' (<kbd>?</kbd>)') + '.</p>', ['#info [data-prefs]', '#helpBtn']);

  add('Details', 'Details', '<p>Opened from the campaign name or the connection button: the campaign, the game, who this device is, and the server it is connected to.</p>' +
    (f ? '<p>Then the page in the open tab: its description and tags, who it is for, ' + (f.perPlayer ? 'whose copy is shown, ' : '') +
      'its type and size, when it last changed, and whether it is saving and syncing.</p>' : ''),
    (d) => d && d.querySelector('.mg-kv'), { scene: 'details' });
  add('Pages', 'Tabs', has
    ? '<p>Each page of the campaign has a tab. ' + click + ' one to open it: every tab keeps its place when you switch.</p>' +
      '<ul>' + key('<li>the number is its key: <kbd>1</kbd> – <kbd>9</kbd> jump straight to it, <kbd>[</kbd> <kbd>]</kbd> step through</li>') +
      '<li>' + ic('kind-pdf') + ' PDFs and ' + ic('kind-image') + ' images have an icon</li>' +
      '<li>' + ic('player') + ' marks a <b class="players">per-player</b> page: you get your own copy</li>' +
      '<li>a dot means a page you haven\'t opened yet on this device; a ring, one that changed since you last opened it</li></ul>' +
      '<p>When the referee adds or reveals a page, a note says so, with a button to open it.</p>' +
      (touch ? '<p>Drag tabs into your own order; hold one to <b>shrink</b> it. When they don\'t all fit, the last ones shrink by themselves.</p>'
        : '<p>Hover a tab to read its description. Drag tabs into your own order; right-click one (or hold it) to <b>shrink</b> it. When they don\'t all fit, the last ones shrink by themselves.</p>')
    : '<p>The campaign\'s pages appear here as tabs, as soon as the referee adds them. You don\'t need to reload.</p>',
    has ? '#tabs' : '.tabbar');
  if (document.querySelector('.tab-group')) {
    add('Pages', 'Players and referee', '<p>On the host, tabs come in two groups: <b class="players">players</b> pages, which every player has, and <b class="referee">referee</b> pages, which open only on this computer.</p>', '.tab-group');
  }
  if (shown($('pagesBtn'))) {
    add('Pages', 'Every page', '<p>' + ic('pages') + ' <b>pages</b> lists every page, with a search box: type part of a name, or <b>#map</b> for pages tagged map. The quickest way to find one when the tabs don\'t all fit' +
      key(' (shortcut <kbd>Ctrl</kbd> <kbd>K</kbd> or <kbd>/</kbd>)') + '.</p>', '#pagesBtn');
  }
  if (shown($('filterBtn'))) {
    add('Pages', 'Filter', '<p>Shows only the tabs with the tags you pick, for example only the maps. This device remembers it; <b>clear filter</b> brings every tab back.' + key(' Shortcut: <kbd>t</kbd>.') + '</p>', '#filterBtn');
  }
  add('Pages', 'Full screen', '<p>Hides the top bar so the page gets the whole screen, leaving only a slim row of tabs and the connection status. Press it again' + key(', or <kbd>esc</kbd>,') + ' to get the bar back.</p>' +
    key('<p>Shortcut: <kbd>f</kbd>.</p>'), '#fullBtn');

  if (shown($('pick'))) {
    add('The page', 'Whose copy', '<p>This page is per player. Pick which copy to see: the <b>starting copy</b> (each new copy starts from it) or any player\'s own copy.</p>' +
      '<p>What you type into a player\'s copy goes straight to them.</p>', '#pick');
  }
  if (has && shown($('who'))) {
    add('The page', 'Your own copy', '<p>This page is per player, so each player has their own copy. Pick your name here and it opens.</p>' +
      '<p>Not on the list? Ask the referee to add you to the party.</p>', '#who .mg-notice');
  } else if (has) {
    add('The page', 'The page', '<p>The open page. Anything typed into a page or a PDF form is saved and synced live to everyone viewing it' +
      (f && f.perPlayer ? ' (for a per-player page: you and the referee)' : '') + '.</p>' +
      '<p>PDFs and images open in a viewer, with its own controls to zoom and turn pages' + (touch ? '; pinch to zoom, or double-tap' : '') + '.</p>', '#frames');
  } else {
    add('The page', 'Waiting', '<p>' + (S.session ? 'The referee is still setting things up.' : 'Nothing is live yet.') +
      ' Keep this page open: it updates by itself when there is something to see.</p>', '#empty .mg-notice');
  }

  add('Done', 'That\'s it', '<p>Run it again any time: ' + ic('help') + ' <b>help</b>, then ' + ic('tutorial') + ' <b>player tutorial</b>.</p>' +
    (host ? '' : '<p>Have fun at the table.</p>'), '#helpBtn');
  return steps;
}

export function tutorial() {
  if (tourRunning()) return;
  // The top bar is part of the tour: bring it back if full screen hid it.
  const wasFull = document.body.classList.contains('mg-full');
  if (wasFull) app.setFull(false);
  startTour({
    name: 'Player tutorial',
    steps: tourSteps(),
    scenes: {
      details: { label: 'Details', from: ['#sessionBtn', '#syncBtn'], open: () => { app.detailsOverlay(); return lastDialog(); } }
    },
    onEnd: () => { if (wasFull) app.setFull(true, false); }
  });
}
