// Shared pieces of the dashboard and player shell: formatting, the API
// helper, toasts, overlays (on <dialog>) and the live-events connection.

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export const enc = encodeURIComponent;

export function ago(iso) {
  const t = new Date(iso).getTime();
  if (!t || t < 0) return 'never';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd';
  return new Date(t).toLocaleDateString();
}

/** agoText is ago() as a phrase: "just now", "5m ago". */
export function agoText(iso) {
  const a = ago(iso);
  if (a === 'now') return 'just now';
  return /^\d+[mhd]$/.test(a) ? a + ' ago' : a; // dates and "never" read fine as they are
}

export function when(iso) {
  const t = new Date(iso);
  return isNaN(t) ? '–' : t.toLocaleString();
}

export function size(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export const KIND_LABEL = { html: 'page', pdf: 'pdf', image: 'img' };
export const KIND_NAME = { html: 'HTML page', pdf: 'PDF', image: 'image' };

// ---- icons ----------------------------------------------------------------------
// Iconoir icons from the sprite. ic() alone is decorative; with() pairs an
// icon with its text, so Display settings can show either or both.
export const ic = (name, cls) => '<svg class="mg-i' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="/_mg/icons.svg#' + name + '"></use></svg>';
export const withIcon = (name, text) => ic(name) + '<span class="lbl">' + esc(text) + '</span>';

// ---- who a page is for -------------------------------------------------------------
// The folders on disk are shared/ and gm/; people see "players" and "referee".
export const SCOPE = {
  shared: { label: 'players', title: 'Players', icon: 'players', cls: 'players' },
  gm: { label: 'referee', title: 'Referee', icon: 'referee', cls: 'referee' }
};
export const scopeTag = (scope) => '<span class="mg-tag ' + SCOPE[scope].cls + '" title="For the ' + SCOPE[scope].label + '">' + withIcon(SCOPE[scope].icon, SCOPE[scope].label) + '</span>';
export const kindTag = (kind) => '<span class="mg-tag kind" title="' + KIND_NAME[kind] + '">' + withIcon('kind-' + kind, KIND_LABEL[kind]) + '</span>';
export const gameTag = (gameType) => gameType ? '<span class="mg-game" title="Game / rules"><span>' + esc(gameType) + '</span></span>' : '';
// "Live" is always shown the same way: LIVE:<port>, filled green.
export const serverPort = () => location.port || (location.protocol === 'https:' ? '443' : '80');
export const liveTag = (port) => '<span class="mg-live" title="The server is running and players can join">LIVE:' + esc(port || serverPort()) + '</span>';
export const chips = (tags) => (tags && tags.length) ? '<span class="mg-chips">' + tags.map((t) => '<span class="mg-chip">' + esc(t) + '</span>').join('') + '</span>' : '';

// Where a page is viewed: HTML directly, PDFs and images in the bundled viewers.
// player picks one player's copy of a per-player page (none: the template).
// The PDF viewer takes it next to src, not inside it: src stays the plain
// file address, which is the same for every copy.
export function viewUrl(sessionId, f, bust, player) {
  const raw = '/s/' + enc(sessionId) + '/' + f.scope + '/' + enc(f.name);
  const who = player ? 'player=' + enc(player) : '';
  if (f.kind === 'pdf' || f.kind === 'image') {
    const v = f.kind === 'pdf' ? 'pdf' : 'image';
    return '/_mg/viewer/' + v + '.html?src=' + enc(raw) + (who && f.kind === 'pdf' ? '&' + who : '') + (bust ? '&v=' + enc(bust) : '');
  }
  return raw + (who ? '?' + who : '');
}

/**
 * filledUrl downloads a copy with the entries baked in (referee only).
 * HTML is exported by the server; a PDF is filled in by the viewer, which
 * downloads it by itself once its fields are loaded (so it opens in a tab).
 */
export function filledUrl(sessionId, f, player) {
  if (f.kind === 'pdf') return viewUrl(sessionId, f, '', player) + '&export=1';
  return '/api/admin/sessions/' + enc(sessionId) + '/files/' + f.scope + '/' + enc(f.name) + '/export' + (player ? '?player=' + enc(player) : '');
}

// ---- per-player pages ----------------------------------------------------------------
// Players' HTML and PDF pages can be marked "per player": every player on the
// session's roster fills in their own copy, seen only by them and the referee.
export const canPerPlayer = (f) => f.scope === 'shared' && (f.kind === 'html' || f.kind === 'pdf');
export const hasEntries = (f) => f.kind !== 'image';
export const PER_PLAYER_HINT = 'Per player: each player fills in their own copy, seen only by them and the referee';
/** perPlayerTag marks a per-player page; extra (e.g. "2/3" filled in) follows the label. */
export const perPlayerTag = (extra, hint) => '<span class="mg-tag players" title="' + esc(hint || PER_PLAYER_HINT) + '">' + withIcon('player', 'per player') +
  (extra ? '<span class="extra">' + esc(extra) + '</span>' : '') + '</span>';
/** playerName finds a player's name on a roster, falling back to the id. */
export const playerName = (players, id) => { const p = (players || []).find((x) => x.id === id); return p ? p.name : id; };

let toastTimer;
export function toast(msg, isError) {
  let el = document.querySelector('.mg-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'mg-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('err', !!isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
}

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, opts);
  let data = null;
  if (r.status !== 204) { try { data = await r.json(); } catch (e) {} }
  // An upload where some files were saved is a partial success, not an error.
  if (!r.ok && !(data && data.saved && data.saved.length)) {
    throw new Error((data && (data.error || (data.errors || []).join('; '))) || r.statusText);
  }
  return data;
}

// attempt wraps an async handler so a failure shows as a toast.
export function attempt(fn) {
  return function (...args) {
    return Promise.resolve(fn.apply(this, args)).catch((e) => toast(e.message, true));
  };
}

/**
 * overlay shows a modal panel and resolves with the value of the action
 * pressed, or null when it is closed (Esc, the close button, the backdrop).
 *   title:   heading text
 *   body:    HTML string or a Node
 *   actions: [{ label, value, kind: 'primary'|'danger solid'|'quiet'|'', href?, download? }]
 *   tone:    'danger' frames the whole overlay in red
 *   onOpen:  called with the dialog element once it is shown
 */
export function overlay({ title, body, actions = [], tone = '', onOpen, wide = false, icon = '' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'mg-dialog' + (tone ? ' ' + tone : '');
    if (wide) d.style.width = 'min(760px, calc(100vw - 24px))';
    d.innerHTML =
      '<div class="mg-dialog-head">' + (icon ? ic(icon) : '') + '<span class="t"></span>' +
      '<button type="button" class="mg-btn quiet small" data-close aria-label="Close">esc</button></div>' +
      '<div class="mg-dialog-body"></div>' +
      (actions.length ? '<div class="mg-dialog-foot"></div>' : '<div style="height:10px"></div>');
    d.querySelector('.t').textContent = title;
    const b = d.querySelector('.mg-dialog-body');
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
    const foot = d.querySelector('.mg-dialog-foot');
    let result = null;
    actions.forEach((a) => {
      const el = document.createElement(a.href ? 'a' : 'button');
      el.className = 'mg-btn ' + (a.kind || '');
      if (a.icon) el.innerHTML = withIcon(a.icon, a.label); else el.textContent = a.label;
      el.title = a.label;
      if (a.href) {
        el.href = a.href;
        if (a.download) el.setAttribute('download', '');
        else { el.target = '_blank'; el.rel = 'noopener'; }
        el.addEventListener('click', () => d.close());
      } else {
        el.type = 'button';
        el.addEventListener('click', () => { result = a.value; d.close(); });
      }
      foot.appendChild(el);
    });
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || e.target === d) d.close();
    });
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    document.body.appendChild(d);
    d.showModal();
    const first = foot && (foot.querySelector('.primary, .danger') || foot.lastElementChild);
    if (first && !first.matches('.danger')) first.focus();
    if (onOpen) onOpen(d);
  });
}

/**
 * confirmDialog asks before something that can't be undone. It resolves
 * true or false; with opts.choice it offers options above the buttons
 * (the first is the default) and resolves with the chosen value, or null.
 *   choice: { label, options: [{ value, label, hint }] }
 */
export async function confirmDialog(title, message, actionLabel, opts = {}) {
  const c = opts.choice;
  const choice = c ? '<fieldset class="mg-choice"><legend>' + esc(c.label) + '</legend>' + c.options.map((o, i) =>
    '<label><input type="radio" name="mg-choice" value="' + esc(o.value) + '"' + (i === 0 ? ' checked' : '') + '>' +
    '<span><b>' + esc(o.label) + '</b>' + (o.hint ? '<span class="hint">' + esc(o.hint) + '</span>' : '') + '</span></label>').join('') + '</fieldset>' : '';
  let picked = null;
  const v = await overlay({
    title,
    tone: 'danger',
    icon: 'warning',
    body: '<p>' + esc(message) + '</p>' + choice,
    actions: [
      { label: 'cancel', value: false, kind: 'quiet', icon: 'close' },
      { label: actionLabel, value: true, kind: 'danger solid', icon: 'delete' }
    ],
    onOpen: (d) => {
      if (!c) return;
      const read = () => { const r = d.querySelector('input[name="mg-choice"]:checked'); picked = r ? r.value : null; };
      d.addEventListener('change', read);
      read();
    }
  });
  if (c) return v === true ? picked : null;
  return v === true;
}

/**
 * formOverlay asks for a few values and resolves with { name: value } when
 * submitted, or null when closed. Enter submits from a single-line field.
 *   fields: [{ name, label, value, hint, max, multiline, list: [suggestions], required, placeholder }]
 *           or { name, label, hint, type: 'checkbox', checked, icon } (resolves true / false)
 */
export function formOverlay({ title, icon, fields, submitLabel = 'save', submitIcon = 'check' }) {
  const form = document.createElement('form');
  form.className = 'mg-dialog-body';
  form.style.padding = '0';
  form.innerHTML = fields.map((f, i) => {
    const id = 'mgf-' + f.name;
    if (f.type === 'checkbox') {
      return '<label class="mg-field check" for="' + id + '"><input type="checkbox" id="' + id + '" name="' + f.name + '"' + (f.checked ? ' checked' : '') + '>' +
        '<span>' + (f.icon ? ic(f.icon) : '') + esc(f.label) + (f.hint ? ' <span class="hint">' + esc(f.hint) + '</span>' : '') + '</span></label>';
    }
    const attrs = 'class="mg-input" id="' + id + '" name="' + f.name + '"' + (f.max ? ' maxlength="' + f.max + '"' : '') +
      (f.required ? ' required' : '') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') +
      (f.list ? ' list="' + id + '-list" autocomplete="off"' : '') + (i === 0 ? ' autofocus' : '');
    const input = f.multiline
      ? '<textarea ' + attrs + '>' + esc(f.value || '') + '</textarea>'
      : '<input ' + attrs + ' value="' + esc(f.value || '') + '">';
    const list = f.list ? '<datalist id="' + id + '-list">' + f.list.map((o) => '<option value="' + esc(o) + '">').join('') + '</datalist>' : '';
    return '<label class="mg-field" for="' + id + '"><span>' + esc(f.label) + (f.hint ? ' <span class="hint">' + esc(f.hint) + '</span>' : '') + '</span>' + input + list + '</label>';
  }).join('') + '<button type="submit" hidden></button>';
  let values = null;
  return overlay({
    title, icon, body: form,
    actions: [{ label: 'cancel', value: null, kind: 'quiet', icon: 'close' }, { label: submitLabel, value: 'submit', kind: 'primary', icon: submitIcon }],
    onOpen: (d) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        values = Object.fromEntries(new FormData(form).entries());
        fields.forEach((f) => { if (f.type === 'checkbox') values[f.name] = form.elements[f.name].checked; });
        d.close();
      });
      // The footer's submit button lives outside the form: route it through.
      const btn = d.querySelector('.mg-dialog-foot .primary');
      btn.addEventListener('click', (e) => { e.stopImmediatePropagation(); form.requestSubmit(); }, { capture: true });
      const first = form.querySelector('.mg-input');
      if (first) { first.focus(); if (first.select) first.select(); }
    }
  }).then(() => values);
}

/** Splits "map, dungeon , level 2" into tags. */
export const parseTags = (s) => String(s || '').split(',').map((t) => t.trim()).filter(Boolean);

export function anyOverlayOpen() {
  return !!document.querySelector('dialog[open]');
}

/**
 * listenEvents keeps a WebSocket open to /ws/events, reconnecting with
 * backoff. onEvent runs for each server event (and once on every connect),
 * onState(up) whenever the connection opens or drops.
 */
export function listenEvents(onEvent, onState) {
  let retry = 0;
  (function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/events');
    ws.onopen = () => { retry = 0; onState(true); onEvent(); };
    ws.onmessage = () => onEvent();
    ws.onclose = () => {
      onState(false);
      setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry++)));
    };
  })();
}

/** isTyping is true when a key press belongs to a text field, not a shortcut. */
export function isTyping(e) {
  const t = e.target;
  return e.ctrlKey || e.metaKey || e.altKey ||
    (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}

export const SHORTCUTS_NOTE = '<p class="mg-muted">Shortcuts work when the page itself doesn\'t have focus: click this bar first.</p>';
