// Display settings, per device: colour theme (Catppuccin flavour), font,
// whether buttons show icons, text or both, and how much animation there is.
// Applied before first paint so nothing flashes, and kept in step across tabs
// and frames on this device. Any [data-prefs] button opens the settings overlay.
//
// Animation: data-anim on <html> is the level in effect, "full", "reduced" or
// "off" ("auto" follows the device's reduce-motion setting). This also plays
// the screen switching on when this page was opened from the other dashboard
// (fx.js switches the old one off and leaves a note in mg-switch).
(function () {
  'use strict';
  var ICONS = '/_mg/icons.svg#';
  var PREFS = {
    theme: {
      key: 'mg-theme', attr: 'data-theme', def: 'auto', title: 'Colour theme',
      old: { light: 'latte', dark: 'mocha' }, // values saved by earlier versions
      opts: [
        // Each box is drawn in its own colours, so light and dark are obvious.
        { id: 'auto', name: 'Auto', hint: 'light or dark, following this device', mode: 'auto' },
        { id: 'latte', name: 'Latte', hint: 'light', mode: 'light', bg: '#eff1f5', fg: '#4c4f69', sub: '#6c6f85', line: '#bcc0cc', sw: ['#8839ef', '#1e66f5', '#fe640b', '#40a02b'] },
        { id: 'frappe', name: 'Frappé', hint: 'dark, soft', mode: 'dark', bg: '#303446', fg: '#c6d0f5', sub: '#a5adce', line: '#51576d', sw: ['#ca9ee6', '#8caaee', '#ef9f76', '#a6d189'] },
        { id: 'macchiato', name: 'Macchiato', hint: 'dark', mode: 'dark', bg: '#24273a', fg: '#cad3f5', sub: '#a5adcb', line: '#494d64', sw: ['#c6a0f6', '#8aadf4', '#f5a97f', '#a6da95'] },
        { id: 'mocha', name: 'Mocha', hint: 'darkest', mode: 'dark', bg: '#1e1e2e', fg: '#cdd6f4', sub: '#a6adc8', line: '#45475a', sw: ['#cba6f7', '#89b4fa', '#fab387', '#a6e3a1'] }
      ]
    },
    font: {
      key: 'mg-font', attr: 'data-font', def: 'mono', title: 'Font',
      opts: [
        { id: 'mono', name: 'JetBrains Mono', hint: 'default, terminal style', css: '"JetBrains Mono", monospace' },
        { id: 'hyper-mono', name: 'Atkinson Hyperlegible Mono', hint: 'easier to tell letters apart', css: '"Atkinson Hyperlegible Mono", monospace' },
        { id: 'hyper', name: 'Atkinson Hyperlegible', hint: 'for low vision', css: '"Atkinson Hyperlegible Next", sans-serif' },
        { id: 'dyslexic', name: 'OpenDyslexic', hint: 'for dyslexic readers', css: '"OpenDyslexic", sans-serif' },
        { id: 'system', name: "This device's font", hint: 'whatever the system uses', css: 'system-ui, sans-serif' }
      ]
    },
    labels: {
      key: 'mg-labels', attr: 'data-labels', def: 'both', title: 'Buttons show',
      opts: [
        { id: 'both', name: 'Icons and text', icon: 'labels' },
        { id: 'icons', name: 'Icons only', hint: 'names appear on hover', icon: 'settings' },
        { id: 'text', name: 'Text only', icon: 'text' }
      ]
    },
    motion: {
      key: 'mg-motion', attr: 'data-motion', def: 'auto', title: 'Animations',
      opts: [
        { id: 'auto', name: 'Auto', hint: 'retro, unless this device asks for less motion' },
        { id: 'on', name: 'Retro', hint: 'CRT effects, always' },
        { id: 'reduced', name: 'Reduced', hint: 'quick fades only' },
        { id: 'off', name: 'Off', hint: 'no animation' }
      ]
    }
  };
  var lessMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function get(p) {
    var v;
    try { v = localStorage.getItem(p.key); } catch (e) { v = null; }
    if (p.old && p.old[v]) v = p.old[v];
    for (var i = 0; i < p.opts.length; i++) if (p.opts[i].id === v) return v;
    return p.def;
  }
  function apply() {
    var root = document.documentElement;
    Object.keys(PREFS).forEach(function (k) {
      var p = PREFS[k], v = get(p);
      if (v === p.def) root.removeAttribute(p.attr); else root.setAttribute(p.attr, v);
    });
    var m = get(PREFS.motion);
    root.setAttribute('data-anim', m === 'off' ? 'off' : m === 'reduced' ? 'reduced' : m === 'on' ? 'full'
      : lessMotion && lessMotion.matches ? 'reduced' : 'full');
  }
  function save(p, v) {
    try { localStorage.setItem(p.key, v); } catch (e) {}
    apply();
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function icon(n) { return '<svg class="mg-i" aria-hidden="true"><use href="' + ICONS + n + '"></use></svg>'; }

  // A theme option previewed in that theme's own colours.
  function themeBox(o, cur) {
    // Auto shows a light chip and a dark chip: it becomes one or the other.
    var mode = o.mode === 'auto'
      ? '<span class="chip" style="background:#eff1f5;color:#4c4f69">' + icon('light') + '</span><span class="chip" style="background:#1e1e2e;color:#cdd6f4">' + icon('dark') + '</span>'
      : icon(o.mode);
    var style = o.bg ? 'background:' + o.bg + ';color:' + o.fg + ';border-color:' + o.line + ';--opt-accent:' + o.sw[0] + ';--opt-sub:' + o.sub : '';
    var sw = o.sw ? '<span class="sw">' + o.sw.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join('') + '</span>' : '';
    return '<button type="button" class="mg-opt theme' + (o.mode === 'auto' ? ' auto' : '') + '" role="radio" data-pref="theme" data-id="' + o.id + '" aria-checked="' + (o.id === cur) + '" style="' + style + '">' +
      '<span class="mode">' + mode + '</span>' +
      '<span class="txt"><span class="name">' + esc(o.name) + '</span><span class="hint">' + esc(o.hint) + '</span></span>' + sw + '</button>';
  }

  function section(k) {
    var p = PREFS[k], cur = get(p);
    var opts = p.opts.map(function (o) {
      if (k === 'theme') return themeBox(o, cur);
      var lead = o.icon ? icon(o.icon) : '';
      var name = k === 'font'
        ? '<span class="name sample" style="font-family:' + esc(o.css) + '">' + esc(o.name) + '</span>'
        : '<span class="name">' + esc(o.name) + '</span>';
      return '<button type="button" class="mg-opt" role="radio" data-pref="' + k + '" data-id="' + o.id + '" aria-checked="' + (o.id === cur) + '">' +
        lead + '<span style="display:grid;gap:1px">' + name + (o.hint ? '<span class="hint">' + esc(o.hint) + '</span>' : '') + '</span></button>';
    }).join('');
    return '<div><div class="mg-section-label">' + p.title + '</div>' +
      '<div class="mg-opts ' + (k === 'labels' || k === 'motion' ? 'row' : 'grid') + '" role="radiogroup" aria-label="' + p.title + '">' + opts + '</div></div>';
  }

  function open(from) {
    var d = document.createElement('dialog');
    d.className = 'mg-dialog';
    d.style.width = 'min(640px, calc(100vw - 24px))';
    d.innerHTML = '<div class="mg-dialog-head">' + icon('settings') + '<span class="t">Display settings</span>' +
      '<button type="button" class="mg-btn quiet small" data-close aria-label="Close">esc</button></div>' +
      '<div class="mg-dialog-body mg-prefs">' + section('theme') + section('font') + section('labels') + section('motion') +
      '<p class="mg-muted" style="font-size: var(--fs-small)">Saved on this device only. Pages added to a session keep their own fonts and colours.</p></div>' +
      '<div style="height:10px"></div>';
    document.body.appendChild(d);
    d.addEventListener('click', function (e) {
      var o = e.target.closest('.mg-opt');
      if (o) {
        save(PREFS[o.dataset.pref], o.dataset.id);
        d.querySelectorAll('.mg-opt[data-pref="' + o.dataset.pref + '"]').forEach(function (x) { x.setAttribute('aria-checked', String(x === o)); });
      } else if (e.target.closest('[data-close]') || e.target === d) {
        d.close();
      }
    });
    d.addEventListener('close', function () { d.remove(); if (from) from.focus(); });
    d.showModal();
    var sel = d.querySelector('[aria-checked="true"]');
    if (sel) sel.focus();
  }

  apply();
  if (lessMotion && lessMotion.addEventListener) lessMotion.addEventListener('change', apply);
  arrive();
  animateClosing();
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-prefs]');
    if (b) open(b);
  });
  // Changed in another tab or frame (e.g. a viewer inside the player view).
  window.addEventListener('storage', function (e) {
    if (!e.key || /^mg-(theme|font|labels|motion)$/.test(e.key)) apply();
  });

  // Popups switch off as they close: a .mg-dialog stays open with .mg-closing
  // while the CSS plays (theme.css, "motion"), then really closes, so its
  // "close" event (and whoever waits on it) comes once it has gone. Escape is
  // routed the same way. Popups the tutorial is showing close at once, so the
  // tour never measures one that's shrinking.
  function animateClosing() {
    if (typeof HTMLDialogElement === 'undefined') return;
    var proto = HTMLDialogElement.prototype, close = proto.close;
    proto.close = function (value) {
      var d = this, args = arguments;
      if (d.classList.contains('mg-closing')) return;   // already on its way
      var anim = document.documentElement.getAttribute('data-anim');
      if (!d.open || !d.classList.contains('mg-dialog') || d.classList.contains('mg-toured') || anim === 'off') return close.apply(d, args);
      d.classList.add('mg-closing');
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        d.removeEventListener('animationend', onEnd);
        d.classList.remove('mg-closing');
        if (d.open) close.apply(d, args);
      };
      var onEnd = function (e) { if (e.target === d && !e.pseudoElement && /off|fade-out/.test(e.animationName)) finish(); };
      d.addEventListener('animationend', onEnd);
      setTimeout(finish, 400);   // in case the animation never runs
    };
    document.addEventListener('cancel', function (e) {
      var d = e.target;
      if (!(d instanceof HTMLDialogElement) || !d.classList.contains('mg-dialog')) return;
      e.preventDefault();
      d.close();
    }, true);
  }

  // Opened from the other dashboard a moment ago (in this tab or a new one):
  // this screen switches on. Only the dashboards themselves, not their frames.
  function arrive() {
    var here = location.pathname === '/' ? 'players' : /^\/admin(\/|$)/.test(location.pathname) ? 'referee' : '';
    if (!here || window.top !== window) return;
    var note = null;
    try { note = JSON.parse(localStorage.getItem('mg-switch') || 'null'); } catch (e) {}
    if (!note || note.to !== here || !(Date.now() - note.at < 4000)) return;
    try { localStorage.removeItem('mg-switch'); } catch (e) {}
    var root = document.documentElement, anim = root.getAttribute('data-anim');
    if (anim === 'off') return;
    root.classList.add('mg-arrive');
    var done = function () { root.classList.remove('mg-arrive'); var st = document.querySelector('.mg-static'); if (st) st.remove(); };
    document.addEventListener('DOMContentLoaded', function () {
      if (anim === 'full') {
        var st = document.createElement('div');
        st.className = 'mg-static';
        st.setAttribute('aria-hidden', 'true');
        root.appendChild(st);   // beside <body>, which is still switched off
      }
      document.body.addEventListener('animationend', function (e) { if (e.target === document.body) done(); });
    });
    setTimeout(done, 1200);   // in case the animation never runs (a background tab)
  }
})();
