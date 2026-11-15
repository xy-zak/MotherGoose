// The referee tutorial. It tours an example campaign, so every part of the
// page is there to show (a per-player page, a hidden handout, a party, both
// columns) whatever the real campaigns hold. Nothing in it is saved: the real
// campaigns come back when the tour ends.
import { esc, ic, lastDialog, liveTag } from '/_mg/ui.js';
import { A, app } from './state.js';
import { startTour, tourRunning } from '/_mg/tour.js';
import { joinOverlay, fileOverlay } from './overlays.js';

const TOUR_ID = 'example-tour';
function exampleSession() {
  const now = new Date().toISOString();
  const minsAgo = (min) => new Date(Date.now() - min * 60000).toISOString();
  const page = (scope, name, kind, o) => Object.assign({ name, title: '', kind, scope, size: 0, modified: now, hasState: false, description: '', tags: [], perPlayer: false,
    hidden: false, audience: '', allowed: [] }, o);
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
        page('shared', 'drowned-letter.html', 'html', { title: 'The drowned letter', size: 4100, modified: minsAgo(40), hidden: true, audience: 'only', allowed: ['cass'],
          description: 'Found on the drowned priest. Cass can read it: the others can\'t.', tags: ['handout'] }),
        page('shared', 'quest-log.md', 'md', { title: 'Quest log', size: 900, modified: minsAgo(8), hasState: true, tags: ['notes'] }),
        page('shared', 'keep-map.png', 'image', { title: 'Map of the keep', size: 820000, modified: minsAgo(60 * 26), tags: ['map', 'level 1'] })
      ],
      gm: [
        page('gm', 'gm-notes.html', 'html', { title: 'Referee notes', size: 9100, modified: minsAgo(30), hasState: true, description: 'Secrets, timings and the drowned bell.' }),
        page('gm', 'monster-stats.pdf', 'pdf', { title: 'Monster stats', size: 2400000, modified: minsAgo(60 * 50) })
      ]
    }
  };
}

const field = (name) => (d) => { const el = d && d.querySelector('[name="' + name + '"]'); return el && el.closest('.mg-field'); };
const ROW = '.file[data-name="tavern-rumours.html"]';

function tourSteps() {
  const live = A.sessions.find((s) => s.active && s.id !== TOUR_ID);
  return [
    { section: 'Welcome', title: 'The referee\'s dashboard', text:
      '<p>This tour shows every part of this page, one at a time. Use <b>next</b> and <b>back</b> (or <kbd>←</kbd> <kbd>→</kbd>), or click the timeline at the bottom to jump.</p>' +
      '<p>To show everything, it opens an example campaign, <b>The Sunken Keep</b>. Nothing in it is saved, and your own campaigns aren\'t touched. <kbd>esc</kbd> ends the tour.</p>' },

    { section: 'Top bar', title: 'The top bar', target: 'header.top', text:
      '<ul><li>' + ic('info') + ' <b>about</b>: what MotherGoose is and who made it, with <b>getting started</b> to close the open campaign</li>' +
      '<li>the <b class="referee">referee\'s dashboard</b> label: this page only opens on this computer, the host</li>' +
      '<li>' + ic('join') + ' <b>join info</b>: the address players open (<kbd>j</kbd>)</li>' +
      '<li>' + ic('view') + ' <b class="players">player view</b>: see exactly what players see</li>' +
      '<li>' + ic('data') + ' <b>data folder</b>: where everything is kept on this computer, with a button to open it</li>' +
      '<li>' + ic('settings') + ' <b>display</b>: theme, font and icons, for this device</li>' +
      '<li>' + ic('help') + ' <b>help</b>: shortcuts, this tutorial, and <b>Making HTML pages</b> (<kbd>?</kbd>)</li></ul>' +
      '<p>Anywhere on this page, <kbd>Ctrl</kbd> <kbd>K</kbd> or <kbd>/</kbd> jumps to any campaign, page, tag (<b>#map</b>) or player.</p>' },
    { section: 'Top bar', title: 'Join Info', scene: 'join', target: (d) => d, text:
      '<p>Players open this address in a browser, or scan the code with a phone camera. They need to be on the same Wi-Fi or network as this computer.</p>' +
      '<p>When this computer\'s name works on your network (<b>&lt;name&gt;.local</b>), it comes first: unlike the number address, it stays the same from one game night to the next. Any address can show its own QR code.</p>' },

    { section: 'Campaigns', title: 'Your campaigns', target: '#left > .mg-panel.list', text: () =>
      '<p>Create a campaign with a name and, optionally, the <b>game type</b> (the game or rules being played). Shortcut: <kbd>n</kbd>.</p>' +
      '<p>Below is every campaign, newest edit first; the example is selected. <b>3·2</b> counts the pages for players · for the referee, then how long since the last edit. <kbd>↑</kbd> <kbd>↓</kbd> and <kbd>enter</kbd> open one.</p>' +
      '<p>The one players see right now is marked ' + liveTag() + (live ? ': <b>' + esc(live.name) + '</b>' : '') + '. Only one campaign is live at a time: from <b>go live</b> to <b>end session</b> is a session.' +
      (live ? '' : ' Nothing is live at the moment, so players see a waiting screen.') + '</p>' },

    { section: 'Campaign', title: 'The open campaign', target: ['#right > .mg-panel:first-child > .head-row', '#right > .mg-panel:first-child > .head-meta', '#right > .mg-panel:first-child > .actions'], text:
      '<p>Its name, game type and page counts, with:</p>' +
      '<ul><li>' + ic('edit') + ' <b>edit</b> the name or game type (<kbd>e</kbd>)</li>' +
      '<li>' + ic('folder') + ' <b>open folder</b> on this computer, to add files by hand</li>' +
      '<li>' + ic('info') + ' <b>info</b>: id, party, dates and where it\'s stored</li>' +
      '<li>' + ic('live') + ' <b>go live</b>: start a session, putting it on every player\'s screen. While it\'s live, the same button is <b>end session</b>, which sends players back to a waiting screen</li>' +
      '<li>' + ic('more') + ' <b>more</b>: <b>export all</b> (every page filled in, as a .zip) and <b>duplicate</b> (the same pages for another group, without anything typed into them)</li>' +
      '<li>' + ic('delete') + ' <b>delete</b> it with all its pages and entries (it asks first, and you can undo it: deleted things stay in the trash, in <b>data folder</b>, for 30 days)</li></ul>' },

    { section: 'Party', title: 'The party', target: '.party', text:
      '<p>Below the line in the campaign panel: the players in this campaign. Each player picks their name from this list on their own device, and <b class="players">per player</b> pages then show them their own copy.</p>' +
      '<p>Click a name to rename it; ' + ic('close') + ' removes a player (you choose whether to keep their entries). Add players by name on the right (<kbd>p</kbd>), up to 24.</p>' },

    { section: 'Pages', title: 'Players and referee', target: '.columns', text:
      '<p><b class="players">Players</b> pages go to every player while the session is live. <b class="referee">Referee</b> pages only open on this computer.</p>' +
      '<p>Add <b>.html</b> pages (anything typed in is saved and synced live), <b>.md</b> Markdown pages, <b>.pdf</b> files (form fields sync too) or <b>.png</b> / <b>.jpg</b> images with ' + ic('add') + ' <b>add</b> (<kbd>u</kbd>), or drop them on a column. Drag pages to reorder them, or across to change who they\'re for.</p>' +
      '<p>' + ic('add') + ' <b>add</b> asks what to add: a <b>template</b> (a ready-made page: a character sheet, notes, a tracker, turn order, clocks, party loot or a handout) or a <b>file</b> from this computer.</p>' },
    { section: 'Pages', title: 'Filter by tag', target: '.tagfilter', optional: true, text:
      '<p>Every tag used in the campaign. Pick one or more to show only the pages that have them all; <b>clear filter</b> shows everything again. This device remembers it.</p>' },
    { section: 'Pages', title: 'A page', target: ROW, text:
      '<p>Each page is a card: type, title, description, file name, size and last change. <span class="mg-tag filled">filled in</span> means someone has typed into it.</p>' +
      '<ul><li>' + ic('hidden') + ' <b>hide</b> / ' + ic('view') + ' <b>reveal</b> (players\' pages): whether players get it yet</li>' +
      '<li>' + ic('open') + ' <b>open</b> it on its own, in a new tab</li>' +
      '<li>' + ic('info') + ' <b>info</b>: its details, where it is edited (next)</li>' +
      '<li>' + ic('more') + ' <b>⋯</b>: ' + ic('point') + ' <b>point here</b> (while live), move up or down, move to the other side, clear entries, delete</li></ul>' +
      '<p>Drag a card up or down to reorder the pages (players\' tabs follow), or onto the other column to change who it\'s for. With the keyboard, <kbd>alt</kbd> + <kbd>↑</kbd> <kbd>↓</kbd> moves the focused card.</p>' },
    { section: 'Pages', title: 'Hidden, or for some players', target: '.file[data-name="drowned-letter.html"]', text:
      '<p><span class="mg-tag hidden">' + ic('hidden') + ' hidden</span> pages are kept from every player, name and all, until you reveal them with ' + ic('view') + ' <b>reveal</b>, which waits a few seconds with <b>undo</b> in case of a slip. ' + ic('hidden') + ' <b>hide</b> puts one away at once. While a session is live, pages you add or move to the players start hidden.</p>' +
      '<p><span class="mg-tag only">' + ic('only') + ' only</span> pages are shown to some players: here, only Cass. Who sees a page is set in its <b>info</b>.</p>' +
      '<p>While the session is live, ' + ic('point') + ' <b>point here</b> (in the card\'s ' + ic('more') + ' menu) asks every player who can see a page to look at it now. Their device asks them first; nothing switches by itself.</p>' },
    { section: 'Pages', title: 'A per-player page', target: '.file[data-name="character-sheet.html"] .tagline', text:
      '<p><b class="players">Per player</b>: every player fills in their own copy, seen only by them and you. Each name gets a ' + ic('check') + ' once that player has filled in their copy.</p>' },

    { section: 'Page info', title: 'Details', scene: 'info', target: (d) => d && d.querySelector('.fsec'), text:
      '<p>The <b>info</b> popup of the example\'s <b>Tavern rumours</b> handout.</p>' +
      '<ul><li><b>Title</b>: what tabs and lists call it, if not the page\'s own</li>' +
      '<li><b>File name</b>: rename it; its type stays the same</li>' +
      '<li><b>Description</b>: what it is and when to open it. Players see it, unless it\'s a referee page</li>' +
      '<li><b>Tags</b>: short labels; suggestions come from tags you\'ve used</li></ul>' +
      '<p>Changes are kept only when you press <b>save</b>. Closing with unsaved changes asks first.</p>' },
    { section: 'Page info', title: 'Per player', scene: 'info', target: '.pp-toggle', text:
      '<p>Tick it and every player in the party fills in their own copy instead of sharing one. What\'s already typed in becomes their starting values; turning it off later keeps their copies.</p>' +
      '<p class="mg-muted">Only players\' HTML and PDF pages can be per player.</p>' },
    { section: 'Page info', title: 'Who can see it', scene: 'info', target: ['.vis', '.hide-toggle'], text:
      '<p><b>Every player</b>, or <b>only these players</b> (tick their names). Ticking nobody keeps it for you alone.</p>' +
      '<p><b>Hidden until I reveal it</b> keeps it from everyone while you prepare it; who it goes to once revealed is kept. Players are never told a page is hidden or meant for someone else.</p>' +
      '<p class="mg-muted">Choosing a name on a device is an honour system: anyone can pick any name.</p>' },
    { section: 'Page info', title: 'More, and actions', scene: 'info', target: ['.finfo .fmore', '.finfo .fact-sec', '.mg-dialog-foot'], text:
      '<p><b>More about this page</b> opens its type, size, last change and entries. <b>Actions</b> moves it to the other side, clears its entries, or deletes it (clearing and deleting ask first, and can be undone). At the bottom:</p>' +
      '<ul><li>' + ic('export') + ' <b>export filled</b>: a copy with every entry baked in, which works offline</li>' +
      '<li>' + ic('check') + ' <b>save</b> your changes, or <b>cancel</b></li></ul>' },

    { section: 'Per-player copies', title: 'Party and copies', scene: 'sheet', target: ['#fparty', '#fcopies'], text:
      '<p>A per-player page\'s popup (the example\'s <b>Character sheet</b>) also shows the party, to add or remove players straight away.</p>' +
      '<p>Then every copy: the <b>starting copy</b>, which each new copy starts from, then each player\'s own, with when it last changed. For each: ' + ic('open') + ' <b>open</b>, ' + ic('export') + ' <b>export filled</b> or ' + ic('reset') + ' <b>clear entries</b>.</p>' },

    { section: 'Done', title: 'That\'s the dashboard', target: 'header [data-act="help"]', text:
      '<p>When this tour ends, your own campaigns come back. To get going: create a campaign, add pages and players, then press <b>go live</b>.</p>' +
      '<p>Run it again any time: ' + ic('help') + ' <b>help</b>, then ' + ic('tutorial') + ' <b>referee tutorial</b>.</p>' }
  ];
}

export function tutorial() {
  if (tourRunning()) return;
  const example = exampleSession();
  A.sessions = [example].concat(A.sessions.filter((s) => s.id !== TOUR_ID));
  A.current = example;
  A.selectedId = TOUR_ID;
  app.render();
  startTour({
    name: 'Referee tutorial',
    steps: tourSteps(),
    scenes: {
      join: { label: 'Join Info', from: 'header [data-act="join"]', open: () => { joinOverlay(); return lastDialog(); } },
      info: { label: 'Tavern rumours, info', from: ROW + ' [data-act="file-info"]', open: () => { fileOverlay('shared', 'tavern-rumours.html'); return lastDialog(); } },
      sheet: { label: 'Character sheet, info', from: '.file[data-name="character-sheet.html"] [data-act="file-info"]',
        open: () => { fileOverlay('shared', 'character-sheet.html'); return lastDialog(); } }
    },
    onEnd: () => app.route()   // back to the campaign in the address, with fresh data
  });
}
