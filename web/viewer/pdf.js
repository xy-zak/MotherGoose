// PDF viewer built on the bundled PDF.js viewer component, so PDFs look and
// work the same on phones (whose browsers often can't show PDFs inside a page)
// as on laptops. PDF.js draws only the pages near the screen and drops the
// rest, which keeps memory in check on phones.
//
// Fillable forms (AcroForm) are shown as real fields. What people type is
// saved and synced live like an HTML page's fields, over the same /ws/file
// protocol, keyed "pdf:<full field name>". The PDF's own scripts (calculated
// fields, formatting) run in PDF.js's scripting sandbox.
//
// Security: this page shares the dashboard's origin, so nothing inside a PDF
// may run here.
// - PDF scripts only run in PDF.js's sandbox: a separate JavaScript engine
//   (QuickJS compiled to WebAssembly) with no access to this page, its DOM,
//   cookies or the network. What comes back is plain field values and
//   properties, applied through PDF.js's own handlers as text, never as HTML.
// - isEvalSupported: false stops PDF.js compiling code (eval / new Function)
//   for font rendering, so nothing derived from a PDF is ever compiled here.
// - XFA forms are off: they would turn PDF content into page markup.
// - src must be a file served by this MotherGoose (/s/…), never another site.
// - Values from other devices only ever set a field's value or selection.
import * as pdfjsLib from '/_mg/vendor/pdfjs-4.10.38/pdf.min.mjs';
import { $, isTyping, popMenu, serverPort } from '/_mg/ui.js';

const LIB = '/_mg/vendor/pdfjs-4.10.38/';
// pdf_viewer.mjs reads the core library from this global, so it must be set
// before that module runs: hence the dynamic import below.
globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + 'pdf.worker.min.mjs';

const pagesEl = $('pages');
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
const MAX_CANVAS_PIXELS = 16e6; // per page; larger canvases crash mobile Safari
const FIT_MAX = 1.6;            // on wide screens "fit" stops here, not at a page a metre wide
const CSS_UNITS = 96 / 72;      // PDF.js scales are in CSS px per 96 dpi; ours are px per point
const PREFIX = 'pdf:';

const params = new URLSearchParams(location.search);
const src = params.get('src') || '';
const player = params.get('player') || '';
const autoExport = params.get('export') === '1';

function fail(msg) {
  const e = $('error');
  e.textContent = msg;
  e.hidden = false;
  pagesEl.hidden = true;
}

// Only pages served by this MotherGoose: never another site.
const allowed = /^\/s\/[^?#]+$/.test(src);
if (!allowed) fail('This viewer only opens PDFs from this MotherGoose server.');
const fileName = (() => { try { return decodeURIComponent(src.split('/').pop()); } catch (e) { return src.split('/').pop(); } })();
$('name').textContent = fileName;
const standalone = window.top === window;
if (standalone) document.body.classList.add('standalone'); // the shell's tab already names it
document.title = fileName + ' · MotherGoose';

// Session, scope and file for /ws/file come from src: /s/<session>/<scope>/<file>.
const cfg = (() => {
  const parts = src.slice(3).split('/');
  if (!allowed || parts.length !== 3) return null;
  try {
    return { session: decodeURIComponent(parts[0]), scope: decodeURIComponent(parts[1]), file: decodeURIComponent(parts[2]) };
  } catch (e) { return null; }
})();

let doc = null;
let viewer = null;
let zoom = 'fit';   // 'fit' or a factor of the page's natural size (CSS px per point)
let pageW = 612;    // natural width, in points, of the page used for "fit"

// ---- notes (XFA warning, export done) ------------------------------------------

let noteTimer = 0;
function note(msg, { icon = 'info', stay = false, error = false } = {}) {
  clearTimeout(noteTimer);
  $('noteText').textContent = msg;
  $('noteIcon').setAttribute('href', '/_mg/icons.svg#' + icon);
  $('note').classList.toggle('err', error);
  $('note').hidden = false;
  if (!stay) noteTimer = setTimeout(() => { $('note').hidden = true; }, 6000);
}
$('noteClose').onclick = () => { $('note').hidden = true; };

// ---- zoom and pages -------------------------------------------------------------

function fitScale() {
  const avail = Math.max(120, pagesEl.clientWidth - (innerWidth > 560 ? 48 : 16));
  return Math.min(avail / pageW, FIT_MAX);
}
const scaleNow = () => (zoom === 'fit' ? fitScale() : zoom);

function applyZoom() {
  if (!viewer || !viewer.pagesCount) return;
  // In a hidden tab nothing is laid out, and PDF.js can't scroll to the page.
  // Showing the tab resizes the frame, and the resize handler zooms then.
  if (!pagesEl.getClientRects().length) return;
  const s = scaleNow();
  if (Math.abs(viewer.currentScale * CSS_UNITS - s) > 1e-4) viewer.currentScale = s / CSS_UNITS;
  showZoom();
}

function showZoom() {
  $('zoom').textContent = viewer && viewer.pagesCount ? Math.round(viewer.currentScale * CSS_UNITS * 100) + '%' : '–';
  $('fit').className = 'mg-btn small' + (zoom === 'fit' ? '' : ' quiet');
  $('fit').setAttribute('aria-pressed', String(zoom === 'fit'));
}

function current() { return viewer ? viewer.currentPageNumber : 1; }

function go(n) {
  if (!viewer || !viewer.pagesCount) return;
  n = Math.max(1, Math.min(viewer.pagesCount, n | 0));
  viewer.currentPageNumber = n;
  $('page').value = n;
}

function setZoom(z) { zoom = z; applyZoom(); }

function stepZoom(dir) {
  const now = scaleNow();
  const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01);
  if (next) setZoom(next);
}

// ---- controls ---------------------------------------------------------------

$('prev').onclick = () => go(current() - 1);
$('next').onclick = () => go(current() + 1);
$('in').onclick = () => stepZoom(1);
$('out').onclick = () => stepZoom(-1);
$('fit').onclick = () => setZoom('fit');
$('export').onclick = () => exportFilled();
$('page').addEventListener('change', (e) => go(parseInt(e.target.value, 10) || 1));
$('page').addEventListener('focus', (e) => e.target.select());

document.addEventListener('keydown', (e) => {
  if (!viewer || !viewer.pagesCount) return;
  // Search opens from anywhere, even a field: Ctrl+F (⌘F) means "find".
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
  if (e.key === 'Escape' && !$('find').hidden && (e.target === $('findInput') || !isTyping(e))) { e.preventDefault(); closeFind(); return; }
  if (e.key === 'Escape' && !$('outline').hidden) { e.preventDefault(); toggleOutline(false); return; }
  // Never while filling in a field, or in the page box.
  if (isTyping(e)) return;
  if (e.key === '/') { e.preventDefault(); openFind(); return; }
  if (e.key === 'o' && !$('outlineBtn').hidden) { e.preventDefault(); toggleOutline(); return; }
  if (e.key === '+' || e.key === '=') stepZoom(1);
  else if (e.key === '-') stepZoom(-1);
  else if (e.key === '0') setZoom('fit');
  else if (e.key === 'n' || e.key === 'j') go(current() + 1);
  else if (e.key === 'p' || e.key === 'k') go(current() - 1);
  else if (e.key === 'e' && fields.size) exportFilled();
  else return;
  e.preventDefault();
});
// ---- touch: pinch to zoom, double tap to step ---------------------------------------
// While two fingers move, the pages are scaled with a CSS transform (cheap);
// when they lift, PDF.js draws the pages at the new zoom, around the same point.

let pinch = null, lastTap = 0;
const fingers = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
function zoomAround(target, x, y) {
  const r = pagesEl.getBoundingClientRect(), before = scaleNow();
  const cx = x - r.left, cy = y - r.top;
  const px = pagesEl.scrollLeft + cx, py = pagesEl.scrollTop + cy;
  setZoom(target);
  const k = scaleNow() / before;
  pagesEl.scrollLeft = px * k - cx;
  pagesEl.scrollTop = py * k - cy;
}
pagesEl.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 2 || !viewer) return;
  const x = (e.touches[0].clientX + e.touches[1].clientX) / 2, y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
  const r = pagesEl.getBoundingClientRect();
  pinch = { d: fingers(e.touches), s: scaleNow(), x, y, k: 1 };
  $('viewer').style.transformOrigin = (pagesEl.scrollLeft + x - r.left) + 'px ' + (pagesEl.scrollTop + y - r.top) + 'px';
}, { passive: true });
pagesEl.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  pinch.k = Math.max(ZOOMS[0] / pinch.s, Math.min(ZOOMS[ZOOMS.length - 1] / pinch.s, fingers(e.touches) / pinch.d));
  $('viewer').style.transform = 'scale(' + pinch.k + ')';
}, { passive: false });
pagesEl.addEventListener('touchend', (e) => {
  if (pinch) {
    const p = pinch;
    pinch = null;
    $('viewer').style.transform = '';
    if (Math.abs(p.k - 1) > 0.03) zoomAround(p.s * p.k, p.x, p.y);
    return;
  }
  // Double tap, not on a form field or link: zoom in a step there, or back to fit.
  if (e.changedTouches.length !== 1 || e.target.closest('input, select, textarea, a, .annotationLayer section')) return;
  const t = Date.now(), pt = e.changedTouches[0];
  if (t - lastTap < 300) {
    e.preventDefault();
    lastTap = 0;
    if (zoom !== 'fit') setZoom('fit');
    else zoomAround(Math.min(ZOOMS[ZOOMS.length - 1], scaleNow() * 2), pt.clientX, pt.clientY);
  } else lastTap = t;
});

// Narrow screens: zoom and export go in a menu, so the toolbar fits.
$('vmore').onclick = () => popMenu($('vmore'), [
  { label: 'zoom in', icon: 'zoom-in', run: () => stepZoom(1) },
  { label: 'zoom out', icon: 'zoom-out', run: () => stepZoom(-1) },
  { label: 'fit to width', icon: 'fit', run: () => setZoom('fit') },
  ...(fields.size ? ['-', { label: 'export filled', icon: 'export', run: () => exportFilled() }] : [])
], { above: true, label: 'More' });

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (zoom === 'fit') applyZoom(); }, 150);
});

// ---- search ------------------------------------------------------------------------
// PDF.js's find controller searches the text of every page and highlights
// the matches in the text layer. A scanned PDF has no text to search.

let findState = null;   // PDF.js's FindState, once the viewer module is in
let textChecked = null; // whether the PDF has any text: null until asked

function openFind() {
  $('find').hidden = false;
  $('findInput').focus();
  $('findInput').select();
  if ($('findInput').value) find('again');
}
function closeFind() {
  $('find').hidden = true;
  if (eventBus) eventBus.dispatch('findbarclose', { source: null });
  pagesEl.focus();
}
function find(type, previous = false) {
  const query = $('findInput').value;
  if (!eventBus) return;
  if (!query.trim()) { $('findCount').textContent = ''; eventBus.dispatch('findbarclose', { source: null }); return; }
  eventBus.dispatch('find', {
    source: null, type, query, caseSensitive: false, entireWord: false,
    highlightAll: true, findPrevious: previous, matchDiacritics: false
  });
}
function showCount(state, count) {
  const el = $('findCount');
  if (state === findState.PENDING) { el.textContent = '…'; return; }
  if (count && count.total) { el.textContent = count.current + ' / ' + count.total; return; }
  if (state === findState.NOT_FOUND) {
    el.textContent = 'no matches';
    noTextCheck();
  }
}
// Says so once, when a search finds nothing in a PDF without text.
async function noTextCheck() {
  if (textChecked !== null) return;
  textChecked = false;
  for (let i = 1; i <= Math.min(3, doc.numPages); i++) {
    const t = await (await doc.getPage(i)).getTextContent().catch(() => null);
    if (t && t.items.some((it) => it.str && it.str.trim())) { textChecked = true; return; }
  }
  $('findCount').textContent = 'no text';
  note("This PDF has no searchable text: it's probably a scan, so its pages are pictures.", { icon: 'warning' });
}
$('findBtn').onclick = () => ($('find').hidden ? openFind() : closeFind());
$('findInput').addEventListener('input', () => find(''));
$('find').addEventListener('submit', (e) => { e.preventDefault(); find('again'); });
$('findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); find('again', true); }
});
$('findPrev').onclick = () => find('again', true);
$('findClose').onclick = closeFind;

// ---- contents (the PDF's outline) -------------------------------------------------------

let linkService = null;
function toggleOutline(open) {
  const el = $('outline');
  const on = open === undefined ? el.hidden : open;
  el.hidden = !on;
  $('outlineBack').hidden = !on;
  $('outlineBtn').setAttribute('aria-pressed', String(on));
  $('outlineBtn').classList.toggle('quiet', !on);
  if (on) { const first = el.querySelector('button.item'); if (first) first.focus(); }
}
async function buildOutline() {
  const items = await doc.getOutline().catch(() => null);
  if (!items || !items.length) return;
  const add = (ul, list, depth) => list.forEach((it) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item';
    b.textContent = (it.title || '').trim() || 'untitled';
    b.addEventListener('click', () => {
      if (it.dest) linkService.goToDestination(it.dest);
      else if (it.url && /^https?:/i.test(it.url)) window.open(it.url, '_blank', 'noopener,noreferrer');
      if (innerWidth <= 700) toggleOutline(false);
    });
    li.appendChild(b);
    if (it.items && it.items.length && depth < 6) {
      const sub = document.createElement('ul');
      add(sub, it.items, depth + 1);
      li.appendChild(sub);
    }
    ul.appendChild(li);
  });
  add($('outlineList'), items, 0);
  $('outlineBtn').hidden = false;
}
$('outlineBtn').onclick = () => toggleOutline();
$('outlineClose').onclick = () => toggleOutline(false);
$('outlineBack').onclick = () => toggleOutline(false);

// ---- form fields ------------------------------------------------------------------
//
// fields: key -> { key, name, type, widgets: [{ id, exportValue }], multi, initial }
// type is PDF.js's: text, checkbox, radiobutton, combobox or listbox.
// Synced values: text and single choice a string, radio the chosen export
// value (null: none), checkbox a bool, multi-select an array of strings.

const fields = new Map();
const keyOfId = new Map();      // widget annotation id -> key
const widgetOf = new Map();     // widget annotation id -> { type, exportValue }
const SYNCED = new Set(['text', 'checkbox', 'radiobutton', 'combobox', 'listbox']);
let storage = null;
let jsMode = false;             // the PDF has scripts, so its fields talk to the sandbox

const known = {};               // key -> value as last read from the fields
const deferred = {};            // key -> remote value waiting for the field to lose focus
let applying = 0;               // >0 while writing remote values into the fields

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const elFor = (id) => document.querySelector('[data-element-id="' + CSS.escape(id) + '"]');
const str = (v) => (v === null || v === undefined ? '' : String(v));
const isOn = (v) => v === true || (typeof v === 'string' && v !== '' && v !== 'Off');

function indexFields(objs) {
  for (const [name, list] of Object.entries(objs || {})) {
    const ws = list.filter((o) => SYNCED.has(o.type) && o.id);
    if (!name || !ws.length) continue;
    const key = PREFIX + name;
    const f = {
      key, name, type: ws[0].type,
      widgets: ws.map((o) => ({ id: o.id, exportValue: o.exportValues })),
      multi: !!ws[0].multipleSelection,
      initial: ws[0].value
    };
    fields.set(key, f);
    for (const w of f.widgets) {
      keyOfId.set(w.id, key);
      widgetOf.set(w.id, { type: f.type, exportValue: w.exportValue });
    }
  }
}

function choiceValue(f, v) {
  if (f.multi) return (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]).map(String).filter((s) => s.trim());
  if (Array.isArray(v)) v = v[0];
  const s = str(v);
  return s.trim() ? s : ''; // PDF.js's placeholder option is " "
}

// The field's current value, from PDF.js's annotation storage (or the PDF's
// own value where nothing has been stored yet).
function read(f) {
  const raw = (id) => { const r = storage.getRawValue(id); return r && 'value' in r ? r : null; };
  switch (f.type) {
    case 'text': {
      for (const w of f.widgets) { const r = raw(w.id); if (r) return str(r.value); }
      return str(f.initial);
    }
    case 'checkbox':
      return f.widgets.some((w) => { const r = raw(w.id); return r ? isOn(r.value) : isOn(f.initial) && f.initial === w.exportValue; });
    case 'radiobutton': {
      for (const w of f.widgets) {
        const r = raw(w.id);
        const v = r ? r.value : f.initial === w.exportValue;
        if (v === true || (typeof v === 'string' && v === w.exportValue)) return w.exportValue;
      }
      return null;
    }
    default: {
      const r = raw(f.widgets[0].id);
      return choiceValue(f, r ? r.value : f.initial);
    }
  }
}

// Every change to a field's value passes through annotationStorage.setValue:
// typing, ticking, PDF calculations and our own remote updates alike.
function hookStorage() {
  const set = storage.setValue.bind(storage);
  storage.setValue = (id, value) => {
    const w = widgetOf.get(id);
    if (w && value && 'value' in value) {
      if (w.type === 'text' && !('formattedValue' in value)) {
        // PDF.js draws (and saves) a text field from formattedValue when there
        // is one; keep it in step with value until the PDF's own formatting
        // says otherwise, so a stale one never wins over what was typed.
        value = { ...value, formattedValue: value.value === null || value.value === undefined ? null : String(value.value) };
      } else if ((w.type === 'checkbox' || w.type === 'radiobutton') && typeof value.value === 'string') {
        // Calculations reach fields on pages not drawn yet as export values;
        // PDF.js's own fields store a tick as a bool (and misread a radio's
        // string when the page is drawn later).
        value = { ...value, value: w.type === 'checkbox' ? isOn(value.value) : value.value === w.exportValue };
      }
    }
    set(id, value);
    const key = keyOfId.get(id);
    if (key) changed(key);
  };
}

function changed(key) {
  const v = read(fields.get(key));
  if (same(v, known[key])) return;
  known[key] = v;
  if (applying) return;
  delete deferred[key];
  if (sync) sync.changed(key);
}

function isFocused(f) {
  const id = document.activeElement && document.activeElement.getAttribute('data-element-id');
  return !!id && f.widgets.some((w) => w.id === id);
}

// ---- writing a value into a field ------------------------------------------------

function write(f, v) {
  applying++;
  try {
    switch (f.type) {
      case 'text': {
        const s = str(v);
        for (const w of f.widgets) {
          const el = elFor(w.id);
          if (el && jsMode) {
            // PDF.js's own handler keeps its view of the field in step.
            el.dispatchEvent(new CustomEvent('updatefromsandbox', { detail: { value: s, formattedValue: null } }));
          } else if (el) {
            el.value = s;
            el.dispatchEvent(new Event('input')); // stores it and clears any stale formatting
            reveal(el);
          } else {
            storage.setValue(w.id, { value: s });
          }
        }
        break;
      }
      case 'checkbox':
      case 'radiobutton': {
        const target = f.type === 'checkbox' ? (isOn(v) ? f.widgets[0].exportValue : null) : (v === null || v === undefined ? null : String(v));
        for (const w of f.widgets) {
          const on = target !== null && w.exportValue === target;
          storage.setValue(w.id, { value: on });
          const el = elFor(w.id);
          if (el) el.checked = on;
        }
        break;
      }
      default: {
        const val = choiceValue(f, v);
        const el = elFor(f.widgets[0].id);
        if (el && jsMode) {
          el.dispatchEvent(new CustomEvent('updatefromsandbox', { detail: { value: val } }));
        } else {
          if (el) {
            const want = new Set(Array.isArray(val) ? val : [val]);
            for (const o of el.options) o.selected = want.has(o.value);
          }
          storage.setValue(f.widgets[0].id, { value: val });
        }
      }
    }
    known[f.key] = read(f);
  } finally {
    applying--;
  }
  toSandbox(f);
}

// A read-only text field is drawn on its own canvas from the PDF's own
// appearance, which knows nothing of saved or synced values: show the field
// itself instead once it has one (as PDF.js does for calculated values).
function reveal(el) {
  if (!el.hidden) return;
  if (el.previousSibling && el.previousSibling.nodeName === 'CANVAS') el.previousSibling.hidden = true;
  el.hidden = false;
}

function revealStored() {
  for (const f of fields.values()) {
    if (f.type !== 'text') continue;
    for (const w of f.widgets) {
      const r = storage.getRawValue(w.id);
      const el = r && 'value' in r && elFor(w.id);
      if (el) reveal(el);
    }
  }
}

// ---- the PDF's scripts ---------------------------------------------------------------
//
// The sandbox keeps its own copy of every field's value, which calculations
// read. It is created with the values restored from the server, and told
// about each later remote change as a committed value, so calculations here
// run on what everyone sees. Their results come back as local changes, and
// are only sent when they differ from what the server already has.

let sandbox = 'none';           // none | creating | ready
const sandboxGap = new Set();   // keys written while the sandbox was being created
let eventBus = null;

function toSandbox(f) {
  if (!jsMode) return;
  if (sandbox === 'creating') { sandboxGap.add(f.key); return; }
  if (sandbox !== 'ready') return;
  const v = known[f.key];
  let id = f.widgets[0].id, value = v;
  if (f.type === 'radiobutton') {
    const w = f.widgets.find((x) => x.exportValue === v);
    if (!w) return; // nothing chosen: there is no event for "none"
    id = w.id; value = true;
  }
  // "Validate" commits the value and runs calculations, without the
  // keystroke filters or click actions a person's own edit would trigger.
  eventBus.dispatch('dispatcheventinsandbox', { source: null, detail: { id, name: 'Validate', value } });
}

// The sandbox reads its starting values from getFieldObjects(): give it the
// restored ones, in the form the PDF itself would hold them.
function withStoredValues(objs) {
  const out = {};
  for (const [name, list] of Object.entries(objs || {})) {
    const f = fields.get(PREFIX + name);
    out[name] = !f ? list : list.map((o) => {
      if (!SYNCED.has(o.type)) return o;
      const v = read(f);
      let value = v;
      if (f.type === 'checkbox') value = v ? f.widgets[0].exportValue : 'Off';
      else if (f.type === 'radiobutton') value = v === null ? 'Off' : v;
      return { ...o, value };
    });
  }
  return out;
}

// ---- sync -------------------------------------------------------------------------
// The connection is createSync, from /_mg/sync.js (loaded before this module):
// the same as HTML pages use. This side reads and writes the fields.

let sync = null;
let firstSnapshot;
const snapshotLoaded = new Promise((r) => { firstSnapshot = r; });
let connectionTried;
const connectionSettled = new Promise((r) => { connectionTried = r; });

function setStatus(s) {
  if (!standalone) {
    try { window.parent.postMessage({ mg: 'status', status: s }, location.origin); } catch (e) {}
    return;
  }
  if (!fields.size) return;
  const el = $('sync');
  el.hidden = false;
  if (s === 'live') {
    el.className = 'vsync mg-live';
    el.textContent = 'LIVE:' + serverPort();
    el.title = 'Saved and synced live';
  } else {
    el.className = 'vsync mg-state ' + (s === 'connecting' ? 'warn' : 'err');
    el.textContent = s;
    el.title = { connecting: 'Connecting…', offline: 'Offline: changes will sync when back', closed: 'This page was closed by the referee' }[s] || s;
  }
}

// A value from the server: another device's change, or the snapshot.
function applyRemote(key, v) {
  const f = fields.get(key);
  if (!f) return;
  if (isFocused(f)) { deferred[key] = v; return; } // don't yank the cursor
  delete deferred[key];
  if (!same(v === null ? emptyOf(f) : v, known[key])) write(f, v);
}

function emptyOf(f) {
  return f.type === 'checkbox' ? false : f.type === 'radiobutton' ? null : f.multi ? [] : '';
}

function flushDeferred() {
  for (const key of Object.keys(deferred)) {
    const f = fields.get(key);
    if (isFocused(f)) continue;
    const v = deferred[key];
    delete deferred[key];
    if (!same(v === null ? emptyOf(f) : v, known[key])) write(f, v);
  }
}

function connect() {
  let q = 'session=' + encodeURIComponent(cfg.session) + '&scope=' + encodeURIComponent(cfg.scope) +
    '&file=' + encodeURIComponent(cfg.file);
  if (player) q += '&player=' + encodeURIComponent(player);
  sync = window.createSync({
    query: q,
    accept: (key) => key.startsWith(PREFIX),
    read: (key) => known[key],
    apply: applyRemote,
    onStatus: setStatus,
    onSnapshot: () => { firstSnapshot(); connectionTried(); },
    onClose: () => connectionTried()
  });
}

document.addEventListener('focusout', () => setTimeout(flushDeferred, 0), true);

// ---- export --------------------------------------------------------------------------

let scripting = null;
let exporting = false;

async function exportFilled() {
  if (!doc || exporting) return false;
  exporting = true;
  $('export').disabled = true;
  try {
    if (sandbox === 'ready') await scripting.dispatchWillSave();
    const bytes = await doc.saveDocument();
    if (sandbox === 'ready') scripting.dispatchDidSave();
    const base = fileName.replace(/\.pdf$/i, '');
    const out = base + (player ? '-' + player : '') + '-filled.pdf';
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = out;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    note('Downloaded ' + out, { icon: 'export' });
    return true;
  } catch (e) {
    console.error('[MotherGoose pdf]', e);
    note("Couldn't export the filled PDF: " + (e && e.message ? e.message : e), { icon: 'warning', stay: true, error: true });
    return false;
  } finally {
    exporting = false;
    $('export').disabled = false;
  }
}

// ---- open ---------------------------------------------------------------------------

async function main() {
  const viewerLib = await import(LIB + 'web/pdf_viewer.mjs');
  const { PDFViewer, EventBus, PDFLinkService, PDFScriptingManager, LinkTarget, PDFFindController, FindState } = viewerLib;
  findState = FindState;
  try {
    doc = await pdfjsLib.getDocument({
      url: src,
      isEvalSupported: false,        // never compile code from inside a PDF
      enableXfa: false,
      standardFontDataUrl: LIB + 'standard_fonts/'
    }).promise;
  } catch (e) {
    fail("Couldn't open this PDF: " + (e && e.message ? e.message : e));
    return;
  }
  $('count').textContent = doc.numPages;
  pageW = (await doc.getPage(1)).getViewport({ scale: 1 }).width;

  const [objs, hasJS, meta] = await Promise.all([doc.getFieldObjects(), doc.hasJSActions(), doc.getMetadata().catch(() => null)]);
  storage = doc.annotationStorage;
  indexFields(objs);
  jsMode = hasJS && fields.size > 0;
  for (const f of fields.values()) known[f.key] = read(f);
  if (fields.size) {
    hookStorage();
    document.querySelectorAll('[data-forms]').forEach((el) => { el.hidden = false; });
  }
  if (meta && meta.info && meta.info.IsXFAPresent) {
    note("This PDF has an XFA form, which MotherGoose doesn't support: some fields may be missing or not work.", { icon: 'warning', stay: true });
  }

  // Restore saved entries before the field layers draw where we can: a LAN
  // round trip is quick, and a slow server only delays the fields' values.
  if (cfg) connect();
  if (cfg && fields.size) {
    await Promise.race([snapshotLoaded, connectionSettled, new Promise((r) => setTimeout(r, 1500))]);
  }

  eventBus = new EventBus();
  linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer nofollow'
  });
  // A radio group's new value comes from the sandbox as the chosen export
  // value, sent to every button of the group; PDF.js then unticks the whole
  // group as each other button handles it. Set the group straight once it's
  // done (registered first, as PDF.js clears the ids as it goes).
  addEventListener('updatefromsandbox', (e) => {
    const d = e.detail;
    const f = d && d.id && 'value' in d && fields.get(keyOfId.get(d.id));
    if (!f || f.type !== 'radiobutton') return;
    const target = typeof d.value === 'string' ? d.value : null;
    queueMicrotask(() => {
      for (const w of f.widgets) {
        const on = w.exportValue === target;
        storage.setValue(w.id, { value: on });
        const el = elFor(w.id);
        if (el) el.checked = on;
      }
    });
  });
  scripting = new PDFScriptingManager({ eventBus, sandboxBundleSrc: LIB + 'pdf.sandbox.min.mjs' });
  // PDF.js starts scripting once the first page is drawn; hold it until the
  // saved entries are in, then hand the sandbox those values.
  const startScripting = scripting.setDocument.bind(scripting);
  const stateReady = Promise.race([snapshotLoaded, connectionSettled, new Promise((r) => setTimeout(r, 3000))]);
  scripting.setDocument = async (d) => {
    if (!d) return startScripting(d);
    if (!jsMode) return undefined; // no scripts: don't load the sandbox at all
    await stateReady;
    const real = d.getFieldObjects;
    d.getFieldObjects = async () => withStoredValues(await real.call(d));
    sandbox = 'creating';
    const p = startScripting(d); // reads the field objects straight away
    d.getFieldObjects = real;
    return p;
  };
  eventBus.on('sandboxcreated', () => {
    sandbox = 'ready';
    for (const key of sandboxGap) toSandbox(fields.get(key));
    sandboxGap.clear();
  });

  const findController = new PDFFindController({ linkService, eventBus });
  eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => showCount(state, matchesCount));
  eventBus.on('updatefindmatchescount', ({ matchesCount }) => showCount(findState.FOUND, matchesCount));
  viewer = new PDFViewer({
    container: pagesEl,
    viewer: $('viewer'),
    eventBus,
    linkService,
    scriptingManager: scripting,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
    annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
    textLayerMode: 1,                // the text layer: search highlights, and text can be selected
    findController,
    removePageBorders: true,
    maxCanvasPixels: MAX_CANVAS_PIXELS,
    imageResourcesPath: LIB + 'web/images/'
  });
  linkService.setViewer(viewer);
  scripting.setViewer(viewer);

  eventBus.on('pagesinit', () => { applyZoom(); pagesEl.scrollTop = 0; }); // keep the top margin in view
  eventBus.on('pagechanging', ({ pageNumber }) => {
    if (document.activeElement !== $('page')) $('page').value = pageNumber;
  });
  eventBus.on('scalechanging', showZoom);
  if (fields.size) eventBus.on('annotationlayerrendered', revealStored);

  viewer.setDocument(doc);
  linkService.setDocument(doc, null);
  findController.setDocument(doc);
  buildOutline();

  if (autoExport) {
    const ok = await Promise.race([snapshotLoaded.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
    if (ok || !cfg) await exportFilled();
    else note("Couldn't load the saved entries, so nothing was downloaded. Try export filled again in a moment.", { icon: 'warning', stay: true, error: true });
  }
}

if (allowed) main().catch((e) => { console.error('[MotherGoose pdf]', e); fail("Couldn't open this PDF: " + (e && e.message ? e.message : e)); });
