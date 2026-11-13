// The player view's state, shared by its modules. shell.js loads the data
// and draws the page: it fills in S and sets app's functions, which the other
// modules call.
import { playerName } from '/_mg/ui.js';

export const S = {
  session: null, files: [], isHost: false, serverUp: false,
  serverFiles: [],     // the pages in the referee's order (files is in this device's)
  loaded: false,       // after the first load, a session starting or ending is shown
  players: [],         // the live session's roster: [{ id, name }]
  me: null,            // this device's player id in it, or null
  active: null,        // the open tab: fileKey
  shown: null,         // the frame on screen: frameKey, or null (the "who are you?" panel)
  pick: new Map(),     // referee only: fileKey -> whose copy is shown ('' = the template)
  frames: new Map(),   // frameKey -> iframe
  status: new Map(),   // frameKey -> sync status reported by the page or viewer
  versions: new Map()  // frameKey -> modified time the frame was loaded with (PDFs, images)
};

/** Set by shell.js: redraw, open a tab, reload, full screen, the details overlay. */
export const app = { render: () => {}, show: () => {}, load: async () => {}, setFull: () => {}, detailsOverlay: () => {} };

export const fileKey = (f) => f.scope + '/' + f.name;
// A per-player page has one frame per copy: "shared/sheet.html#ana", and
// "shared/sheet.html#" for the template.
export const frameKey = (f, who) => f.perPlayer ? fileKey(f) + '#' + who : fileKey(f);
export const activeFile = () => S.files.find((f) => fileKey(f) === S.active);
export const meName = () => S.me ? playerName(S.players, S.me) : '';
