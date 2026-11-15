// Follows this device's MotherGoose colour theme and font, for pages that
// ask to (<meta name="mothergoose" content="theme">) and Markdown pages.
// MotherGoose adds it, with tokens.css, to the page's <head>, so the page is
// drawn in the right colours from the start, and it follows changes made in
// Display settings while the page is open. The page's own CSS uses the
// tokens (--bg, --text, --accent, --font…) with fallbacks of its own, which
// is what a copy opened without MotherGoose (an export) shows.
//
// A classic script inside other people's pages, so it can't import prefs.js:
// the keys, values and old-value mapping below repeat prefs.js's PREFS.
(function () {
  'use strict';
  var THEMES = { latte: 1, frappe: 1, macchiato: 1, mocha: 1 };
  var OLD = { light: 'latte', dark: 'mocha' };   // values saved by earlier versions
  var FONTS = { 'hyper-mono': 1, hyper: 1, dyslexic: 1, system: 1 };
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function apply() {
    var root = document.documentElement;
    var t = get('mg-theme'), f = get('mg-font');
    t = OLD[t] || t;
    if (THEMES[t]) root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
    if (FONTS[f]) root.setAttribute('data-font', f); else root.removeAttribute('data-font');
    root.setAttribute('data-mg-theme', '');
  }
  apply();
  window.addEventListener('storage', function (e) {
    if (!e.key || /^mg-(theme|font)$/.test(e.key)) apply();
  });
})();
