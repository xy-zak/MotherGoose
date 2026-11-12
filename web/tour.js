// The guided tutorial, shared by the referee's dashboard and the player
// dashboard: it steps through the page, highlighting one part at a time with
// an explainer card beside it, and a timeline along the bottom shows every
// step, grouped by section.
//
// Steps can open an overlay (a "scene"), so the parts of a popup get a tour
// of their own. The tour is drawn in the top layer (popover) and, while an
// overlay is open, lives inside it: a modal <dialog> makes everything outside
// it inert, and the tour's buttons must stay usable.
//
// startTour({ steps, scenes, onEnd })
//   steps:  [{ section, title, text, target, scene }]
//           text:   HTML, or a function returning it (read when the step shows)
//           target: a selector, an element, an array of them, or a function
//                   (given the open scene's dialog, if any) returning one of
//                   those (an array may mix them); nothing, or nothing
//                   visible, centres the card.
//                   Several elements are highlighted together.
//           scene:  a key of scenes: the overlay open during this step
//           optional: leave the step out when its target isn't on screen
//                   (such as a button narrow screens don't have)
//   scenes: { key: () => dialog }: opens the overlay and returns it. The tour
//           closes it when a step without that scene comes up, or at the end.
//   onEnd:  called once the tour is over, however it ended.
import { esc, ic } from '/_mg/ui.js';

let running = null;

// A step's target as a list of elements; base is where selectors are looked up.
function targets(t, dialog, base) {
  if (typeof t === 'function') t = t(dialog);
  if (!t) return [];
  const list = Array.isArray(t) || t instanceof NodeList ? Array.from(t) : [t];
  return list.flatMap((x) => typeof x === 'string' ? Array.from(base.querySelectorAll(x))
    : typeof x === 'function' ? targets(x, dialog, base) : x ? [x] : []);
}
const visible = (els) => els.filter((el) => el.isConnected && el.getClientRects().length && !el.closest('[hidden]'));

export function tourRunning() { return !!running; }

export function startTour({ steps, scenes = {}, onEnd }) {
  if (running) return;
  steps = steps.filter((s) => !s.optional || s.scene || visible(targets(s.target, null, document)).length);
  if (!steps.length) return;
  const returnFocus = document.activeElement;
  const root = document.createElement('div');
  root.className = 'mg-tour';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Tutorial');
  const popover = typeof root.showPopover === 'function';
  if (popover) root.setAttribute('popover', 'manual');

  // Sections in order of first appearance, each with the steps in it.
  const sections = [];
  steps.forEach((s, i) => {
    let sec = sections[sections.length - 1];
    if (!sec || sec.name !== s.section) { sec = { name: s.section, steps: [] }; sections.push(sec); }
    sec.steps.push(i);
    s.sec = sections.length - 1;
  });

  root.innerHTML =
    '<div class="mg-tour-spot" aria-hidden="true"></div>' +
    '<section class="mg-tour-card" tabindex="-1" aria-live="polite">' +
      '<div class="mg-tour-head"><span class="sec"></span><span class="count"></span>' +
        '<button type="button" class="mg-btn quiet small" data-tour="end" aria-label="End the tutorial">esc</button></div>' +
      '<div class="mg-tour-body"><h2></h2><div class="txt"></div></div>' +
      '<div class="mg-tour-foot">' +
        '<button type="button" class="mg-btn quiet small" data-tour="end">' + ic('close') + '<span class="lbl">end tour</span></button>' +
        '<span class="mg-grow"></span>' +
        '<button type="button" class="mg-btn small" data-tour="back">' + ic('prev') + '<span class="lbl">back</span></button>' +
        '<button type="button" class="mg-btn primary small" data-tour="next"></button>' +
      '</div>' +
    '</section>' +
    '<nav class="mg-tour-line" aria-label="Tutorial steps">' +
      '<div class="where"><span class="now"></span><span class="mg-grow"></span><span class="of"></span></div>' +
      '<div class="secs">' + sections.map((sec, si) =>
        '<div class="sec" data-sec="' + si + '" style="flex: ' + sec.steps.length + ' 1 0">' +
          '<span class="ticks">' + sec.steps.map((i) =>
            '<button type="button" class="tick" data-step="' + i + '" title="' + esc((i + 1) + '. ' + sec.name + ': ' + steps[i].title) + '"></button>').join('') + '</span>' +
          '<span class="name">' + esc(sec.name) + '</span></div>').join('') +
      '</div>' +
    '</nav>';

  const spot = root.querySelector('.mg-tour-spot');
  const card = root.querySelector('.mg-tour-card');
  const line = root.querySelector('.mg-tour-line');
  const nextBtn = root.querySelector('[data-tour="next"]');
  const backBtn = root.querySelector('[data-tour="back"]');

  let at = -1;
  let scene = null;        // { key, dialog } of the overlay the tour opened
  let lastRect = '';       // what the highlight was last placed on, to skip needless work
  let frame = 0;

  // ---- where the tour lives ----------------------------------------------------

  function mount(host) {
    if (root.parentNode !== host) host.appendChild(root);  // moving a popover hides it
    if (popover) {
      try { if (root.matches(':popover-open')) root.hidePopover(); root.showPopover(); } catch (e) {}
    }
  }

  function closeScene() {
    if (!scene) return;
    const d = scene.dialog;
    scene = null;
    mount(document.body);   // out first: a closed overlay removes itself, and everything in it
    if (d && d.open) d.close();
  }

  function openScene(key) {
    if (scene && scene.key === key) return;
    closeScene();
    if (!key || !scenes[key]) return;
    const d = scenes[key]();
    scene = { key, dialog: d || null };
    if (d) {
      // Keep the whole overlay above the timeline, so its footer can be shown.
      const h = line.offsetHeight;
      d.style.maxHeight = 'calc(100dvh - ' + (h + 24) + 'px)';
      d.style.marginBottom = (h + 12) + 'px';
      mount(d);
    }
  }

  // ---- placing the highlight and the card --------------------------------------

  const resolve = (t) => visible(targets(t, scene && scene.dialog, (scene && scene.dialog) || document));

  function unionRect(els) {
    let r = null;
    els.forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width < 1 && b.height < 1) return;
      r = r ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) }
        : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    });
    return r;
  }

  function place() {
    const step = steps[at];
    const r = unionRect(resolve(step.target));
    const vw = document.documentElement.clientWidth, vh = innerHeight;
    const lineH = line.offsetHeight;
    const availH = vh - lineH;
    const key = (r ? [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') : 'none') + '|' + vw + 'x' + vh + '|' + at;
    if (key === lastRect) return;
    lastRect = key;

    const m = 10, gap = 12, pad = 4;
    root.classList.toggle('no-target', !r);
    let s = null;
    if (r) {
      // The highlight, padded a little and kept on screen.
      s = {
        left: Math.max(2, r.left - pad), top: Math.max(2, r.top - pad),
        right: Math.min(vw - 2, r.right + pad), bottom: Math.min(availH - 2, r.bottom + pad)
      };
      if (s.bottom <= s.top) s.bottom = s.top + 1;
      Object.assign(spot.style, { left: s.left + 'px', top: s.top + 'px', width: (s.right - s.left) + 'px', height: (s.bottom - s.top) + 'px' });
    }

    card.style.maxHeight = Math.max(120, availH - 2 * m) + 'px';
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const clampX = (x) => Math.min(Math.max(m, x), vw - cw - m);
    const clampY = (y) => Math.min(Math.max(m, y), availH - ch - m);
    let x, y;
    if (!s) {
      x = (vw - cw) / 2; y = clampY((availH - ch) / 2);
    } else {
      const cx = (s.left + s.right) / 2, cy = (s.top + s.bottom) / 2;
      if (s.bottom + gap + ch <= availH - m) { x = clampX(cx - cw / 2); y = s.bottom + gap; }            // below
      else if (s.top - gap - ch >= m) { x = clampX(cx - cw / 2); y = s.top - gap - ch; }                // above
      else if (s.right + gap + cw <= vw - m) { x = s.right + gap; y = clampY(cy - ch / 2); }            // right
      else if (s.left - gap - cw >= m) { x = s.left - gap - cw; y = clampY(cy - ch / 2); }              // left
      else {
        // A big target: dock the card at the top or bottom, whichever covers less of it.
        x = clampX(cx - cw / 2);
        y = (s.top - m) > (availH - s.bottom - m) ? m : availH - ch - m;
      }
    }
    card.style.left = Math.round(x) + 'px';
    card.style.top = Math.round(y) + 'px';
  }

  // Pages redraw themselves (live updates, layout changes): follow the target.
  function loop() {
    if (!running) return;
    place();
    frame = requestAnimationFrame(loop);
  }

  // ---- moving between steps --------------------------------------------------------

  function go(i) {
    if (i < 0 || i >= steps.length) return;
    at = i;
    const step = steps[i];
    openScene(step.scene);
    const sec = sections[step.sec];
    root.querySelector('.mg-tour-head .sec').innerHTML = ic('help') + '<span>' + esc(sec.name) + '</span>';
    root.querySelector('.mg-tour-head .count').textContent = (i + 1) + ' / ' + steps.length;
    root.querySelector('.mg-tour-body h2').textContent = step.title;
    root.querySelector('.mg-tour-body .txt').innerHTML = typeof step.text === 'function' ? step.text() : (step.text || '');
    card.scrollTop = 0;
    backBtn.disabled = i === 0;
    const last = i === steps.length - 1;
    nextBtn.innerHTML = last ? ic('check') + '<span class="lbl">done</span>' : '<span class="lbl">next</span>' + ic('next');

    root.querySelector('.mg-tour-line .now').innerHTML = '<b>' + esc(sec.name) + '</b><span class="mg-muted"> · section ' + (step.sec + 1) + ' of ' + sections.length + '</span>';
    root.querySelector('.mg-tour-line .of').textContent = 'step ' + (i + 1) + ' of ' + steps.length;
    root.querySelectorAll('.tick').forEach((t) => {
      const n = +t.dataset.step;
      t.classList.toggle('done', n < i);
      t.classList.toggle('on', n === i);
      if (n === i) t.setAttribute('aria-current', 'step'); else t.removeAttribute('aria-current');
    });
    root.querySelectorAll('.mg-tour-line .sec').forEach((el) => {
      const n = +el.dataset.sec;
      el.classList.toggle('on', n === step.sec);
      el.classList.toggle('done', n < step.sec);
    });

    const els = resolve(step.target);
    if (els.length) {
      // Scrolled into view clear of the timeline, not underneath it.
      // (and clear of a sticky page header at the top).
      const el = els[0], was = [el.style.scrollMarginTop, el.style.scrollMarginBottom];
      el.style.scrollMarginTop = '64px';
      el.style.scrollMarginBottom = (line.offsetHeight + 12) + 'px';
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      [el.style.scrollMarginTop, el.style.scrollMarginBottom] = was;
    }
    lastRect = '';
    place();
    nextBtn.focus({ preventScroll: true });
  }

  function end() {
    if (!running) return;
    running = null;
    cancelAnimationFrame(frame);
    removeEventListener('keydown', onKey, true);
    closeScene();
    if (popover) { try { root.hidePopover(); } catch (e) {} }
    root.remove();
    if (onEnd) onEnd();
    if (returnFocus && returnFocus.isConnected && returnFocus.focus) returnFocus.focus({ preventScroll: true });
  }

  root.addEventListener('click', (e) => {
    e.stopPropagation();   // nothing under the tour reacts to its clicks
    const b = e.target.closest('[data-tour], [data-step]');
    if (!b) return;
    if (b.dataset.step) go(+b.dataset.step);
    else if (b.dataset.tour === 'end') end();
    else if (b.dataset.tour === 'back') go(at - 1);
    else if (b.dataset.tour === 'next') { if (at === steps.length - 1) end(); else go(at + 1); }
  });
  // Keep pointer presses from reaching the page or an overlay behind (a press
  // on the backdrop would otherwise close it).
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu', 'dragstart'].forEach((t) =>
    root.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'dragstart' || t === 'contextmenu') e.preventDefault(); }));

  // Keys belong to the tour while it runs: the page's shortcuts stay quiet,
  // and Tab stays on the tour's own controls.
  function onKey(e) {
    const k = e.key;
    const inTour = root.contains(e.target);
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); return; }
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') { e.preventDefault(); e.stopPropagation(); if (at < steps.length - 1) go(at + 1); return; }
    if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); e.stopPropagation(); go(at - 1); return; }
    if (k === 'Home') { e.preventDefault(); e.stopPropagation(); go(0); return; }
    if (k === 'End') { e.preventDefault(); e.stopPropagation(); go(steps.length - 1); return; }
    if (k === 'Tab') {
      const f = Array.from(root.querySelectorAll('button:not(:disabled)')).filter((b) => b.getClientRects().length);
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      e.stopPropagation();
      const n = i < 0 ? 0 : (i + (e.shiftKey ? -1 : 1) + f.length) % f.length;
      if (f[n]) f[n].focus();
      return;
    }
    // Enter and Space press the focused tour button; nothing else gets through.
    if (inTour && (k === 'Enter' || k === ' ')) { e.stopPropagation(); return; }
    e.preventDefault();
    e.stopPropagation();
  }

  running = { end };
  addEventListener('keydown', onKey, true);
  mount(document.body);
  go(0);
  frame = requestAnimationFrame(loop);
}
