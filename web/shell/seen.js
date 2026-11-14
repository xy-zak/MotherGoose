// Which pages this device has opened, per campaign, so tabs can be marked
// new (never opened here) or updated (its file changed since). Kept on this
// device: { fileKey: modified time when last opened }. The first visit to a
// campaign counts everything already there as seen, so a player joining
// late isn't met with a row of dots.
import { fileKey, S } from './state.js';

const seenKey = () => 'mg-seen:' + (S.session ? S.session.id : '');
const stamp = (f) => new Date(f.modified).getTime() || 0;

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(seenKey()) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch (e) { return null; }
}
function write(v) {
  try { localStorage.setItem(seenKey(), JSON.stringify(v)); } catch (e) {}
}

/** primeSeen marks every page as seen on this device's first visit to a campaign. */
export function primeSeen() {
  if (!S.session || read() !== null) return;
  const v = {};
  S.files.forEach((f) => { v[fileKey(f)] = stamp(f); });
  write(v);
}

/** markSeen records that a page was opened, as it is now. */
export function markSeen(f) {
  if (!S.session) return;
  const v = read() || {};
  v[fileKey(f)] = stamp(f);
  // Forget pages that are gone, so the record doesn't grow for ever.
  const live = new Set(S.serverFiles.map(fileKey));
  Object.keys(v).forEach((k) => { if (!live.has(k)) delete v[k]; });
  write(v);
}

/** seenState is 'new', 'updated' or '' for a page. */
export function seenState(f) {
  const v = read();
  if (!v) return '';
  const k = fileKey(f);
  if (!(k in v)) return 'new';
  return stamp(f) > v[k] ? 'updated' : '';
}
