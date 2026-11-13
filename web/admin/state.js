// The referee dashboard's state, shared by its modules. admin.js loads the
// data and draws the page: it fills in A and sets app's functions, which the
// other modules call after they change something.
import { enc, liveTag } from '/_mg/ui.js';

export const A = {
  info: null,          // /api/info: port, LAN addresses, data folder
  sessions: [],        // every session (summaries with files)
  current: null,       // the selected session, or null
  selectedId: null,    // from the URL: #/s/<id>
  pickScope: 'shared', // which column the file picker adds to
  refreshQueued: false,
  holdRefresh: false   // a dragged page is being put in its place: the redraw waits
};

/** Set by admin.js: refetch and redraw, redraw from A, and follow the address. */
export const app = { refresh: async () => {}, render: () => {}, route: () => {} };

export const MAX_PLAYERS = 24;
export const livePort = () => liveTag(A.info ? String(A.info.port) : '');
export const fileCount = (s) => (s.files.shared || []).length + (s.files.gm || []).length;
export const other = (scope) => (scope === 'gm' ? 'shared' : 'gm');
export const fileBase = (s, scope, name) => '/api/admin/sessions/' + enc(s.id) + '/files/' + scope + '/' + enc(name);
export const playersBase = (s) => '/api/admin/sessions/' + enc(s.id) + '/players';
// Who has entries in a per-player page, from the roster's point of view.
export const filledCount = (s, f) => (s.players || []).filter((p) => f.playerState && f.playerState[p.id]).length;
