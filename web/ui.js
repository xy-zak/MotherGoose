// Shared pieces of the dashboard, the player view and the PDF viewer:
// formatting, the API helper, toasts, overlays (on <dialog>), keyboard
// shortcuts and the live-events connection. Anything two pages need lives
// here, not in a copy in each.

export const $ = (id) => document.getElementById(id);

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

/** titleOf is what a page is called: its <title>, or its file name without the type. */
export const titleOf = (f) => f.title || f.name.replace(/\.[^.]+$/, '');

export const KIND_LABEL = { html: 'page', md: 'md', pdf: 'pdf', image: 'img' };
export const KIND_NAME = { html: 'HTML page', md: 'Markdown page', pdf: 'PDF', image: 'image' };
/** isPage: shown as a web page in its own frame (HTML, and Markdown made into HTML), not in a viewer. */
export const isPage = (f) => f.kind === 'html' || f.kind === 'md';

// ---- icons ----------------------------------------------------------------------
// Iconoir icons from the sprite. ic() alone is decorative; with() pairs an
// icon with its text, so Display settings can show either or both.
export const ic = (name, cls) => '<svg class="mg-i' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="/_mg/icons.svg#' + name + '"></use></svg>';
export const withIcon = (name, text) => ic(name) + '<span class="lbl">' + esc(text) + '</span>';

// ---- words in help text ------------------------------------------------------------
// Terms, file types and on-screen buttons each look different (see theme.css).
export const term = (text, cls) => '<span class="mg-term' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>';
export const ftype = (ext) => '<span class="mg-ftype">' + esc(ext) + '</span>';
export const uiBtn = (icon, text, cls) => '<span class="mg-ui' + (cls ? ' ' + cls : '') + '">' + (icon ? ic(icon) : '') + esc(text) + '</span>';

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

// ---- tags ------------------------------------------------------------------------
/** allTags lists the tags used across pages, once each (ignoring case), sorted. */
export function allTags(files) {
  const seen = new Map();
  files.forEach((f) => (f.tags || []).forEach((t) => { const k = t.toLowerCase(); if (!seen.has(k)) seen.set(k, t); }));
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
/** hasTags: the page has every one of the tags (ignoring case). */
export const hasTags = (f, tags) => tags.every((t) => (f.tags || []).some((x) => x.toLowerCase() === t.toLowerCase()));
/** savedTags is a tag filter kept on this device under key, less tags no page has any more. */
export function savedTags(key, files) {
  const lower = allTags(files).map((t) => t.toLowerCase());
  return savedList(key).filter((t) => lower.includes(t.toLowerCase()));
}
/** toggleTag adds a tag to a filter, or takes it out (ignoring case). */
export function toggleTag(list, tag) {
  const i = list.findIndex((x) => x.toLowerCase() === tag.toLowerCase());
  return i >= 0 ? list.filter((_, j) => j !== i) : list.concat([tag]);
}
/** tagToggles draws a filter's tags as buttons, pressed when in the filter. */
export function tagToggles(tags, filter, attrs = '') {
  const on = new Set(filter.map((t) => t.toLowerCase()));
  return tags.map((t) => '<button type="button" class="mg-chip tf"' + attrs + ' data-tag="' + esc(t) + '" aria-pressed="' + on.has(t.toLowerCase()) + '" title="' +
    (on.has(t.toLowerCase()) ? 'Stop filtering by ' : 'Show only pages tagged ') + esc(t) + '">' + esc(t) + '</button>').join('');
}
/** savedList reads a list kept on this device; saveList keeps one (empty: forgets it). */
export function savedList(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (e) { return []; }
}
export function saveList(key, list) {
  try { if (list.length) localStorage.setItem(key, JSON.stringify(list)); else localStorage.removeItem(key); } catch (e) {}
}

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
export const canPerPlayer = (f) => f.scope === 'shared' && (f.kind === 'html' || f.kind === 'pdf');  // not Markdown
export const hasEntries = (f) => f.kind !== 'image';
export const PER_PLAYER_HINT = 'Per player: each player fills in their own copy, seen only by them and the referee';
/** perPlayerTag marks a per-player page; extra (e.g. "2/3" filled in) follows the label. */
export const perPlayerTag = (extra, hint) => '<span class="mg-tag players" title="' + esc(hint || PER_PLAYER_HINT) + '">' + withIcon('player', 'per player') +
  (extra ? '<span class="extra">' + esc(extra) + '</span>' : '') + '</span>';
/** playerName finds a player's name on a roster, falling back to the id. */
export const playerName = (players, id) => { const p = (players || []).find((x) => x.id === id); return p ? p.name : id; };

// ---- who sees a players' page ----------------------------------------------------------
// A players' page can be hidden until the referee reveals it, and shown only
// to some players. Players are never told either: they just see it or don't.
export const isHidden = (f) => f.scope === 'shared' && !!f.hidden;
export const isOnly = (f) => f.scope === 'shared' && f.audience === 'only';
/** audienceText says who sees a players' page once revealed, in words. */
export function audienceText(f, players) {
  if (!isOnly(f)) return 'every player';
  const names = (f.allowed || []).map((id) => playerName(players, id));
  return names.length ? 'only ' + names.join(', ') : 'no player (only you)';
}
/** visTags marks a players' page that is hidden, or shown only to some players. */
export function visTags(f, players) {
  let out = '';
  if (isHidden(f)) out += '<span class="mg-tag hidden" title="Hidden: no player sees it until you reveal it">' + withIcon('hidden', 'hidden') + '</span>';
  if (isOnly(f)) {
    const names = (f.allowed || []).map((id) => playerName(players, id));
    out += '<span class="mg-tag only" title="' + esc((isHidden(f) ? 'Once revealed, shown to ' : 'Shown to ') + audienceText(f, players)) + '">' +
      withIcon('only', 'only') + '<span class="extra">' + esc(names.length ? names.join(', ') : 'you') + '</span></span>';
  }
  return out;
}

// ---- toasts and notices ---------------------------------------------------------------
// One stack, in the top layer (a popover), so a message shows above any open
// popup: it is shown again each time a message arrives, which puts it on top
// of popups opened since. Timers pause while the page is hidden, so nothing
// expires on a locked tablet.

function messageStack() {
  let s = document.querySelector('.mg-notices');
  if (!s) {
    s = document.createElement('div');
    s.className = 'mg-notices';
    s.setAttribute('aria-live', 'polite');
    if (typeof s.showPopover === 'function') s.setAttribute('popover', 'manual');
    document.body.appendChild(s);
  }
  try {
    if (s.showPopover) {
      if (s.matches(':popover-open')) s.hidePopover();
      s.showPopover();
    }
  } catch (e) { /* not supported: it stays a fixed box */ }
  return s;
}

/** later runs fn after ms of the page being visible; it returns a cancel function. */
function later(ms, fn) {
  let t = 0, done = false;
  const wake = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', wake);
    t = setTimeout(fire, 2500);   // a moment to read it after coming back
  };
  const fire = () => {
    if (done) return;
    if (document.hidden) { document.addEventListener('visibilitychange', wake); return; }
    done = true;
    fn();
  };
  t = setTimeout(fire, ms);
  return () => { done = true; clearTimeout(t); document.removeEventListener('visibilitychange', wake); };
}

/**
 * toast says how something went. A success replaces the one before and goes
 * after a few seconds; an error stays until dismissed, and is announced at once.
 */
export function toast(msg, isError) {
  const stack = messageStack();
  if (!isError) stack.querySelectorAll('.mg-toast:not(.err)').forEach((el) => el.remove());
  while (stack.querySelectorAll('.mg-toast.err').length >= 3) stack.querySelector('.mg-toast.err').remove();
  const el = document.createElement('div');
  el.className = 'mg-toast' + (isError ? ' err' : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.innerHTML = (isError ? ic('warning') : '') + '<span class="msg"></span>' +
    (isError ? '<button type="button" class="mg-btn small quiet x" aria-label="Dismiss" title="Dismiss">' + ic('close') + '</button>' : '');
  el.querySelector('.msg').textContent = msg;
  stack.appendChild(el);
  const close = () => { cancel(); el.remove(); };
  const cancel = isError ? () => {} : later(3500, close);
  if (isError) el.querySelector('.x').addEventListener('click', close);
}

/**
 * notice shows a short message with an optional button, stacked with any
 * others, gone after a few seconds (or when its button or × is pressed).
 *   text:   the message (plain text); strong: a part shown in bold after it
 *   action: { label, icon, run } — the button, which also closes the notice
 *   icon:   shown before the text
 *   ms:     how long it stays (while the page is visible)
 */
export function notice({ text, strong = '', action = null, icon = 'new', ms = 7000 }) {
  const stack = messageStack();
  // A few at most: the oldest go first.
  const pops = stack.querySelectorAll('.mg-notice-pop');
  if (pops.length >= 3) pops[0].remove();
  const el = document.createElement('div');
  el.className = 'mg-notice-pop';
  el.setAttribute('role', 'status');
  el.innerHTML = ic(icon) + '<span class="msg"></span>' +
    (action ? '<button type="button" class="mg-btn small go">' + withIcon(action.icon || 'open', action.label) + '</button>' : '') +
    '<button type="button" class="mg-btn small quiet x" aria-label="Dismiss" title="Dismiss">' + ic('close') + '</button>';
  const msg = el.querySelector('.msg');
  msg.textContent = text;
  if (strong) { const b = document.createElement('b'); b.textContent = ' ' + strong; msg.appendChild(b); }
  const close = () => { cancel(); el.remove(); };
  const cancel = later(ms, close);
  el.querySelector('.x').addEventListener('click', close);
  if (action) el.querySelector('.go').addEventListener('click', () => { close(); action.run(); });
  stack.appendChild(el);
  return close;
}

/**
 * plainError turns what the server or the browser said into a sentence for
 * people: without the store's "invalid: " prefix, and "Can't reach
 * MotherGoose" for a request that never got there.
 */
export function plainError(msg) {
  const m = String(msg || '').replace(/^(invalid|not found|already exists): /, '');
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Can\'t reach MotherGoose: check this device is still on the same network.';
  return m.charAt(0).toUpperCase() + m.slice(1);
}

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch(path, opts); } catch (e) { throw new Error(plainError(e.message)); }
  let data = null;
  if (r.status !== 204) { try { data = await r.json(); } catch (e) {} }
  // An upload where some files were saved is a partial success, not an error.
  if (!r.ok && !(data && data.saved && data.saved.length)) {
    const err = new Error(plainError((data && (data.error || (data.errors || [])[0])) || r.statusText));
    if (data && data.errors) err.errors = data.errors.map(plainError);
    throw err;
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
 *   title:    heading text
 *   body:     HTML string or a Node
 *   actions:  [{ label, value, kind: 'primary'|'danger solid'|'quiet'|'', icon,
 *                href?, download?, side: 'left', more: true, keepOpen: true }]
 *             The footer follows R3: side 'left' actions on the left, "more"
 *             actions in a "more…" menu beside them, the rest on the right.
 *             A link with keepOpen opens without closing the popup.
 *   size:     '' | 'wide' | 'xwide' (wide: true is the same as 'wide')
 *   tone:     'danger' frames the whole overlay in red
 *   onOpen:   called with the dialog element once it is shown
 *   canClose: called with the value it would close with (null for Esc, the
 *             close button or the backdrop); resolve false to keep it open
 */
export function overlay({ title, body, actions = [], tone = '', onOpen, wide = false, size = '', icon = '', canClose = null }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    const sz = size || (wide ? 'wide' : '');
    d.className = 'mg-dialog' + (tone ? ' ' + tone : '') + (sz ? ' ' + sz : '');
    d.innerHTML =
      '<div class="mg-dialog-head">' + (icon ? ic(icon) : '') + '<span class="t"></span>' +
      '<button type="button" class="mg-btn quiet small x" data-close aria-label="Close" title="Close (esc)">' + ic('close') + '</button></div>' +
      '<div class="mg-dialog-body"></div>' +
      (actions.length ? '<div class="mg-dialog-foot"></div>' : '<div style="height:10px"></div>');
    d.querySelector('.t').textContent = title;
    const b = d.querySelector('.mg-dialog-body');
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
    const foot = d.querySelector('.mg-dialog-foot');
    let result = null;
    const choose = (v) => { result = v; d.close(); };
    const button = (a) => {
      const el = document.createElement(a.href ? 'a' : 'button');
      el.className = 'mg-btn ' + (a.kind || '');
      if (a.icon) el.innerHTML = withIcon(a.icon, a.label); else el.textContent = a.label;
      el.title = a.title || a.label;
      if (a.href) {
        el.href = a.href;
        if (a.download) el.setAttribute('download', '');
        else { el.target = '_blank'; el.rel = 'noopener'; }
        if (!a.keepOpen) el.addEventListener('click', () => d.close());
      } else {
        el.type = 'button';
        el.addEventListener('click', () => choose(a.value));
      }
      return el;
    };
    if (foot) {
      const left = document.createElement('div');
      left.className = 'left';
      actions.filter((a) => a.side === 'left' && !a.more).forEach((a) => left.appendChild(button(a)));
      const more = actions.filter((a) => a.more);
      if (more.length) left.appendChild(moreButton(more, choose));
      if (left.children.length) foot.appendChild(left);
      actions.filter((a) => a.side !== 'left' && !a.more).forEach((a) => foot.appendChild(button(a)));
    }
    // The backdrop closes it only for a click that started there too, so a
    // text selection that ends outside the popup doesn't close it.
    let downOnBackdrop = false;
    d.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === d; });
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || (e.target === d && downOnBackdrop)) choose(null);
    });
    // Every way of closing goes through close(): the animated one from
    // prefs.js, after canClose agrees.
    const animatedClose = HTMLDialogElement.prototype.close;
    let allowed = !canClose;
    d.close = function (v) {
      if (allowed) return animatedClose.call(d, v);
      const wanted = result;
      Promise.resolve(canClose(wanted)).then((ok) => {
        if (ok) { allowed = true; result = wanted; animatedClose.call(d, v); }
        else result = null;
      });
    };
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    document.body.appendChild(d);
    d.showModal();
    const first = foot && (foot.querySelector('.primary') || foot.lastElementChild);
    if (first && !first.matches('.danger')) first.focus();
    if (onOpen) onOpen(d);
  });
}

// moreButton is a footer's "more…" button: a menu of the rarer and more
// dangerous actions, so they don't sit next to save.
function moreButton(items, choose) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mg-btn quiet';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.innerHTML = withIcon('more', 'more…');
  btn.title = 'More: ' + items.map((a) => a.label).join(', ');
  btn.addEventListener('click', () => {
    const menu = document.createElement('div');
    menu.className = 'mg-menu';
    menu.setAttribute('role', 'menu');
    if (typeof menu.showPopover === 'function') menu.setAttribute('popover', 'auto');
    items.forEach((a) => {
      const el = document.createElement(a.href ? 'a' : 'button');
      el.setAttribute('role', 'menuitem');
      el.className = /danger/.test(a.kind || '') ? 'danger' : '';
      el.innerHTML = ic(a.icon || 'more') + '<span></span>';
      el.querySelector('span').textContent = a.label;
      if (a.href) {
        el.href = a.href;
        if (a.download) el.setAttribute('download', ''); else { el.target = '_blank'; el.rel = 'noopener'; }
        el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 10px;color:inherit;text-decoration:none';
      } else el.type = 'button';
      el.addEventListener('click', () => { gone(); if (!a.href) choose(a.value); });
      menu.appendChild(el);
    });
    const gone = () => { try { menu.hidePopover(); } catch (e) {} menu.remove(); };
    menu.addEventListener('toggle', (e) => { if (e.newState === 'closed') menu.remove(); });
    btn.closest('dialog').appendChild(menu);
    try { menu.showPopover(); } catch (e) {}
    const r = btn.getBoundingClientRect(), m = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(r.left, innerWidth - m.width - 4)) + 'px';
    menu.style.top = Math.max(4, r.top - m.height - 4) + 'px';
    const first = menu.querySelector('button, a');
    if (first) first.focus();
  });
  return btn;
}

/**
 * confirmDialog asks before something that can't be undone. It resolves
 * true or false; with opts.choice it offers options above the buttons
 * (the first is the default) and resolves with the chosen value, or null.
 *   choice: { label, options: [{ value, label, hint }] }
 *   icon:   the action button's icon
 */
export async function confirmDialog(title, message, actionLabel, opts = {}) {
  // opts.icon: the action's icon (default: delete), so it says what happens.
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
      { label: actionLabel, value: true, kind: 'danger solid', icon: opts.icon || 'delete' }
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

/** lastDialog is the overlay on top, or null. */
export const lastDialog = () => { const all = document.querySelectorAll('dialog[open]'); return all[all.length - 1] || null; };

/** kv lays out [label, value] rows, both HTML, as a definition list. */
export const kv = (rows) => '<dl class="mg-kv">' + rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>';

/** keysList is kv for keyboard shortcuts: [[key, what it does], …]. */
export const keysList = (keys) => kv(keys.map((k) => ['<kbd>' + k[0] + '</kbd>', k[1]]));

// The server sends {"type":"ping"} every 25 s. A socket silent for longer
// than this is taken for dead (Wi-Fi dropped, laptop slept) and replaced,
// rather than waiting minutes for the browser to notice.
export const SILENT_MS = 60000;

/**
 * listenEvents keeps a WebSocket open to /ws/events, reconnecting with
 * backoff. onEvent runs for each "changed" event (and once on every connect),
 * onState(up) whenever the connection opens or drops, and onMessage(m) for
 * any other message, such as "show". It returns { reconnect }, which opens a
 * fresh connection now: the server reads who this device is when it connects.
 */
export function listenEvents(onEvent, onState, onMessage) {
  let retry = 0, current = null;
  function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/events');
    let heard = Date.now(), done = false;
    const watch = setInterval(() => { if (Date.now() - heard > SILENT_MS) drop(); }, 10000);
    const closed = (again = true) => {
      if (done) return;
      done = true;
      clearInterval(watch);
      if (current === conn) current = null;
      if (!again) return;
      onState(false);
      setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry++)));
    };
    const drop = (again = true) => {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try { ws.close(); } catch (e) { /* already closing */ }
      closed(again);
    };
    const conn = { drop };
    current = conn;
    ws.onopen = () => { retry = 0; heard = Date.now(); onState(true); onEvent(); };
    ws.onmessage = (ev) => {
      heard = Date.now();
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { /* not ours */ }
      if (m && m.type === 'ping') return;
      if (m && m.type && m.type !== 'changed') { if (onMessage) onMessage(m); return; }
      onEvent();
    };
    ws.onclose = () => closed();
  }
  connect();
  return {
    reconnect() {
      if (current) current.drop(false);
      retry = 0;
      connect();
    }
  };
}

/** isTyping is true when a key press belongs to a text field, not a shortcut. */
export function isTyping(e) {
  const t = e.target;
  return e.ctrlKey || e.metaKey || e.altKey ||
    (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}

/** shortcutAllowed: a key press is the page's to handle, not a field's or an overlay's. */
export const shortcutAllowed = (e) => !isTyping(e) && !anyOverlayOpen();

export const SHORTCUTS_NOTE = '<p class="mg-muted">Shortcuts work when the page itself doesn\'t have focus: click this bar first.</p>';
