// Retro effects shared by both dashboards (the CSS is in theme.css, under
// "motion"). How much plays is the device's Display setting: data-anim on
// <html> is "full", "reduced" or "off" (see prefs.js).
//
//   switchLinks()  links marked data-switch="players" or "referee" lead to the
//                  other dashboard: this screen switches off like an old CRT
//                  (line, dot, static), and prefs.js on the next page switches
//                  it back on. A link opening a new tab only leaves the note.
//   bootScreen()   the terminal screen shown when a session goes live or ends.
import { esc } from '/_mg/ui.js';

export const motion = () => document.documentElement.getAttribute('data-anim') || 'full';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- switching dashboards ------------------------------------------------------

/** noteSwitch tells the next page it was opened from the other dashboard. */
export function noteSwitch(to) {
  try { localStorage.setItem('mg-switch', JSON.stringify({ to, at: Date.now() })); } catch (e) {}
}

export function switchLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-switch]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    noteSwitch(a.dataset.switch);
    if (a.target === '_blank') return;   // the new tab switches on by itself
    const lvl = motion();
    if (lvl === 'off') return;
    e.preventDefault();
    leave(a.href, lvl);
  });
  // Back to this page from the browser's cache: it must not stay switched off.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    document.documentElement.classList.remove('mg-leave');
    document.querySelectorAll('.mg-static').forEach((el) => el.remove());
  });
}

async function leave(url, lvl) {
  const root = document.documentElement;
  root.classList.add('mg-leave');
  if (lvl === 'full') {
    await wait(330);
    const st = document.createElement('div');
    st.className = 'mg-static';
    st.setAttribute('aria-hidden', 'true');
    root.appendChild(st);
    await wait(170);
  } else {
    await wait(140);
  }
  location.href = url;
}

// ---- going live / ending ---------------------------------------------------------

let currentBoot = null;

/**
 * bootScreen shows a terminal screen over everything, typing out its lines,
 * then switches off to show the page. It resolves once it has gone. A click
 * or any key skips it.
 *   end:   the shutdown screen (amber) instead of the boot screen (green)
 *   lines: [{ k: text, ok: 'OK' }] (ok is optional: a dotted leader, then it)
 *   big:   the last line, large: "SESSION LIVE"
 */
export function bootScreen({ end = false, lines = [], big = '' }) {
  const lvl = motion();
  if (lvl === 'off') return Promise.resolve();
  if (currentBoot) currentBoot();   // a newer one replaces it at once

  const el = document.createElement('div');
  el.className = 'mg-boot on' + (end ? ' end' : '');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-label', big);
  const popover = typeof el.showPopover === 'function';
  if (popover) el.setAttribute('popover', 'manual');
  el.innerHTML = '<div class="scr" aria-hidden="true"><div class="brand">MOTHERGOOSE</div></div>' +
    '<span class="skip" aria-hidden="true">click or press any key to skip</span>';
  const scr = el.querySelector('.scr');
  document.body.appendChild(el);
  if (popover) { try { el.showPopover(); } catch (e) {} }

  const lineEl = (l, isBig) => {
    const d = document.createElement('div');
    d.className = 'ln' + (isBig ? ' big' : '');
    d.innerHTML = '<span class="k"></span>' + (l.ok ? '<span class="dots" hidden></span><span class="ok" hidden>' + esc(l.ok) + '</span>' : '');
    scr.appendChild(d);
    return d;
  };
  const all = lines.map((l) => ({ l, big: false })).concat(big ? [{ l: { k: big }, big: true }] : []);

  return new Promise((resolve) => {
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      currentBoot = null;
      removeEventListener('keydown', onKey, true);
      el.classList.remove('on');
      el.classList.add('off');
      setTimeout(() => {
        if (popover) { try { el.hidePopover(); } catch (e) {} }
        el.remove();
        resolve();
      }, lvl === 'full' ? 360 : 200);
    };
    currentBoot = finish;
    const onKey = (e) => { if (/^(Shift|Control|Alt|Meta)$/.test(e.key)) return; e.preventDefault(); e.stopPropagation(); finish(); };
    addEventListener('keydown', onKey, true);
    el.addEventListener('click', finish);

    const cursor = () => { scr.querySelectorAll('.cur').forEach((c) => c.remove()); const c = document.createElement('span'); c.className = 'cur'; return c; };

    (async () => {
      if (lvl !== 'full') {
        // Reduced: everything at once, held long enough to read.
        all.forEach(({ l, big: b }) => {
          const d = lineEl(l, b);
          d.querySelector('.k').textContent = l.k;
          d.querySelectorAll('[hidden]').forEach((x) => { x.hidden = false; });
        });
        await wait(1100);
        finish();
        return;
      }
      await wait(240);   // while the screen switches on
      for (const { l, big: b } of all) {
        if (over) return;
        const d = lineEl(l, b);
        const k = d.querySelector('.k');
        const text = String(l.k);
        // Typed out, at most ~150ms a line however long it is.
        const per = Math.max(1, Math.ceil(text.length / 18));
        for (let i = 0; i < text.length && !over; i += per) {
          k.textContent = text.slice(0, i + per);
          d.appendChild(cursor());
          await wait(8);
        }
        if (l.ok) {
          await wait(70);
          d.querySelectorAll('[hidden]').forEach((x) => { x.hidden = false; });
        }
        await wait(b ? 0 : 60);
      }
      if (over) return;
      scr.lastElementChild.appendChild(cursor());
      await wait(650);
      finish();
    })();
  });
}
