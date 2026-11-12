// The guided tutorial, shared by the referee's dashboard and the player
// dashboard: it steps through the page, highlighting one part at a time with
// an explainer card beside it, and a timeline along the bottom shows every
// step, grouped by section. Everything outside the highlight is hatched out.
// The tutorial has its own colour (teal), so its card and outlines are never
// mistaken for the app's own controls.
//
// Steps can open an overlay (a "scene"), so the parts of a popup get a tour
// of their own. While one is open, the popup is framed and labelled, it is
// moved beside the button that opened it, and that button is outlined.
//
// The tour is drawn in the top layer (popover) and, while an overlay is open,
// lives inside it: a modal <dialog> makes everything outside it inert, and
// the tour's buttons must stay usable.
//
// startTour({ name, steps, scenes, onEnd })
//   name:   what the tour is called, e.g. "Referee tutorial"
//   steps:  [{ section, title, text, target, scene, optional }]
//           text:   HTML, or a function returning it (read when the step shows)
//           target: a selector, an element, an array of them, or a function
//                   (given the open scene's dialog, if any) returning one of
//                   those (an array may mix them); nothing, or nothing
//                   visible, centres the card. Several elements are
//                   highlighted together.
//           scene:  a key of scenes: the overlay open during this step
//           optional: leave the step out when its target isn't on screen
//                   (such as a button narrow screens don't have)
//   scenes: { key: { open, label, from } }
//           open:  opens the overlay and returns its dialog. The tour closes
//                  it when a step without that scene comes up, or at the end.
//           label: the popup's name, shown on its frame and in the card
//           from:  the button(s) that open it on the page (a target, as above)
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

// ---- boxes: { left, top, right, bottom } in viewport pixels ----------------------

const union = (a, b) => a ? (b ? { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) } : a) : b;
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const grow = (r, by) => r && { left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by };
const clip = (r, c) => {
  const b = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
  return b.right - b.left >= 1 && b.bottom - b.top >= 1 ? b : null;
};

// The box around elements. A panel's title sits on its top border, outside
// its box: it is taken in too, so a highlighted panel shows its name.
function boxOf(els) {
  let r = null;
  const add = (b) => { if (b.width >= 1 || b.height >= 1) r = union(r, { left: b.left, top: b.top, right: b.right, bottom: b.bottom }); };
  els.forEach((el) => {
    add(el.getBoundingClientRect());
    el.querySelectorAll('.mg-panel-title').forEach((t) => add(t.getBoundingClientRect()));
  });
  return r;
}

// Cut-outs in the hatching must not overlap (the overlap would be hatched
// again), so boxes that touch are merged.
function merged(boxes) {
  const out = [];
  boxes.filter(Boolean).forEach((b) => {
    for (let i = 0; i < out.length; i++) {
      if (overlaps(out[i], b)) { b = union(out.splice(i, 1)[0], b); i = -1; }
    }
    out.push(b);
  });
  return out;
}

const hole = (h) => 'M' + h.left + ' ' + h.top + 'H' + h.right + 'V' + h.bottom + 'H' + h.left + 'Z';
const put = (el, b) => Object.assign(el.style, { left: b.left + 'px', top: b.top + 'px', width: (b.right - b.left) + 'px', height: (b.bottom - b.top) + 'px' });
const sig = (b) => b ? [b.left, b.top, b.right, b.bottom].map(Math.round).join(',') : '-';

export function tourRunning() { return !!running; }

export function startTour({ name = 'Tutorial', steps, scenes = {}, onEnd }) {
  if (running) return;
  steps = steps.filter((s) => !s.optional || s.scene || visible(targets(s.target, null, document)).length);
  if (!steps.length) return;
  const returnFocus = document.activeElement;
  const root = document.createElement('div');
  root.className = 'mg-tour';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', name);
  const popover = typeof root.showPopover === 'function';
  if (popover) root.setAttribute('popover', 'manual');

  // Sections in order of first appearance, each with the steps in it.
  const sections = [];
  steps.forEach((s, i) => {
    let sec = sections[sections.length - 1];
    if (!sec || sec.name !== s.section) { sec = { name: s.section, steps: [], popup: false }; sections.push(sec); }
    sec.steps.push(i);
    if (s.scene) sec.popup = true;
    s.sec = sections.length - 1;
  });

  root.innerHTML =
    '<div class="mg-tour-shade" aria-hidden="true"></div>' +
    '<div class="mg-tour-shade soft" aria-hidden="true" hidden></div>' +
    '<div class="mg-tour-frame" aria-hidden="true" hidden><span class="tag">' + ic('popup') + '<span></span></span></div>' +
    '<div class="mg-tour-from" aria-hidden="true"></div>' +
    '<div class="mg-tour-spot" aria-hidden="true"></div>' +
    '<section class="mg-tour-card" tabindex="-1" aria-live="polite">' +
      '<div class="mg-tour-head"><span class="name">' + ic('tutorial') + '<span>' + esc(name) + '</span></span><span class="count"></span>' +
        '<button type="button" class="mg-btn small" data-tour="end" aria-label="End the tutorial">esc</button></div>' +
      '<div class="mg-tour-scene" hidden></div>' +
      '<div class="mg-tour-body"><div class="sec"></div><h2></h2><div class="txt"></div></div>' +
      '<div class="mg-tour-foot">' +
        '<button type="button" class="mg-btn quiet small" data-tour="end">' + ic('close') + '<span class="lbl">end tour</span></button>' +
        '<span class="mg-grow"></span>' +
        '<button type="button" class="mg-btn small" data-tour="back">' + ic('prev') + '<span class="lbl">back</span></button>' +
        '<button type="button" class="mg-btn small go" data-tour="next"></button>' +
      '</div>' +
    '</section>' +
    '<nav class="mg-tour-line" aria-label="Tutorial steps">' +
      '<div class="where"><span class="now"></span><span class="mg-grow"></span><span class="of"></span></div>' +
      '<div class="secs">' + sections.map((sec, si) =>
        '<div class="sec' + (sec.popup ? ' popup' : '') + '" data-sec="' + si + '" style="flex: ' + sec.steps.length + ' 1 0">' +
          '<span class="ticks">' + sec.steps.map((i) =>
            '<button type="button" class="tick' + (steps[i].scene ? ' popup' : '') + '" data-step="' + i + '" title="' +
              esc((i + 1) + '. ' + sec.name + ': ' + steps[i].title + (steps[i].scene ? ' (in a popup)' : '')) + '"></button>').join('') + '</span>' +
          '<span class="name">' + (sec.popup ? ic('popup') : '') + '<span>' + esc(sec.name) + '</span></span></div>').join('') +
      '</div>' +
    '</nav>';

  const [shade, soft] = root.querySelectorAll('.mg-tour-shade');
  const spot = root.querySelector('.mg-tour-spot');
  const frameEl = root.querySelector('.mg-tour-frame');
  const fromEl = root.querySelector('.mg-tour-from');
  const card = root.querySelector('.mg-tour-card');
  const sceneEl = root.querySelector('.mg-tour-scene');
  const line = root.querySelector('.mg-tour-line');
  const nextBtn = root.querySelector('[data-tour="next"]');
  const backBtn = root.querySelector('[data-tour="back"]');

  let at = -1;
  let scene = null;        // { key, dialog, def } of the overlay the tour opened
  let lastKey = '';        // what everything was last placed for, to skip needless work
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
    const def = key && scenes[key];
    if (!def) return;
    // The button that opens it must be on screen, to be shown beside it.
    const from = visible(targets(def.from, null, document));
    if (from.length) scrollClear(from[0]);
    const d = def.open();
    scene = { key, dialog: d || null, def };
    if (d) {
      d.classList.add('mg-toured');  // its own backdrop goes: the tour hatches the page instead
      mount(d);
    }
  }

  // Moves the popup next to the button that opened it (below or above,
  // wherever there is more room), so both can be seen, and keeps it clear
  // of the timeline. Where the screen is wide enough, it moves to the left,
  // so the card can sit beside it instead of over it.
  function fitDialog(d, from, vw, vh, availH) {
    const m = 18, MIN = 220;
    const side = vw - d.offsetWidth - card.offsetWidth >= 4 * m;
    d.style.marginLeft = side ? m + 'px' : '';
    d.style.marginRight = side ? 'auto' : '';
    let top = null, bottom = null, max = availH - 2 * m;
    if (from) {
      const below = availH - from.bottom - 2 * m, above = from.top - 2 * m;
      if (below >= MIN && below >= above) { top = from.bottom + m; max = below; }
      else if (above >= MIN) { bottom = vh - from.top + m; max = above; }
    }
    d.style.maxHeight = max + 'px';
    if (bottom !== null) { d.style.marginTop = 'auto'; d.style.marginBottom = bottom + 'px'; return; }
    if (top === null) top = Math.max(m, (availH - Math.min(d.offsetHeight, max)) / 2);
    d.style.marginTop = top + 'px';
    d.style.marginBottom = (vh - availH + m) + 'px';
  }

  // ---- placing the hatching, the highlight and the card ---------------------------

  const resolve = (t) => visible(targets(t, scene && scene.dialog, (scene && scene.dialog) || document));

  function place() {
    const step = steps[at];
    const vw = document.documentElement.clientWidth, vh = innerHeight;
    const availH = vh - line.offsetHeight;
    const screen = { left: 2, top: 2, right: vw - 2, bottom: availH - 2 };
    const d = scene && scene.dialog && scene.dialog.isConnected ? scene.dialog : null;
    const fromEls = scene ? visible(targets(scene.def.from, null, document)) : [];
    if (d) fitDialog(d, grow(boxOf(fromEls), 6), vw, vh, availH);

    const popup = d && clip(grow(boxOf([d]), 1), screen);
    let s = boxOf(resolve(step.target));
    s = s && clip(grow(s, 8), popup ? grow(popup, -1) : screen);
    const froms = merged(fromEls.map((el) => clip(grow(boxOf([el]), 5), screen)));
    const key = [s, popup].concat(froms).map(sig).join('|') + '|' + vw + 'x' + vh + '|' + at;
    if (key === lastKey) return;
    lastKey = key;

    root.classList.toggle('no-target', !s);
    if (s) put(spot, s);

    // Hatching everywhere but the highlight, the popup and the button that
    // opened it. The rest of the popup is hatched more lightly, so it reads
    // as the thing being toured, with the highlight inside it.
    const holes = merged([popup || s].concat(froms));
    shade.style.clipPath = 'path(evenodd, "M0 0H' + vw + 'V' + vh + 'H0Z' + holes.map((h) => ' ' + hole(h)).join('') + '")';
    soft.hidden = !popup;
    if (popup) soft.style.clipPath = 'path(evenodd, "' + hole(popup) + (s ? ' ' + hole(s) : '') + '")';

    // The popup's frame and name, and the outlined button that opened it.
    frameEl.hidden = !popup;
    if (popup) {
      put(frameEl, grow(popup, 4));
      frameEl.classList.toggle('tab-below', popup.top < 28);  // no room for the tab above
      frameEl.querySelector('.tag span').textContent = 'popup' + (scene.def.label ? ': ' + scene.def.label : '');
    }
    fromEl.innerHTML = froms.map(() => '<span class="ring"></span>').join('') +
      (froms.length ? '<span class="tag">' + ic('popup') + '<span>opened this popup</span></span>' : '');
    fromEl.querySelectorAll('.ring').forEach((ring, i) => put(ring, froms[i]));
    if (froms.length) {
      // The note goes beside the last button, on whichever side has room.
      const tag = fromEl.querySelector('.tag');
      const last = froms[froms.length - 1];
      const tw = tag.offsetWidth, th = tag.offsetHeight;
      const right = last.right + 6 + tw <= vw - 4;
      tag.style.left = (right ? last.right + 6 : Math.max(4, froms[0].left - 6 - tw)) + 'px';
      tag.style.top = Math.round((last.top + last.bottom) / 2 - th / 2) + 'px';
    }

    // The card goes beside the highlight: below, above, right or left; in a
    // popup, right or left first, so it covers as little of the popup as it can.
    const m = 10, gap = 14;
    card.style.maxHeight = Math.max(120, availH - 2 * m) + 'px';
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const clampX = (x) => Math.min(Math.max(m, x), vw - cw - m);
    const clampY = (y) => Math.min(Math.max(m, y), availH - ch - m);
    let x, y;
    if (!s) {
      x = (vw - cw) / 2; y = clampY((availH - ch) / 2);
    } else {
      const cx = (s.left + s.right) / 2, cy = (s.top + s.bottom) / 2;
      const ref = popup ? union(s, popup) : s;   // in a popup: beside the popup, not on it
      const sides = [
        () => s.bottom + gap + ch <= availH - m && [clampX(cx - cw / 2), s.bottom + gap],
        () => s.top - gap - ch >= m && [clampX(cx - cw / 2), s.top - gap - ch],
        () => ref.right + gap + cw <= vw - m && [ref.right + gap, clampY(cy - ch / 2)],
        () => ref.left - gap - cw >= m && [ref.left - gap - cw, clampY(cy - ch / 2)]
      ];
      const order = popup ? [2, 3, 0, 1] : [0, 1, 2, 3];
      let pos = null;
      for (const n of order) { pos = sides[n](); if (pos) break; }
      if (pos) { [x, y] = pos; }
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

  // Scrolled into view clear of the timeline and of a sticky page header
  // (inside a popup, just clear of its edges).
  function scrollClear(el) {
    const was = [el.style.scrollMarginTop, el.style.scrollMarginBottom];
    const inPopup = !!el.closest('dialog');
    el.style.scrollMarginTop = inPopup ? '12px' : '72px';
    el.style.scrollMarginBottom = inPopup ? '12px' : (line.offsetHeight + 16) + 'px';
    // In a popup, from the top: what follows the first element is in view too.
    el.scrollIntoView({ block: inPopup ? 'start' : 'nearest', inline: 'nearest' });
    [el.style.scrollMarginTop, el.style.scrollMarginBottom] = was;
  }

  // ---- moving between steps --------------------------------------------------------

  function go(i) {
    if (i < 0 || i >= steps.length) return;
    at = i;
    const step = steps[i];
    openScene(step.scene);
    const sec = sections[step.sec];
    root.querySelector('.mg-tour-head .count').textContent = (i + 1) + ' / ' + steps.length;
    root.querySelector('.mg-tour-body .sec').textContent = sec.name;
    root.querySelector('.mg-tour-body h2').textContent = step.title;
    root.querySelector('.mg-tour-body .txt').innerHTML = typeof step.text === 'function' ? step.text() : (step.text || '');
    sceneEl.hidden = !scene;
    if (scene) {
      sceneEl.innerHTML = ic('popup') + '<span><b>Inside a popup' + (scene.def.label ? ': ' + esc(scene.def.label) : '') + '</b>' +
        (scene.def.from ? '<span class="hint">opened by the button with the dashed outline</span>' : '') + '</span>';
    }
    card.classList.toggle('in-popup', !!scene);
    card.scrollTop = 0;
    backBtn.disabled = i === 0;
    const last = i === steps.length - 1;
    nextBtn.innerHTML = last ? ic('check') + '<span class="lbl">done</span>' : '<span class="lbl">next</span>' + ic('next');

    root.querySelector('.mg-tour-line .now').innerHTML = '<b>' + esc(sec.name) + '</b>' +
      (step.scene ? ' <span class="pop">' + ic('popup') + '<span>in a popup</span></span>' : '') +
      '<span class="mg-muted"> · section ' + (step.sec + 1) + ' of ' + sections.length + '</span>';
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

    lastKey = '';
    place();   // first: a popup is moved and resized here, before anything in it is scrolled to
    const els = resolve(step.target);
    if (els.length) scrollClear(els[0]);
    lastKey = '';
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
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'Escape') { take(); end(); return; }
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') { take(); if (at < steps.length - 1) go(at + 1); return; }
    if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') { take(); go(at - 1); return; }
    if (k === 'Home') { take(); go(0); return; }
    if (k === 'End') { take(); go(steps.length - 1); return; }
    if (k === 'Tab') {
      take();
      const f = Array.from(root.querySelectorAll('button:not(:disabled)')).filter((b) => b.getClientRects().length);
      const i = f.indexOf(document.activeElement);
      const n = i < 0 ? 0 : (i + (e.shiftKey ? -1 : 1) + f.length) % f.length;
      if (f[n]) f[n].focus();
      return;
    }
    // Enter and Space press the focused tour button; nothing else gets through.
    if (inTour && (k === 'Enter' || k === ' ')) { e.stopPropagation(); return; }
    take();
  }

  running = { end };
  addEventListener('keydown', onKey, true);
  mount(document.body);
  go(0);
  frame = requestAnimationFrame(loop);
}
