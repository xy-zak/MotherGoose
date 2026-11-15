// Adding and arranging a session's pages: uploads, files dropped from the
// computer, and pages dragged up and down a column or onto the other one.
// A page dragged within its column is put where the marker shows; dragged to
// the other column, it is moved there and put in that place.
import { api, attempt, enc, esc, ic, overlay, plainError, SCOPE, toast, withIcon } from '/_mg/ui.js';
import { A, app, fileBase } from './state.js';
import { guideOverlay, checkNotes } from './overlays.js';

export async function upload(scope, files) {
  const list = Array.from(files || []);
  if (!list.length || !A.current) return;
  const fd = new FormData();
  fd.append('scope', scope);
  list.forEach((f) => fd.append('files', f, f.name));
  // How far the upload has got, on the column itself; the dashboard doesn't
  // redraw meanwhile, so the bar stays put.
  const col = document.querySelector('.files-panel[data-scope="' + scope + '"]');
  const bar = document.createElement('div');
  bar.className = 'upload-progress';
  bar.setAttribute('role', 'status');
  bar.innerHTML = ic('upload') + '<span class="txt"></span><span class="track"><span class="fill"></span></span>';
  const label = 'Uploading ' + (list.length === 1 ? list[0].name : list.length + ' files');
  bar.querySelector('.txt').textContent = label + '…';
  if (col) col.querySelector('.files').appendChild(bar);
  A.holdRefresh = true;
  let res;
  try {
    res = await send('/api/admin/sessions/' + enc(A.current.id) + '/files', fd, (p) => {
      bar.querySelector('.fill').style.width = Math.round(p * 100) + '%';
      bar.querySelector('.txt').textContent = label + '… ' + Math.round(p * 100) + '%';
    });
  } catch (e) {
    // Nothing was saved: every file was refused. Say why, in full.
    await uploadReport({ saved: [], errors: e.errors || [e.message], warnings: {} }, scope);
    return;
  } finally {
    bar.remove();
    A.holdRefresh = false;
  }
  app.refresh();
  const warned = Object.keys(res.warnings || {});
  if ((res.errors && res.errors.length) || warned.length) { await uploadReport(res, scope); return; }
  const added = res.saved.filter((n) => !(res.replaced || []).includes(n));
  const parts = [];
  if (added.length) parts.push('Added ' + (added.length === 1 ? added[0] : added.length + ' pages') + ' for the ' + SCOPE[scope].label);
  if ((res.replaced || []).length) parts.push('Replaced ' + res.replaced.join(', ') + ' (entries and details kept)');
  if ((res.hidden || []).length) parts.push('hidden, because the session is live: reveal when ready');
  toast(parts.join('. ') + '.');
}

// send uploads a form with XHR, which reports progress (fetch doesn't), and
// resolves with the JSON answer or rejects as api() does.
function send(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let data = null;
      try { data = JSON.parse(x.responseText); } catch (e) {}
      if (x.status >= 200 && x.status < 300) return resolve(data || {});
      const err = new Error(plainError((data && (data.error || (data.errors || [])[0])) || x.statusText));
      if (data && data.errors) err.errors = data.errors.map(plainError);
      reject(err);
    };
    x.onerror = () => reject(new Error(plainError('failed to fetch')));
    x.send(fd);
  });
}

// What happened to an upload when there's more to say than "added": files
// refused (often a page that isn't one file), and pages worth a second look.
async function uploadReport(res, scope) {
  const saved = res.saved || [], errors = (res.errors || []).map(plainError), warnings = res.warnings || {};
  const body =
    (saved.length ? '<p>' + ic('check') + ' Added ' + saved.map((n) => '<b>' + esc(n) + '</b>').join(', ') + ' for the ' + SCOPE[scope].label + '.</p>' : '') +
    (errors.length ? '<div class="mg-section-label">Not added</div><ul class="report bad">' + errors.map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul>' : '') +
    (Object.keys(warnings).length ? '<div class="mg-section-label">Worth a look</div><ul class="report">' +
      Object.keys(warnings).map((n) => '<li><b>' + esc(n) + '</b>' + checkNotes(warnings[n]) + '</li>').join('') + '</ul>' : '') +
    '<p class="mg-muted">Pages must be one file, with everything inside it. <b>Making HTML pages</b> shows how, and can be given to an AI assistant to write pages for you.</p>';
  const v = await overlay({
    title: errors.length ? (saved.length ? 'Some files weren\'t added' : 'Not added') : 'Added, with notes',
    icon: errors.length ? 'warning' : 'info', wide: true, body,
    actions: [{ label: 'Making HTML pages', value: 'guide', icon: 'guide', kind: 'quiet' }, { label: 'OK', value: null, kind: 'primary', icon: 'check' }]
  });
  if (v === 'guide') guideOverlay();
}


const MG_TYPE = 'application/x-mothergoose-file';
const panelAt = (e) => e.target.closest && e.target.closest('.files-panel');
let dragged = null;   // { scope, name, row } while a page is dragged
const isPageDrag = (e) => !!dragged || Array.from(e.dataTransfer.types || []).includes(MG_TYPE);

// Where in a column's list a drop at y lands: the index among the other pages,
// and the y (in the list's own box) to draw the marker at.
// Rows hidden by the tag filter keep their place in the order: the drop
// lands among the rows on screen, and the order sent lists every page.
function dropSpot(col, y) {
  const list = col.querySelector('.files');
  const rows = Array.from(list.querySelectorAll('.file')).filter((r) => r !== (dragged && dragged.row));
  const seen = rows.filter((r) => !r.hidden);
  const top = list.getBoundingClientRect().top;
  let i = seen.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  if (i < 0) i = seen.length;
  let at;
  if (!seen.length) at = 2;
  else if (i < seen.length) at = seen[i].getBoundingClientRect().top - top - 4;
  else at = seen[seen.length - 1].getBoundingClientRect().bottom - top + 2;
  const index = i < seen.length ? rows.indexOf(seen[i]) : seen.length ? rows.indexOf(seen[seen.length - 1]) + 1 : rows.length;
  return { index, rows, at, list };
}

function clearMarks() {
  document.querySelectorAll('.drop-mark').forEach((m) => m.remove());
  document.querySelectorAll('.files-panel.drag').forEach((c) => c.classList.remove('drag'));
}

// Moves (if need be) and orders a dropped page. The row goes to its new place
// at once; the redraw waits until the server has both changes.
let placing = false;   // a dropped page is being saved
async function placePage(fromScope, name, scope, names, spot) {
  placing = true;
  const row = spot.list.closest('#right').querySelector('.file[data-scope="' + fromScope + '"][data-name="' + CSS.escape(name) + '"]');
  if (row) {
    const none = spot.list.querySelector('.none');
    if (none) none.remove();
    spot.list.insertBefore(row, spot.rows[spot.index] || null);
    row.dataset.scope = scope;
  }
  A.holdRefresh = true;
  try {
    if (fromScope !== scope) {
      const r = await api('PATCH', fileBase(A.current, fromScope, name), { scope });
      toast('Moved ' + name + ' to the ' + SCOPE[scope].label + (r && r.hidden ? ': hidden, because the session is live. Reveal it when ready.' : ''));
    }
    await api('PUT', '/api/admin/sessions/' + enc(A.current.id) + '/order', { scope, names });
  } finally {
    placing = false;
    A.holdRefresh = false;
    app.refresh();
  }
}

/** enablePageDrag wires dragging on the session pane (#right). */
export function enablePageDrag(right) {
  right.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.file');
    if (!row) return;
    dragged = { scope: row.dataset.scope, name: row.dataset.name, row };
    A.holdRefresh = true;   // a redraw mid-drag would take the row out from under it
    e.dataTransfer.setData(MG_TYPE, JSON.stringify({ scope: row.dataset.scope, name: row.dataset.name }));
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => row.classList.add('dragging'));   // after the drag image is taken
  });
  right.addEventListener('dragend', () => {
    if (dragged) dragged.row.classList.remove('dragging');
    dragged = null;
    clearMarks();
    // A drop that places the page holds redraws itself until it's saved.
    setTimeout(() => { if (!placing) { A.holdRefresh = false; if (A.refreshQueued) app.refresh(); } }, 0);
  });
  right.addEventListener('dragover', (e) => {
    const col = panelAt(e);
    if (!col) return;
    e.preventDefault();
    document.querySelectorAll('.files-panel.drag').forEach((c) => { if (c !== col) c.classList.remove('drag'); });
    document.querySelectorAll('.drop-mark').forEach((m) => { if (!col.contains(m)) m.remove(); });
    const page = isPageDrag(e);
    // The column is shaded for files from the computer and for pages coming
    // across; a page moving within its own column only gets the marker.
    col.classList.toggle('drag', !page || !dragged || dragged.scope !== col.dataset.scope);
    if (!page) return;
    e.dataTransfer.dropEffect = 'move';
    const spot = dropSpot(col, e.clientY);
    let mark = spot.list.querySelector('.drop-mark');
    if (!mark) {
      mark = document.createElement('div');
      mark.className = 'drop-mark';
      mark.setAttribute('aria-hidden', 'true');
      spot.list.appendChild(mark);
    }
    mark.style.top = spot.at + 'px';
  });
  right.addEventListener('dragleave', (e) => {
    const col = panelAt(e);
    if (col && !col.contains(e.relatedTarget)) {
      col.classList.remove('drag');
      col.querySelectorAll('.drop-mark').forEach((m) => m.remove());
    }
  });
  right.addEventListener('drop', attempt(async (e) => {
    const col = panelAt(e);
    if (!col) return;
    e.preventDefault();
    const scope = col.dataset.scope;
    const raw = e.dataTransfer.getData(MG_TYPE);
    if (!raw) { clearMarks(); await upload(scope, e.dataTransfer.files); return; }
    const f = JSON.parse(raw);
    const spot = dropSpot(col, e.clientY);
    clearMarks();
    const names = spot.rows.map((r) => r.dataset.name);
    names.splice(spot.index, 0, f.name);
    const before = Array.from(col.querySelectorAll('.file')).map((r) => r.dataset.name);
    if (f.scope === scope && names.join('/') === before.join('/')) return;   // put back where it was
    await placePage(f.scope, f.name, scope, names, spot);
  }));

  // Dropping a file outside a panel shouldn't navigate away from the dashboard.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}
