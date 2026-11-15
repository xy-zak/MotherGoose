// Image viewer: fits the screen, and zooms in steps, by pinching, by double
// tapping or clicking a point, up to four times actual size. Scroll (or drag
// with a finger) around a zoomed image.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var src = new URLSearchParams(location.search).get('src') || '';
  var wrap = $('wrap'), img = $('img');
  var MAX = 4;          // times actual size
  var scale = 0;        // 0: fit; otherwise CSS px per image px

  if (!/^\/s\/[^?#]+$/.test(src)) {
    $('error').textContent = 'This viewer only opens images from this MotherGoose server.';
    $('error').hidden = false;
    wrap.hidden = true;
    return;
  }
  var name = decodeURIComponent(src.split('/').pop());
  $('name').textContent = name;
  if (window.top === window) document.body.classList.add('standalone');
  document.title = name + ' · MotherGoose';
  img.alt = name;
  img.onload = function () { $('dims').textContent = img.naturalWidth + '×' + img.naturalHeight; apply(); };
  img.onerror = function () {
    $('error').textContent = "Couldn't load this image.";
    $('error').hidden = false;
  };
  img.src = src;

  function fitScale() {
    if (!img.naturalWidth) return 1;
    return Math.min(wrap.clientWidth / img.naturalWidth, wrap.clientHeight / img.naturalHeight, 1);
  }
  function now() { return scale || fitScale(); }

  // zoomTo sets the scale, keeping the image point under (x, y) (in the
  // window) where it was. s = 0 means fit.
  function zoomTo(s, x, y) {
    var before = now();
    var cx = x == null ? wrap.clientWidth / 2 : x, cy = y == null ? wrap.clientHeight / 2 : y;
    var r = img.getBoundingClientRect();
    var px = (cx - r.left) / before, py = (cy - r.top) / before;   // image px under the point
    var fit = fitScale();
    scale = s && s > fit * 1.02 ? Math.min(s, MAX) : 0;
    apply();
    if (scale) {
      wrap.scrollLeft = px * scale - cx;
      wrap.scrollTop = py * scale - cy;
    }
  }
  function apply() {
    var s = now();
    wrap.classList.toggle('zoomed', !!scale);
    img.style.width = scale ? img.naturalWidth * s + 'px' : '';
    img.style.height = scale ? img.naturalHeight * s + 'px' : '';
    $('fit').className = 'mg-btn small' + (scale ? ' quiet' : '');
    $('fit').setAttribute('aria-pressed', String(!scale));
    $('zoom').textContent = Math.round(s * 100) + '%';
  }
  function step(dir, x, y) {
    var s = now();
    zoomTo(dir > 0 ? s * 1.5 : s / 1.5, x, y);
  }

  // A click (or double tap) on the image zooms in at that point; on a
  // zoomed image it goes back to fit.
  wrap.addEventListener('click', function (e) {
    if (e.target !== img || touchZoomed) return;
    if (scale) zoomTo(0); else zoomTo(Math.max(1, fitScale() * 2), e.clientX, e.clientY);
  });
  $('fit').onclick = function () { zoomTo(0); };
  $('out').onclick = function () { step(-1); };
  $('in').onclick = function () { step(1); };
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '0') zoomTo(0);
    else if (e.key === '1') zoomTo(1);
    else if (e.key === '+' || e.key === '=') step(1);
    else if (e.key === '-') step(-1);
    else return;
    e.preventDefault();
  });
  addEventListener('resize', function () { if (!scale) apply(); });

  // Pinch: two fingers scale the image around the point between them.
  var pinch = null, touchZoomed = false, lastTap = 0;
  var dist = function (t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); };
  wrap.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      pinch = { d: dist(e.touches), s: now(), x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
    }
  }, { passive: true });
  wrap.addEventListener('touchmove', function (e) {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    zoomTo(pinch.s * dist(e.touches) / pinch.d, pinch.x, pinch.y);
    pinch.s = now(); pinch.d = dist(e.touches);
  }, { passive: false });
  wrap.addEventListener('touchend', function (e) {
    if (pinch) { pinch = null; touchZoomed = true; setTimeout(function () { touchZoomed = false; }, 400); return; }
    // Double tap: zoom in a step there, or back to fit when zoomed.
    if (e.changedTouches.length !== 1) return;
    var t = Date.now();
    if (t - lastTap < 300) {
      e.preventDefault();
      var p = e.changedTouches[0];
      if (scale) zoomTo(0); else zoomTo(Math.max(1, fitScale() * 2), p.clientX, p.clientY);
      touchZoomed = true; setTimeout(function () { touchZoomed = false; }, 400);
      lastTap = 0;
    } else lastTap = t;
  });
})();
