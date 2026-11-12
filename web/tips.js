// Hover and keyboard-focus hints in MotherGoose's own style, instead of the
// browser's plain title tooltips. Any element with a title gets one: the
// title moves to data-tip the moment the pointer arrives, so the native
// tooltip never also appears. Hints are drawn in the top layer (popover), so
// they show above open overlays too. Touch taps don't show hints.
(function () {
  'use strict';
  var DELAY = 450;
  var tip = document.createElement('div');
  tip.className = 'mg-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  var popover = typeof tip.showPopover === 'function';
  if (popover) tip.setAttribute('popover', 'manual');

  var cur = null;   // element hovered or focused (hint pending or shown)
  var timer = 0;

  // Take over an element's title. Icon-only controls with no other name keep
  // the text as their accessible name.
  function claim(el) {
    var t = el.getAttribute('title');
    if (t !== null) {
      el.removeAttribute('title');
      if (t) {
        el.setAttribute('data-tip', t);
        if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t);
      } else {
        el.removeAttribute('data-tip');
      }
    }
    return el.getAttribute('data-tip');
  }

  function find(node) {
    for (var el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el.tagName === 'IFRAME') return null;          // an iframe's title is its name, not a hint
      if (el.hasAttribute('title') || el.hasAttribute('data-tip')) return el;
    }
    return null;
  }

  function place(el) {
    var r = el.getBoundingClientRect(), m = 6;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var x = Math.min(Math.max(m, r.left + r.width / 2 - w / 2), innerWidth - w - m);
    var y = r.bottom + m;
    if (y + h > innerHeight - m) y = Math.max(m, r.top - h - m); // no room below: go above
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
  }

  // A hint that only repeats a label already on screen is noise. It still
  // shows when the label is hidden (icons-only buttons) or adds detail.
  function redundant(el, text) {
    var lbl = el.querySelector('.lbl');
    var shown = lbl ? (lbl.getBoundingClientRect().width > 1 ? lbl.textContent : '') : (el.children.length ? '' : el.textContent);
    return shown.trim().toLowerCase() === text.trim().toLowerCase();
  }

  function show(el) {
    var text = claim(el);
    if (!text || !el.isConnected || redundant(el, text)) return;
    tip.textContent = text;
    // Without popover support, a hint inside an overlay must live in it to be seen.
    var host = popover ? document.body : (el.closest('dialog[open]') || document.body);
    if (tip.parentNode !== host) host.appendChild(tip);
    tip.hidden = false;
    if (popover) {
      try { if (tip.matches(':popover-open')) tip.hidePopover(); tip.showPopover(); } catch (e) {}
    }
    place(el);
  }

  function hide() {
    clearTimeout(timer);
    timer = 0;
    cur = null;
    if (tip.hidden) return;
    tip.hidden = true;
    if (popover) { try { tip.hidePopover(); } catch (e) {} }
  }

  function arm(el) {
    if (el === cur) return;
    hide();
    if (!el) return;
    cur = el;
    claim(el);
    timer = setTimeout(function () { timer = 0; if (cur === el) show(el); }, DELAY);
  }

  document.addEventListener('pointerover', function (e) {
    if (e.pointerType === 'touch') return;
    arm(find(e.target));
  }, true);
  document.addEventListener('pointerout', function (e) {
    if (cur && find(e.relatedTarget) !== cur) hide();
  }, true);
  document.addEventListener('focusin', function (e) {
    var el = find(e.target);
    if (el && el.matches(':focus-visible')) arm(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); }, true);
  addEventListener('scroll', hide, true);
  addEventListener('blur', hide);
})();
