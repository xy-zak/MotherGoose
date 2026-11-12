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

const LIB = '/_mg/vendor/pdfjs-4.10.38/';
// pdf_viewer.mjs reads the core library from this global, so it must be set
// before that module runs: hence the dynamic import below.
globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + 'pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
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

const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
document.addEventListener('keydown', (e) => {
  // Never while filling in a field, or in the page box.
  if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || !viewer || !viewer.pagesCount) return;
  if (e.key === '+' || e.key === '=') stepZoom(1);
  else if (e.key === '-') stepZoom(-1);
  else if (e.key === '0') setZoom('fit');
  else if (e.key === 'n' || e.key === 'j') go(current() + 1);
  else if (e.key === 'p' || e.key === 'k') go(current() - 1);
  else if (e.key === 'e' && fields.size) exportFilled();
  else return;
  e.preventDefault();
});
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (zoom === 'fit') applyZoom(); }, 150);
});

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
const lastSeen = {};            // key -> value last received from, or sent to, the server
const deferred = {};            // key -> remote value waiting for the field to lose focus
let outbox = new Set();         // keys changed here, not yet sent
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
  queueSend(key);
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

let ws = null, synced = false, retry = 0, gone = false;
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
    el.textContent = 'LIVE:' + (location.port || (location.protocol === 'https:' ? '443' : '80'));
    el.title = 'Saved and synced live';
  } else {
    el.className = 'vsync mg-state ' + (s === 'connecting' ? 'warn' : 'err');
    el.textContent = s;
    el.title = { connecting: 'Connecting…', offline: 'Offline: changes will sync when back', closed: 'This page was closed by the referee' }[s] || s;
  }
}

function applyRemote(key, v) {
  if (v === undefined) v = null;
  lastSeen[key] = v;
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

function applySnapshot(snap) {
  for (const [key, v] of Object.entries(snap)) {
    if (!key.startsWith(PREFIX)) continue;
    if (outbox.has(key) && !same(known[key], v)) { lastSeen[key] = v; continue; } // our unsent edit wins
    applyRemote(key, v);
  }
}

let sendTimer = 0;
function queueSend(key) {
  if (!cfg) return;
  outbox.add(key);
  if (!sendTimer) sendTimer = setTimeout(flush, 200);
}

function flush() {
  sendTimer = 0;
  if (!ws || ws.readyState !== 1 || !synced) return;
  for (const key of outbox) {
    const v = known[key];
    // Never echo what the server already has: devices running the same
    // calculations would otherwise bounce results back and forth.
    if (same(v, lastSeen[key])) continue;
    lastSeen[key] = v;
    ws.send(JSON.stringify({ type: 'set', key, value: v === undefined ? null : v }));
  }
  outbox = new Set();
}

function connect() {
  setStatus('connecting');
  let q = 'session=' + encodeURIComponent(cfg.session) + '&scope=' + encodeURIComponent(cfg.scope) +
    '&file=' + encodeURIComponent(cfg.file);
  if (player) q += '&player=' + encodeURIComponent(player);
  ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/file?' + q);
  ws.onopen = () => { retry = 0; };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'snapshot') {
      synced = true;
      applySnapshot(m.state || {});
      setStatus('live');
      flush();
      firstSnapshot();
      connectionTried();
    } else if (m.type === 'set') {
      if (typeof m.key === 'string' && m.key.startsWith(PREFIX)) applyRemote(m.key, m.value);
    } else if (m.type === 'reload') {
      location.reload();
    } else if (m.type === 'gone') {
      gone = true;
      setStatus('closed');
    }
  };
  ws.onclose = () => {
    ws = null;
    synced = false;
    connectionTried();
    if (gone) return;
    setStatus('offline');
    setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry++)));
  };
}

document.addEventListener('focusout', () => setTimeout(flushDeferred, 0), true);
addEventListener('pagehide', flush);

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
  const { PDFViewer, EventBus, PDFLinkService, PDFScriptingManager, LinkTarget } = viewerLib;
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
  const linkService = new PDFLinkService({
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

  viewer = new PDFViewer({
    container: pagesEl,
    viewer: $('viewer'),
    eventBus,
    linkService,
    scriptingManager: scripting,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
    annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
    textLayerMode: 0,                // as before: pages are pictures, not selectable text
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

  if (autoExport) {
    const ok = await Promise.race([snapshotLoaded.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
    if (ok || !cfg) await exportFilled();
    else note("Couldn't load the saved entries, so nothing was downloaded. Try export filled again in a moment.", { icon: 'warning', stay: true, error: true });
  }
}

if (allowed) main().catch((e) => { console.error('[MotherGoose pdf]', e); fail("Couldn't open this PDF: " + (e && e.message ? e.message : e)); });
