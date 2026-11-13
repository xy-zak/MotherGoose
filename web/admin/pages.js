// Adding and arranging a session's pages: uploads, files dropped from the
// computer, and pages dragged up and down a column or onto the other one.
// A page dragged within its column is put where the marker shows; dragged to
// the other column, it is moved there and put in that place.
import { api, attempt, enc, SCOPE, toast } from '/_mg/ui.js';
import { A, app, fileBase } from './state.js';

export async function upload(scope, files) {
  const list = Array.from(files || []);
  if (!list.length || !A.current) return;
  const fd = new FormData();
  fd.append('scope', scope);
  list.forEach((f) => fd.append('files', f, f.name));
  const res = await api('POST', '/api/admin/sessions/' + enc(A.current.id) + '/files', fd);
  let msg = res.saved.length ? 'Added ' + res.saved.length + ' file' + (res.saved.length === 1 ? '' : 's') + ' for the ' + SCOPE[scope].label : '';
  if (res.errors && res.errors.length) msg += (msg ? '. ' : '') + 'Skipped: ' + res.errors.join('; ');
  toast(msg, !res.saved.length);
  app.refresh();
}


const MG_TYPE = 'application/x-mothergoose-file';
const panelAt = (e) => e.target.closest && e.target.closest('.files-panel');
let dragged = null;   // { scope, name, row } while a page is dragged
const isPageDrag = (e) => !!dragged || Array.from(e.dataTransfer.types || []).includes(MG_TYPE);

// Where in a column's list a drop at y lands: the index among the other pages,
// and the y (in the list's own box) to draw the marker at.
function dropSpot(col, y) {
  const list = col.querySelector('.files');
  const rows = Array.from(list.querySelectorAll('.file')).filter((r) => r !== (dragged && dragged.row));
  const top = list.getBoundingClientRect().top;
  let i = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  if (i < 0) i = rows.length;
  let at;
  if (!rows.length) at = 2;
  else if (i < rows.length) at = rows[i].getBoundingClientRect().top - top - 4;
  else at = rows[rows.length - 1].getBoundingClientRect().bottom - top + 2;
  return { index: i, rows, at, list };
}

function clearMarks() {
  document.querySelectorAll('.drop-mark').forEach((m) => m.remove());
  document.querySelectorAll('.files-panel.drag').forEach((c) => c.classList.remove('drag'));
}

// Moves (if need be) and orders a dropped page. The row goes to its new place
// at once; the redraw waits until the server has both changes.
async function placePage(fromScope, name, scope, names, spot) {
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
      await api('PATCH', fileBase(A.current, fromScope, name), { scope });
      toast('Moved ' + name + ' to the ' + SCOPE[scope].label);
    }
    await api('PUT', '/api/admin/sessions/' + enc(A.current.id) + '/order', { scope, names });
  } finally {
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
    e.dataTransfer.setData(MG_TYPE, JSON.stringify({ scope: row.dataset.scope, name: row.dataset.name }));
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => row.classList.add('dragging'));   // after the drag image is taken
  });
  right.addEventListener('dragend', () => {
    if (dragged) dragged.row.classList.remove('dragging');
    dragged = null;
    clearMarks();
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
