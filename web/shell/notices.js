// Telling players about pages: a notice, with "open", for a page that
// appears (added or revealed) or is replaced while they watch, and the prompt
// when the referee asks everyone to look at a page ("show to players"). The
// player always chooses: nothing switches tabs by itself.
import { notice, overlay, titleOf } from '/_mg/ui.js';
import { tourRunning } from '/_mg/tour.js';
import { app, fileKey, S } from './state.js';
import { markSeen } from './seen.js';

const open = new Map();  // fileKey -> closes its notice

/**
 * announce compares the pages before a load (fileKey -> modified) with now,
 * and gives a notice for each new or replaced one, other than the open tab.
 */
export function announce(before) {
  if (tourRunning()) return;
  S.files.forEach((f) => {
    const k = fileKey(f), was = before.get(k);
    if (k === S.active) { if (was !== f.modified) markSeen(f); return; }
    const go = { label: 'open', run: () => app.show(k, true) };
    if (was === undefined) open.set(k, notice({ text: 'New page:', strong: titleOf(f), action: go }));
    else if (was !== f.modified) open.set(k, notice({ text: 'Updated:', strong: titleOf(f), icon: 'reset', action: go }));
  });
}

/** dismissNotice closes a page's notice, once the page is opened. */
export function dismissNotice(key) {
  if (open.has(key)) { open.get(key)(); open.delete(key); }
}

let showing = null;   // the page whose prompt is open, and the dialog showing it
/** onServerMessage handles events other than "changed": "show". */
export async function onServerMessage(m) {
  if (m.type !== 'show' || typeof m.key !== 'string' || S.isHost) return;
  let f = S.files.find((x) => fileKey(x) === m.key);
  if (!f) { await app.load(); f = S.files.find((x) => fileKey(x) === m.key); }   // revealed a moment ago
  if (!f || (showing && showing.key === m.key) || tourRunning()) return;
  if (S.active === m.key && !document.hidden) {
    notice({ text: 'The referee is pointing at this page:', strong: titleOf(f), icon: 'point' });
    return;
  }
  // A newer prompt replaces one still open.
  if (showing && showing.dialog) { showing.replaced = true; showing.dialog.close(); }
  const me = { key: m.key, dialog: null, replaced: false };
  showing = me;
  const body = document.createElement('div');
  body.innerHTML = '<p>The referee wants everyone to look at:</p><p class="show-title"></p>';
  body.querySelector('.show-title').textContent = titleOf(f);
  const v = await overlay({
    title: 'Look at this', icon: 'point', body,
    actions: [{ label: 'later', value: null, kind: 'quiet', icon: 'close' }, { label: 'go to it', value: 'go', kind: 'primary', icon: 'open' }],
    onOpen: (d) => { me.dialog = d; }
  });
  if (showing === me) showing = null;
  if (v === 'go' && S.files.some((x) => fileKey(x) === m.key)) { app.show(m.key, true); return; }
  // "later" (or replaced): the tab keeps a "look" mark until it's opened.
  S.look.add(m.key);
  app.render();
}
