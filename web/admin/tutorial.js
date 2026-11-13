// The referee tutorial. It tours an example session, so every part of the
// page is there to show (a per-player page, a party, both columns) whatever
// the real sessions hold. Nothing in it is saved: the real sessions come back
// when the tour ends.
import { esc, ic, lastDialog } from '/_mg/ui.js';
import { A, app } from './state.js';
import { startTour, tourRunning } from '/_mg/tour.js';
import { joinOverlay, fileOverlay } from './overlays.js';

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

const field = (name) => (d) => { const el = d && d.querySelector('[name="' + name + '"]'); return el && el.closest('.mg-field'); };
const ROW = '.file[data-name="tavern-rumours.html"]';

function tourSteps() {
  const live = A.sessions.find((s) => s.active && s.id !== TOUR_ID);
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
    onEnd: () => app.route()   // back to the session in the address, with fresh data
  });
}
