// Image viewer: fits the screen, or shows actual size with scrolling.
// Click or tap the image to switch.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var src = new URLSearchParams(location.search).get('src') || '';
  var wrap = $('wrap'), img = $('img');

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
  img.onload = function () { $('dims').textContent = img.naturalWidth + '×' + img.naturalHeight; };
  img.onerror = function () {
    $('error').textContent = "Couldn't load this image.";
    $('error').hidden = false;
  };
  img.src = src;

  function setActual(on, x, y) {
    var r = img.getBoundingClientRect();
    wrap.classList.toggle('actual', on);
    $('fit').className = 'mg-btn small' + (on ? ' quiet' : '');
    $('actual').className = 'mg-btn small' + (on ? '' : ' quiet');
    $('fit').setAttribute('aria-pressed', String(!on));
    $('actual').setAttribute('aria-pressed', String(on));
    // Zoom towards the point that was clicked.
    if (on && x != null && r.width) {
      wrap.scrollLeft = (x - r.left) / r.width * img.naturalWidth - wrap.clientWidth / 2;
      wrap.scrollTop = (y - r.top) / r.height * img.naturalHeight - wrap.clientHeight / 2;
    }
  }
  wrap.addEventListener('click', function (e) {
    if (e.target === img) setActual(!wrap.classList.contains('actual'), e.clientX, e.clientY);
  });
  $('fit').onclick = function () { setActual(false); };
  $('actual').onclick = function () { setActual(true); };
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '0') setActual(false);
    else if (e.key === '1') setActual(true);
  });
})();
