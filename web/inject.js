/*
 * MotherGoose page sync.
 *
 * Injected into every game page the server sends. It saves what people type
 * into inputs, textareas, selects and contenteditable elements, restores it
 * on load, and keeps every open copy of the page in sync over a WebSocket.
 * The connection itself is createSync, from sync.js: the server serves the
 * two as one script (see pages.go).
 *
 * In an exported ("filled") copy there is no server: the saved values are
 * restored from the embedded #mg-state block and nothing is sent anywhere.
 *
 * Page authors can opt elements out with data-mg-ignore, and persist custom
 * state with window.MotherGoose.get / set / on.
 */
(function () {
  'use strict';
  if (window.MotherGoose) return;

  var me = document.currentScript;
  var cfg = me && me.dataset && me.dataset.mgSession
    ? { session: me.dataset.mgSession, scope: me.dataset.mgScope, file: me.dataset.mgFile, player: me.dataset.mgPlayer || '' }
    : null;

  var state = {};
  try {
    var boot = document.getElementById('mg-state');
    if (boot) state = JSON.parse(boot.textContent) || {};
  } catch (e) { state = {}; }

  var SKIP = { file: 1, password: 1, submit: 1, button: 1, reset: 1, image: 1, hidden: 1 };
  var EDITABLE = '[contenteditable]:not([contenteditable="false"])';
  var CUSTOM = 'custom:';

  var applying = 0;       // >0 while we change fields ourselves
  var keyOf = new WeakMap();
  var elsOf = {};          // key -> [elements]
  var seenEls = new WeakSet();
  var deferred = {};       // keys with remote changes waiting for blur
  var listeners = {};
  var sync = null;         // the connection (none in an exported copy)
  var status = cfg ? 'connecting' : 'offline-copy';

  // ---- which elements, and how they are keyed ------------------------------

  function isEditableRoot(el) {
    if (!el.matches(EDITABLE)) return false;
    var p = el.parentElement;
    return !(p && p.closest(EDITABLE));
  }

  function tracked(el) {
    if (el.closest('[data-mg-ignore]')) return false;
    var tag = el.tagName;
    if (tag === 'INPUT') return !SKIP[(el.getAttribute('type') || 'text').toLowerCase()];
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return isEditableRoot(el);
  }

  function domPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      var i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ':' + i);
      el = el.parentElement;
    }
    return parts.join('>');
  }

  function baseKey(el) {
    if (el.tagName === 'INPUT' && el.type === 'radio' && el.name) return 'radio:' + el.name;
    if (el.id) return '#' + el.id;
    var n = el.getAttribute('name');
    if (n) return 'name:' + n;
    return 'path:' + domPath(el);
  }

  function index() {
    var counts = {}, map = {};
    var els = document.querySelectorAll('input, textarea, select, ' + EDITABLE);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!tracked(el)) continue;
      var k = baseKey(el);
      if (k.indexOf('radio:') === 0) {
        (map[k] = map[k] || []).push(el);
      } else {
        counts[k] = (counts[k] || 0) + 1;
        if (counts[k] > 1) k += '~' + counts[k];
        map[k] = [el];
      }
      keyOf.set(el, k);
    }
    elsOf = map;
  }

  // ---- reading and writing values ------------------------------------------

  function readValue(key) {
    var els = elsOf[key];
    if (!els) return undefined;
    var el = els[0];
    if (key.indexOf('radio:') === 0) {
      for (var i = 0; i < els.length; i++) if (els[i].checked) return els[i].value;
      return null;
    }
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
    if (el.tagName === 'SELECT' && el.multiple) {
      return Array.prototype.filter.call(el.options, function (o) { return o.selected; })
        .map(function (o) { return o.value; });
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return el.value;
    return el.innerHTML;
  }

  // ---- cleaning synced HTML ------------------------------------------------
  //
  // An editable area's value is HTML, and it can come from any device on the
  // network. Inserted as-is, <img onerror=…> would run a player's script on
  // every device viewing the page, including the host, which can open the
  // dashboard. So remote HTML is parsed into an inert <template>, filtered
  // against an allowlist of formatting tags and attributes, and the cleaned
  // nodes are inserted directly (never re-parsed from a string).

  var KEEP_TAGS = {};
  ('A ABBR B BDI BDO BLOCKQUOTE BR CAPTION CENTER CITE CODE COL COLGROUP DD DEL DFN DIV DL DT EM ' +
   'FIGCAPTION FIGURE FONT H1 H2 H3 H4 H5 H6 HR I IMG INS KBD LI MARK OL P PRE Q RP RT RUBY S SAMP ' +
   'SMALL SPAN STRIKE STRONG SUB SUP TABLE TBODY TD TFOOT TH THEAD TIME TR TT U UL VAR WBR')
    .split(' ').forEach(function (t) { KEEP_TAGS[t] = 1; });
  // Removed together with everything inside them. Unknown tags not listed
  // here are unwrapped instead: the tag goes, its text stays.
  var DROP_TAGS = {};
  ('APPLET AUDIO BASE BUTTON CANVAS DATALIST DIALOG EMBED FORM FRAME FRAMESET IFRAME INPUT LINK MATH ' +
   'META NOEMBED NOFRAMES NOSCRIPT OBJECT OPTGROUP OPTION PARAM PICTURE PLAINTEXT PORTAL SCRIPT SELECT ' +
   'SLOT SOURCE STYLE SVG TEMPLATE TEXTAREA TITLE TRACK VIDEO XMP')
    .split(' ').forEach(function (t) { DROP_TAGS[t] = 1; });
  var KEEP_ATTRS = {
    '*': { 'class': 1, style: 1, title: 1, dir: 1, lang: 1, align: 1 },
    A: { href: 1 },
    FONT: { color: 1, face: 1, size: 1 },
    IMG: { src: 1, alt: 1, width: 1, height: 1 },
    OL: { start: 1, type: 1, reversed: 1 },
    LI: { value: 1 },
    TD: { colspan: 1, rowspan: 1 },
    TH: { colspan: 1, rowspan: 1, scope: 1 },
    COL: { span: 1 },
    COLGROUP: { span: 1 },
    TIME: { datetime: 1 }
  };
  var HAS_SCHEME = /^[a-z][a-z0-9+.\-]*:/i;
  var SAFE_SCHEME = /^(?:https?|mailto|tel):/i;
  var IGNORED_IN_URL = /[\x00-\x20\x7f]/g;  // browsers skip these, so "java\tscript:" still runs
  var SAFE_IMG = /^data:image\/(?:png|gif|jpe?g|webp|avif|bmp);/i;  // inline only: no beacons, no SVG
  // No external fetches, no escapes to hide them, and nothing that lifts
  // content out of the field to cover the rest of the page.
  var UNSAFE_STYLE = /url\s*\(|expression\s*\(|javascript:|@import|\\|position\s*:/i;

  function cleanAttrs(el) {
    var tag = el.nodeName.toUpperCase();
    Array.prototype.slice.call(el.attributes).forEach(function (a) {
      var n = a.name.toLowerCase(), v = a.value;
      var ok = KEEP_ATTRS['*'][n] || (KEEP_ATTRS[tag] && KEEP_ATTRS[tag][n]);
      if (ok && n === 'href') {
        var u = v.replace(IGNORED_IN_URL, '');
        ok = !HAS_SCHEME.test(u) || SAFE_SCHEME.test(u);
      }
      if (ok && n === 'src') ok = SAFE_IMG.test(v.trim());
      if (ok && n === 'style') ok = !UNSAFE_STYLE.test(v);
      if (!ok) el.removeAttribute(a.name);
    });
    if (tag === 'A' && el.hasAttribute('href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }

  function cleanTree(parent) {
    var node = parent.firstChild;
    while (node) {
      var next = node.nextSibling;
      if (node.nodeType === 1) {
        var tag = node.nodeName.toUpperCase();
        if (DROP_TAGS[tag] || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
          parent.removeChild(node);
        } else if (!KEEP_TAGS[tag]) {
          cleanTree(node);  // unwrap: keep its (already cleaned) children
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          parent.removeChild(node);
        } else {
          cleanAttrs(node);
          cleanTree(node);
        }
      } else if (node.nodeType !== 3) {
        parent.removeChild(node);  // comments, processing instructions
      }
      node = next;
    }
  }

  /** Parses untrusted HTML into a cleaned DocumentFragment. */
  function cleanFragment(html) {
    var t = document.createElement('template');
    t.innerHTML = html;  // template content is inert: nothing loads or runs
    cleanTree(t.content);
    return t.content;
  }

  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function writeValue(key, v) {
    var els = elsOf[key];
    if (!els) return;
    var changed = [];
    applying++;
    try {
      var el = els[0];
      if (key.indexOf('radio:') === 0) {
        els.forEach(function (r) {
          var on = v !== null && v !== undefined && r.value === String(v);
          if (r.checked !== on) { r.checked = on; changed.push(r); }
        });
      } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        if (el.checked !== !!v) { el.checked = !!v; changed.push(el); }
      } else if (el.tagName === 'SELECT' && el.multiple) {
        var want = Array.isArray(v) ? v.map(String) : [];
        Array.prototype.forEach.call(el.options, function (o) { o.selected = want.indexOf(o.value) >= 0; });
        changed.push(el);
      } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        var s = v === null || v === undefined ? '' : String(v);
        if (el.value !== s) { el.value = s; changed.push(el); }
      } else {
        var frag = cleanFragment(v === null || v === undefined ? '' : String(v));
        var probe = document.createElement('div');
        probe.appendChild(frag.cloneNode(true));
        if (el.innerHTML !== probe.innerHTML) {
          while (el.firstChild) el.removeChild(el.firstChild);
          el.appendChild(document.importNode(frag, true));
          changed.push(el);
        }
      }
      changed.forEach(fire);
    } finally {
      applying--;
    }
  }

  function isFocused(key) {
    var a = document.activeElement;
    return !!a && (elsOf[key] || []).some(function (el) { return el === a || el.contains(a); });
  }

  function emit(name, v) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(v); } catch (e) { console.error('[MotherGoose]', e); }
    });
  }

  function setLocal(key, v) {
    if (v === null || v === undefined) delete state[key]; else state[key] = v;
  }

  // A value from the server: another device's change, or the snapshot.
  function applyRemote(key, v) {
    if (key.indexOf(CUSTOM) === 0) {
      var was = JSON.stringify(state[key] === undefined ? null : state[key]);
      setLocal(key, v);
      if (was !== JSON.stringify(v)) emit(key.slice(CUSTOM.length), v);
      return;
    }
    setLocal(key, v);
    if (!elsOf[key]) index();
    if (isFocused(key)) { deferred[key] = true; return; } // don't yank the cursor
    writeValue(key, v);
  }

  function flushDeferred() {
    Object.keys(deferred).forEach(function (key) {
      if (isFocused(key)) return;
      delete deferred[key];
      writeValue(key, state[key]);
    });
  }

  // ---- local edits ----------------------------------------------------------

  function onLocal(e) {
    if (applying) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    if (el.closest(EDITABLE) && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      while (el.parentElement && el.parentElement.closest(EDITABLE)) el = el.parentElement.closest(EDITABLE);
    }
    if (!keyOf.has(el)) index();
    if (!keyOf.has(el) || !tracked(el)) return;
    var key = keyOf.get(el);
    setLocal(key, readValue(key));
    delete deferred[key];
    if (sync) sync.changed(key);
  }

  // ---- connection -----------------------------------------------------------

  function setStatus(s) {
    status = s;
    if (s === 'offline-copy') return;
    if (window.parent !== window) {
      try { window.parent.postMessage({ mg: 'status', file: cfg && cfg.file, player: (cfg && cfg.player) || null, status: s }, location.origin); } catch (e) {}
    } else {
      badge(s);
    }
  }

  var badgeEl = null;
  function badge(s) {
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.setAttribute('data-mg-ignore', '');
      badgeEl.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483647;width:10px;height:10px;' +
        'border-radius:50%;border:2px solid #8839ef;box-sizing:border-box;pointer-events:auto;transition:background .2s';
      document.documentElement.appendChild(badgeEl);
    }
    var labels = { live: 'Saved · live', connecting: 'Connecting…', offline: 'Offline — changes will sync when back', closed: 'This page was closed by the referee' };
    badgeEl.title = 'MotherGoose: ' + (labels[s] || s);
    // Catppuccin colours that read on both light and dark pages.
    badgeEl.style.background = s === 'live' ? '#40a02b' : 'transparent';
    badgeEl.style.borderColor = s === 'live' ? '#40a02b' : s === 'connecting' ? '#df8e1d' : s === 'closed' ? '#d20f39' : '#8c8fa1';
  }

  function connect() {
    sync = createSync({
      query: 'session=' + encodeURIComponent(cfg.session) + '&scope=' + encodeURIComponent(cfg.scope) +
        '&file=' + encodeURIComponent(cfg.file) +
        // One player's copy of a per-player page has its own room and entries.
        (cfg.player ? '&player=' + encodeURIComponent(cfg.player) : ''),
      accept: function () { return true; },
      read: function (key) { return state[key]; },
      apply: applyRemote,
      onStatus: setStatus
    });
  }

  // ---- start ----------------------------------------------------------------

  function restoreAll() {
    index();
    Object.keys(elsOf).forEach(function (k) {
      elsOf[k].forEach(function (el) { seenEls.add(el); });
      if (k in state) writeValue(k, state[k]);
    });
  }

  // Fields added later (e.g. "add row" buttons) get their saved values too.
  var moTimer = null;
  function onMutate() {
    moTimer = null;
    index();
    Object.keys(elsOf).forEach(function (k) {
      var fresh = elsOf[k].filter(function (el) { return !seenEls.has(el); });
      if (!fresh.length) return;
      fresh.forEach(function (el) { seenEls.add(el); });
      if (k in state) writeValue(k, state[k]);
    });
  }

  function start() {
    restoreAll();
    document.addEventListener('input', onLocal, true);
    document.addEventListener('change', onLocal, true);
    document.addEventListener('focusout', function () { setTimeout(flushDeferred, 0); }, true);
    new MutationObserver(function () {
      if (!moTimer) moTimer = setTimeout(onMutate, 60);
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    // Pages that set themselves up on window load: let them see the values.
    window.addEventListener('load', function () {
      applying++;
      try {
        Object.keys(elsOf).forEach(function (k) { if (k in state && k.indexOf(CUSTOM) !== 0) elsOf[k].forEach(fire); });
      } finally { applying--; }
    });
    if (cfg) connect(); else setStatus('offline-copy');
  }

  window.MotherGoose = {
    /** True in an exported copy that is not connected to a server. */
    offline: !cfg,
    /** Read a custom value saved with set(). */
    get: function (name) { return state[CUSTOM + name]; },
    /** Save any JSON-serialisable value under a name; null deletes it. */
    set: function (name, v) {
      setLocal(CUSTOM + name, v);
      if (sync) sync.changed(CUSTOM + name);
    },
    /** Call fn(value) now (if saved) and whenever another device changes it. */
    on: function (name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      if ((CUSTOM + name) in state) fn(state[CUSTOM + name]);
    },
    /** 'connecting' | 'live' | 'offline' | 'closed' | 'offline-copy' */
    status: function () { return status; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
