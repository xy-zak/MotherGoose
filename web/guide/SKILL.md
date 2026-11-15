---
name: mothergoose-pages
description: Write pages for MotherGoose, a server that shares a tabletop RPG's pages with players' devices over a local network. Pages are single self-contained HTML files (or Markdown) whose fields are saved and synced live. Use this when asked to make a character sheet, handout, tracker, map page or any other page for MotherGoose.
---

# Making HTML pages for MotherGoose

MotherGoose shows each page of a campaign in a tab on every player's phone, tablet or laptop. Anything typed into a page is **saved** and **synced live** to everyone who has it open. This guide explains how to write a page that works well. It is also an AI skill: give it to an AI assistant and ask for the page you want.

A page can be:

- **an HTML file** (`.html`), up to 32 MB. This guide is mostly about these.
- **a Markdown file** (`.md`), up to 8 MB. It is shown as a tidy page in the reader's own theme and font. Task-list boxes (`- [ ] find the key`) can be ticked, and are saved and synced. Raw HTML inside Markdown is left out.
- a PDF, PNG or JPEG. These are shown in MotherGoose's own viewers and need nothing from you.

## The one rule: everything in one file

A page is **one file**. MotherGoose stores and serves just that file, so anything it tries to load from beside it (`style.css`, `img/map.png`, `app.js`) can never load. MotherGoose **refuses** an upload that does this, and says which files it found.

Put everything inside the page:

- **CSS** in a `<style>` element in the `<head>`.
- **JavaScript** in a `<script>` element (no `src`).
- **Images** as `data:` URLs, for example `src="data:image/png;base64,iVBOR…"`. Small pictures can also be inline `<svg>`.
- **Fonts**: use font stacks that already exist (`system-ui`, `Georgia`, `ui-monospace`), or follow MotherGoose's theme (below), or embed a font as a `data:` URL in `@font-face`.

Links to other websites (`<a href="https://…">`) are fine: they only open when clicked. Loading things **from the internet** (Google Fonts, a CDN script, a remote image) is allowed, but MotherGoose warns about it: it only works while the device viewing the page has internet, and many game tables don't.

## Fields that save and sync

MotherGoose adds a small script to every page it serves. That script saves and syncs:

- every `<input>`, except `type="password"`, `file`, `hidden`, and buttons (`submit`, `button`, `reset`, `image`);
- `<textarea>`;
- `<select>`, including `multiple`;
- any element with `contenteditable` (only the outermost one, if they're nested).

**Give every field an `id` or a `name`.** That is how a saved value finds its field again. A field with neither is matched by its position in the page, and loses its value as soon as the layout changes. MotherGoose warns about unnamed fields when a page is uploaded.

Other details:

- Radio buttons that share a `name` are saved as one choice.
- Checkboxes save `true` or `false`; a multiple `<select>` saves its chosen values.
- Add `data-mg-ignore` to an element (or a container) to keep it, and every field inside it, out of saving and syncing. Use this for search boxes, filters, or anything that's only for one device.
- Editable areas keep formatting: bold, italics, lists, headings, tables, links and pasted images. Anything else arriving from another device is removed before it is shown: scripts, event handlers, frames, forms, SVG and remote images.
- When two people change the same field at the same moment, the last change wins. A field being typed in isn't changed under the cursor: the other device's change waits until the field loses focus.

### Calculated fields

The page's own scripts keep working. After restoring saved values, MotherGoose fires `input` and `change` events on each field, so code that listens for those (for example, working out a modifier from a score) updates by itself. Write calculations as event listeners, not as code that runs once at load.

A field whose value is only ever calculated should usually have `data-mg-ignore` or be an `<output>` element, so it isn't saved twice.

## Custom state: the MotherGoose API

For things that aren't form fields (a clickable hit-point tracker, tokens on a map, a turn marker), use `window.MotherGoose`:

```js
MotherGoose.set('hp', 17);              // save any JSON value (null deletes it)
MotherGoose.get('hp');                  // read it back
MotherGoose.on('hp', v => render(v));   // called now (if saved) and whenever another device changes it
MotherGoose.status();                   // 'connecting' | 'live' | 'offline' | 'closed' | 'offline-copy'
MotherGoose.offline;                    // true in an exported copy, with no server
```

Things to know:

- **The script is added at the end of the page.** Your own scripts run before `window.MotherGoose` exists, so start them on `DOMContentLoaded`, which comes after it.
- **`set()` doesn't call your own `on()` listener.** `on()` hears other devices' changes. After calling `set()`, update your page yourself.
- Values can be anything JSON can hold, up to 1 MiB each.
- Check `if (window.MotherGoose)` first if the page should also work when opened on its own, without MotherGoose.
- **Security:** values come from any device on the network. Show them with `textContent`, `value` or `setAttribute`, **never with `innerHTML`**, so nobody can run code on someone else's screen.

A small pattern that works:

```js
document.addEventListener('DOMContentLoaded', () => {
  const mg = window.MotherGoose;
  let hp = (mg && mg.get('hp')) ?? 10;
  const out = document.getElementById('hp-out');
  const show = () => { out.textContent = hp; };
  const change = (d) => { hp += d; show(); if (mg) mg.set('hp', hp); };
  document.getElementById('hp-down').addEventListener('click', () => change(-1));
  document.getElementById('hp-up').addEventListener('click', () => change(1));
  if (mg) mg.on('hp', (v) => { hp = v ?? 10; show(); });
  show();
});
```

## Looking like MotherGoose (optional)

A page keeps its own look by default. To follow each reader's MotherGoose **colour theme** and **font** (chosen in Display settings, including fonts for low vision and dyslexia), add this to the `<head>`:

```html
<meta name="mothergoose" content="theme">
```

MotherGoose then adds its design tokens to the page as CSS custom properties, and keeps them in step with the reader's settings. Use them with fallbacks, so the page still looks right when opened on its own (for example an exported copy):

| Token | What it is |
|---|---|
| `--bg` | the page background |
| `--bar` | a slightly darker band, for headers |
| `--deep` | the darkest background: inputs, wells |
| `--surface` | raised boxes and hovered rows |
| `--line`, `--line-strong` | borders and dividers |
| `--text`, `--muted` | body text, secondary text |
| `--accent`, `--on-accent` | the highlight colour, and text on it |
| `--players`, `--referee` | the players' blue and the referee's orange |
| `--live`, `--warn`, `--danger` | green, yellow, red |
| `--font` | the reader's chosen font |
| `--fs-title`, `--fs-body`, `--fs-small` | the three text sizes |

```css
:root { --bg: #eff1f5; --text: #4c4f69; --line: #bcc0cc; --accent: #8839ef;
        --font: ui-monospace, monospace; }          /* fallbacks: Catppuccin Latte */
@media (prefers-color-scheme: dark) {
  :root { --bg: #1e1e2e; --text: #cdd6f4; --line: #45475a; --accent: #cba6f7; }
}
body { background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); }
.box { border: 1px solid var(--line); }
```

MotherGoose's own style: square corners, 1px lines, small uppercase panel titles, and the accent colour for focus and the main action.

## Per-player pages

The referee can mark a players' page **per player** (in its info). Every player in the campaign's party then gets their own copy, seen only by them and the referee. Nothing changes in how you write the page: write one sheet, and MotherGoose keeps a copy per player. Anything the referee fills into the page first becomes the **starting copy**: every player's copy starts from it.

## Size, and where it's shown

- Pages are shown in a frame filling the screen under two slim bars, on anything from a phone to a laptop. Use `<meta name="viewport" content="width=device-width, initial-scale=1">` and a layout that works at 360 px wide.
- Keep the page readable on its own: give it a `<title>`. It names the page's tab (the referee can give it another title in its info).
- **Tablets are common at the table.** Make anything tapped at least 40 px high (36 px for small buttons), with some space between, and give inputs a font size of at least 16 px, or iOS zooms in when one is tapped. Use `pointerdown` or `click`, never hover alone, to show something. A simple way to do this is one block for coarse pointers:

  ```css
  @media (pointer: coarse) {
    button, input, select { min-height: 40px; font-size: 16px; }
    input[type=checkbox], input[type=radio] { width: 22px; height: 22px; }
    button { touch-action: manipulation; }   /* no double-tap zoom on steppers */
  }
  ```
- **Motion.** With `<meta name="mothergoose" content="theme">`, `<html>` gets `data-anim` from the reader's settings: `full`, `reduced` or `off`. Gate animations on it, and on `prefers-reduced-motion`:

  ```css
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  html[data-anim="off"] * { animation: none !important; transition: none !important; }
  ```
- Big embedded images make a page slow to open on phones. Shrink pictures before embedding them.

## Checklist

1. One file: no `src`, `href` (on `<link>`) or `url()` pointing at another file. Images are `data:` URLs.
2. Every field has an `id` (or a `name`; radio groups share a `name`).
3. Scripts start on `DOMContentLoaded`, and calculations listen for `input` / `change`.
4. Custom state goes through `MotherGoose.set / get / on`, shown with `textContent`, never `innerHTML`.
5. Fields only for one device have `data-mg-ignore`.
6. A `<title>`, and the viewport meta tag.
7. Tap targets of 40 px and inputs of 16 px on touch screens.
8. Optionally, `<meta name="mothergoose" content="theme">` with token fallbacks.

## A complete example

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="mothergoose" content="theme">
<title>Ranger sheet</title>
<style>
  :root { --bg: #eff1f5; --surface: #ccd0da; --line: #bcc0cc; --text: #4c4f69; --muted: #6c6f85;
          --accent: #8839ef; --font: ui-monospace, monospace; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1e1e2e; --surface: #313244; --line: #45475a; --text: #cdd6f4; --muted: #a6adc8; --accent: #cba6f7; }
  }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); }
  .box { border: 1px solid var(--line); padding: 10px; margin-bottom: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  input, textarea { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); padding: 4px 6px; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  textarea { width: 100%; box-sizing: border-box; min-height: 6em; }
</style>
</head>
<body>
  <div class="box"><h2>Who</h2>
    <input id="name" placeholder="name"> <input id="level" type="number" min="1" value="1" style="width:4em">
  </div>
  <div class="box"><h2>Hit points</h2>
    <button id="hp-down" type="button">−</button> <b id="hp-out">10</b> <button id="hp-up" type="button">+</button>
  </div>
  <div class="box"><h2>Notes</h2><textarea id="notes"></textarea></div>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const mg = window.MotherGoose;
      let hp = (mg && mg.get('hp')) ?? 10;
      const out = document.getElementById('hp-out');
      const show = () => { out.textContent = hp; };
      const change = (d) => { hp += d; show(); if (mg) mg.set('hp', hp); };
      document.getElementById('hp-down').addEventListener('click', () => change(-1));
      document.getElementById('hp-up').addEventListener('click', () => change(1));
      if (mg) mg.on('hp', (v) => { hp = v ?? 10; show(); });
      show();
    });
  </script>
</body>
</html>
```

## Trying it

Drop the file on the **Players** or **Referee** column of the referee's dashboard, or copy it into the campaign's `shared/` or `gm/` folder. Open it with **open ↗**, type something, and open it again on another device: it should appear there straight away. The page's **info** shows what MotherGoose found when it checked the page.
