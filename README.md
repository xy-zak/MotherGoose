# MotherGoose

A small server for running tabletop RPG sessions over your local network. It runs on the referee's computer (the game master, GM or DM).

A **campaign** is a folder of pages, such as character sheets, a player handout, the referee's notes, a rulebook PDF or a map. You make these anywhere you like, or start from MotherGoose's templates, then drop them in. Each campaign has a **game type**, the game or rules being played, written in your own words and shown next to its name so you can tell your campaigns apart. A **session** is one evening of play: from **go live** to **end session**.

| Page type | Files | What players get |
|---|---|---|
| HTML page | `.html`, `.htm` (up to 32 MB) | The page itself. Anything typed into it is saved and synced live. It must be one self-contained file. |
| Markdown | `.md`, `.markdown` (up to 8 MB) | A tidy page in the reader's own theme and font. Task-list boxes (`- [ ] find the key`) can be ticked, and are saved and synced. |
| PDF | `.pdf` (up to 100 MB) | A built-in viewer that works the same on phones, tablets and laptops: page numbers, zoom, fit to width. Fillable PDFs (for example official character sheets) can be filled in, are saved and synced like HTML pages, run their own calculations, and can be downloaded filled in. |
| Image | `.png`, `.jpg`, `.jpeg` (up to 32 MB) | Fitted to the screen. Tap or click for actual size, and scroll around. |

MotherGoose checks that a PDF or image really is one before accepting it, and that an HTML or Markdown page is self-contained (see *Making pages for MotherGoose*).

- **Players** pages can be opened by every player on the same Wi-Fi or LAN. They're marked in **blue** everywhere.
- **Referee** pages open only on the computer running MotherGoose. They're marked in **orange** everywhere.
- A players' page can be **hidden** until the referee reveals it, and shown to **only some players**, for example a clue only one character found. Players aren't told about pages they can't see.
- Every page can have a **description** and **tags** (for example `map`, `handout`, `level 2`). Players see them for their pages, in the page's details, and both dashboards can filter by tag.
- Anything typed into a page is **saved** and **synced live** to everyone viewing it. That covers text boxes, checkboxes, dropdowns and editable areas, and the fields of fillable PDFs.
- A players' page can be **per player**, such as a character sheet: each player in the campaign's party gets their own copy, which only they and the referee can see.

MotherGoose is one program with nothing to install.

---

## Running it

Download the file for your computer from the [latest release](https://github.com/xy-zak/MotherGoose/releases/latest), or build it yourself (see below):

| Computer | File |
|---|---|
| Windows | `mothergoose-windows-amd64.exe` (`-arm64` for ARM laptops) |
| Mac (Apple silicon) | `mothergoose-darwin-arm64` |
| Mac (Intel) | `mothergoose-darwin-amd64` |
| Linux | `mothergoose-linux-amd64` (`-arm64` for a Raspberry Pi and similar) |

Put it in its own folder, for example `Documents/MotherGoose/`, and start it:

- **Windows:** double-click the `.exe`.
  - If SmartScreen warns you, choose *More info → Run anyway*.
  - When the firewall asks, allow access on **private networks**, otherwise players can't connect.
- **Mac:** right-click the file and choose **Open**, then **Open** again. This step is only needed the first time, because the app isn't signed.
  - Alternatively, in Terminal: `xattr -d com.apple.quarantine mothergoose-darwin-arm64 && ./mothergoose-darwin-arm64`
- **Linux:** `chmod +x mothergoose-linux-amd64 && ./mothergoose-linux-amd64`
  - If a firewall blocks players, the dashboard says so and offers to let them in (see *Players can't join?* below).

The dashboard opens in your browser, and a console window shows the addresses:

```
  MOTHERGOOSE

  Referee (this computer)      http://localhost:8080/admin
  Players (same network)       http://192.168.1.20:8080/
  Players (by name)            http://game-laptop.local:8080/  (if the network supports it)

  Data folder  /Users/you/Documents/MotherGoose/data
```

Players open the **Players** address on their phone, tablet or laptop. You can also have them scan the QR code on the dashboard. Close the console window, or press Ctrl+C, to stop the server. Everything is saved as you go.

**The address that doesn't change.** The number address (`192.168.1.20`) often changes from one game night to the next. Most networks also answer to the computer's name, `<name>.local`: macOS, most Linux desktops and Windows 10 or later announce it. **Join Info** tries that address from the referee's computer, and when it works, offers it first, with its own QR code. A device remembers its player name and tab order per address, so it's easiest if everyone keeps to one.

### Options

```
mothergoose --port 9000        # use another port (default 8080; tries the next few if busy)
mothergoose --data D:\dnd      # keep campaigns somewhere else (default: "data" next to the program)
mothergoose --no-browser       # don't open the dashboard on start
```

---

## Running a session

1. In the dashboard (`/admin`), create a campaign. Give it a name and, optionally, a game type.
2. Drag `.html`, `.md`, `.pdf`, `.png` or `.jpg` files into **Players** or **Referee**, or use **+ add**, which offers a **template** (a ready-made page) or a **file** from your computer. Drag a page up or down to reorder it (players' tabs follow the same order), or onto the other panel to change which side it's on. Uploads show their progress on the column, and say when a page of the same name was replaced (its entries and details are kept).
3. Click **▶ go live** to start a session. Only one campaign is live at a time, and players see its shared pages as tabs. A short boot screen plays on the referee's and the players' screens, then a notice offers **join info**. If another campaign is live, the button reads **switch live here** and asks first.
4. Click **■ end session** when you're done. Players see a shutdown screen at once and return to a waiting screen, and every entry is kept for next time. The notice that follows has **undo**, which starts it again.

When the dashboard opens, **Getting started** pops up: everything the app does, one line each, with buttons for both tutorials and the guide to making pages. **do not show again** stops it opening (the **ⓘ about** button at the top left brings it back).

**Players can't join?** On Linux, a firewall (such as `ufw`, which Omarchy turns on, or `firewalld`) silently drops players' connections, and never asks. MotherGoose checks whenever the dashboard opens. If the firewall blocks players, a yellow warning appears at the top of Getting started and Join Info (and on its own, even with Getting started turned off), with **let players in**. That button asks for your password in the desktop's own prompt, then opens MotherGoose's port to devices on your local network only. It also shows the command to run in a terminal instead. The same warning is printed when MotherGoose starts. If a session has been live for three minutes and no player's device has joined, a notice says so. Windows and macOS ask by themselves the first time: allow access on private networks.

The dashboard has two panes. The campaigns list is on the left and the selected campaign is on the right (on narrower screens the list folds up above it). While a session is live, the party shows which players' devices are connected ("here", "away", or "2 devices" when two picked the same name).

Each page row has **hide** / **reveal** (players' pages), **open ↗**, **info** and **⋯**, a menu with **point here** (while live: ask every player who can see it to look at it now), **move up** / **move down** (or Alt+↑/↓ on a focused row), **move to referee / players**, **clear entries** and **delete**. Revealing waits four seconds with **undo**, in case of a slip; hiding is immediate. While a session is live, pages added or moved to the players' side start hidden, so nothing reaches players before you're ready.

Above the columns, the campaign's tags filter the pages (pick one or more; this device remembers it; **clear filter** shows them all). **info** opens the page's details:

- **Details**: a **title** (what tabs and lists call it, in place of the page's own), its file name (the type stays the same), description and tags (as chips, with suggestions from your other pages).
- **Who sees it** (players' pages): **per player**, and who can see it.
- **Copies** (per-player pages): the party, to add or remove players straight away, and each copy with when it last changed.
- **More about this page**: what MotherGoose found when it checked the page (files it can't load, things it loads from the internet, fields without a name), its type, size and entries.

**save** applies everything together; closing with unsaved changes asks first. The footer also has **open** and **export filled** (a copy with every entry filled in: an HTML copy works offline, a PDF copy is a normal filled-in PDF). An **Actions** section at the end of the popup has move, clear entries and delete.

Deleting or clearing always asks first, and nothing is gone at once: deleted pages and campaigns, cleared entries and removed players go to the trash for 30 days. The notice that follows has **undo**, and **data folder** lists the trash, with **put back** and **empty the trash**.

A campaign's **more** menu has **export all**, a .zip of every page filled in (each player's copy beside a per-player page, and PDFs with their entries as JSON), and **duplicate**, a new campaign with the same pages, details and order (and the party, if you like) but nothing typed into them: handy for running the same adventure for another group. **join info** in the top bar shows the players' address and a QR code, with **show to the table** for a full-screen version, and **data folder** shows where everything is stored, with a button to open it in your file explorer.

**edit** on a campaign changes its name or game type. On the host computer, the player view (`/`) also shows the referee pages, in their own orange group of tabs. On every other device they are hidden and refused.

### Templates

**+ add**, then **template**, adds a ready-made page, with a live preview (↑ ↓ to choose, Enter to add). They work with any game, look like MotherGoose, and follow each reader's theme and font:

| Template | What it is |
|---|---|
| Character sheet | Name, concept, six stats you rename, resources with − and +, abilities, inventory, notes. Added **per player**. |
| Notes | Rich-text notes with headings, lists and quotes. |
| Tracker | Counters with − and + (health, ammo, coins…) and conditions you tap on or off. |
| Turn order | Names and order, sorted with one tap, a marker on whoever's turn it is, and the round. |
| Clocks | Progress clocks of 4 to 12 segments, and a countdown timer. |
| Party loot | The party's money and shared items: who carries what. |
| Handout | A letter on paper, added **hidden**: write it, lock it, then reveal it. Only the referee can unlock it. |

Once added, a template is an ordinary page: rename it, give it a title, change its details, or edit the file. Adding one twice titles the second "Notes 2".

### Who sees a players' page

A players' page's **info** has **Who can see it**:

- **every player** (the default), or **only these players**: tick their names. Ticking nobody keeps it for the referee alone.
- **hidden until I reveal it**: no player sees it, not even its name, while you prepare it. **reveal** on its row (or unticking it) shows it to whoever is chosen above.

To check what a player sees, open the player view on the host computer and use **view as** to see exactly what that player's device shows.

Players are never told that a page is hidden, or meant for someone else: it simply isn't there for them, and asking for it by its address gets "not found". When a page is revealed (or added) while they watch, players get a note with a button to open it, and its tab gets a dot until they do. **point here** asks every player who can see a page to look at it now; their device asks them first.

This works on the name each device picked (see below), so it keeps pages out of the way rather than secret.

### The player view

The top of the player view has two slim rows:

- **Info bar:** campaign name, connection status (**waiting**, **connected**, or **offline**: changes are kept and sent when back), theme. Tap the campaign name or the status for details.
- **Tab bar:** one tab per page, numbered, with PDF and image pages marked by an icon. The open tab is tinted blue for players' pages and orange for the referee's. **pages** lists every page with a search box: the quickest way to find one on a tablet.
  - **Drag tabs** (on a touch screen, hold one first) to put them in your own order. It's kept on that device only.
  - When the tabs don't all fit, the others shrink by themselves; the open tab always stays full size.
  - A **dot** marks a page this device hasn't opened yet, a **ring** one that changed since it was last opened.
  - **filter** (or `t`) shows only the tabs with the tags you pick, on this device.
  - A **!** marks a tab whose page is reconnecting on its own; what's typed there is kept.

Press **⤢ full** (or `f`) for full screen. The browser goes full screen where it can, and MotherGoose hides everything except a thin row of tabs at the top. Press **⤡ shrink** at the top right, or `Esc`, to come back. On iPhones, which don't support browser full screen, you still get the full-screen layout.

PDFs open in MotherGoose's viewer: page numbers, zoom (pinch, or double-tap, on a touch screen), fit to width, **search** (`/` or Ctrl+F, with the matches highlighted) and, when the PDF has one, its **contents** (`o`), to jump to a chapter. A scanned PDF has no text, so search says so.

The help button (`?`) and the dashboard's Getting started have a **referee tutorial** or **player tutorial**: a guided tour of the dashboard you are on, one part at a time. The referee's tour uses an example campaign, so nothing real changes.

Keyboard shortcuts (press `?` to see them): `Ctrl+K` or `/` jump to a page by name or tag (`#map`), `f` full screen, `1`–`9` jump to a tab, `[` `]` previous/next tab, `t` filter the tabs, `i` details. In the dashboard: `Ctrl+K` or `/` jump to any campaign, page, tag or player, `n` new campaign, `↑` `↓` move through campaigns, `e` edit the campaign, `p` add a player to the party, `u` add players' pages, `j` join info. On a touch screen, help lists the gestures instead.

### Players and per-player sheets

Each campaign has a **PARTY**: the players' names, added under **PARTY** in the campaign panel of the referee's dashboard.

- **Who are you?** On a player's device, per-player tabs ask the player to pick their name from the roster. The device remembers it. **not you?** in the player view's header switches to another name, and a strip on per-player pages says whose copy it is.
- **Per-player pages:** in a players' page's **info**, tick **per player** and **save**. That one file becomes the **starting copy**: every player gets their own copy, with their own entries, saved and synced separately. HTML pages and fillable PDFs both work.
- **Starting values:** anything the referee fills into the starting copy is copied into a player's sheet the first time they open it. A player added later starts from the same starting copy.
- **Only their own copy:** a player's device only ever gets the copy of the player it picked: never another player's, and never the starting copy itself.
- **The referee's view:** on the host computer, a per-player tab has a strip at the top to switch between the starting copy and each player's copy (with a warning while the starting copy is selected). In the dashboard, a per-player page's row names each player, shaded once they've filled in their copy, and its **info** lists every copy with open, export filled and clear entries.
- **Turning per player off** goes back to the single shared copy. Everyone's copies stay on disk and come back if you turn it on again.
- **Removing a player** asks whether to keep their entries. They're kept by default and come back if a player with the same name is added again; either way, **undo** (or **put back** in the trash) restores the player as they were. Pages shown only to them stop listing them (and stay hidden from everyone else).

Choosing a name is an honour system, not a login: anyone can pick any name. It keeps sheets out of each other's way rather than secret.

### Display settings

The UI is a terminal-style layout in the [Catppuccin](https://catppuccin.com) palette. **display** (the gear icon) in the top bar sets four things, and each device remembers its own choice:

- **Colour theme:** **Auto** (Latte when the device is in light mode, Mocha in dark mode), **Latte**, **Frappé**, **Macchiato** or **Mocha**.
- **Font:** JetBrains Mono (the default), **Atkinson Hyperlegible Mono** or **Atkinson Hyperlegible**, both designed for readers with low vision, **OpenDyslexic** for dyslexic readers, or the device's own font.
- **Buttons show:** icons and text, icons only (names appear on hover and are read out by screen readers), or text only.
- **Animations:** retro CRT effects (popups switch on like an old monitor, switching between the player view and the referee's dashboard changes channel, and sessions boot up and shut down), **Reduced** (quick fades) or **Off**. **Auto**, the default, uses Reduced when the device asks for less motion.

These change MotherGoose itself, Markdown pages, the templates, and any page that asks to follow them (see *Looking like MotherGoose*). Other pages keep their own fonts and colours.

---

## The data folder

Everything lives in plain folders you can browse, back up or edit by hand:

```
data/
  config.json                 which campaign is live
  sessions/                   one folder per campaign
    the-sunken-keep/
      session.json            name, game type, party, page descriptions, tags, per-player switches, who sees what
      shared/                 players' pages
        intro.html
        aria-sheet.html
      gm/                     referee's pages (only the host computer can open them)
        gm-notes.html
      state/                  what people have typed (managed by MotherGoose)
        shared/aria-sheet.html.json
        gm/gm-notes.html.json
        players/ana/aria-sheet.html.json   Ana's copy of a per-player page
  trash/                      what was deleted or cleared, kept for 30 days (put back from "data folder")
```

- **Adding pages by hand:** copy `.html`, `.md`, `.pdf`, `.png` or `.jpg` files into `shared/` (players) or `gm/` (referee). The folder names are kept from earlier versions, so older data folders keep working. They appear in the dashboard and in players' tabs within a couple of seconds.
- **Adding a campaign by hand:** create a folder in `sessions/` with `shared/` and/or `gm/` inside it. (Campaigns are kept in `sessions/`, and their details in `session.json`, as in earlier versions.)
- **Replacing a page:** upload or copy a file with the same name. The entries already typed into it, and its description and tags, are kept.
- **Editing by hand:** `session.json` is plain JSON, with `gameType` and a `pages` object (for example `"shared/intro.html": {"description": "...", "tags": ["handout"], "hidden": true, "audience": "only", "allowed": ["ana"]}`). Changes show up within a couple of seconds.
- **Backing up:** copy the `data` folder. To keep one campaign's filled-in pages, use **export all** in its **more** menu.
- **Broken files:** if a `.json` file can't be read, for example after a hand edit with a typo, MotherGoose renames it to `<name>.corrupt-<date>` and starts that file fresh. It never overwrites it, so you can fix it and copy it back.

---

## Making pages for MotherGoose

PDFs and images work as they are. For your own pages, write an `.html` file, or a `.md` Markdown file. **Help → Making HTML pages** in the dashboard is the full guide ([`web/guide/SKILL.md`](web/guide/SKILL.md)). It doubles as an **AI skill**: download it from that page (for Claude Code, save it as `~/.claude/skills/mothergoose-pages/SKILL.md`) or copy it into any AI chat, then ask for the page you want.

In short:

- **A page is one file.** Put CSS in `<style>`, scripts in `<script>`, and images in as `data:` URLs. MotherGoose **refuses** a page that loads files from beside it (`style.css`, `img/map.png`), since they could never load, and says which. It warns about things loaded from the internet (they only work while the device has internet) and fields without a name. Pages copied into the folder by hand are checked in their **info**.
- MotherGoose never changes your file. When it serves a page, it adds a small script that saves and syncs `<input>` (except password, file, hidden and buttons), `<textarea>`, `<select>` and `contenteditable` elements.
- **Give fields an `id` or a `name`.** That is how a saved value finds its field. Fields without one are matched by position, and lose their values when the layout changes. Radio buttons sharing a `name` are one choice.
- Your page's scripts keep working: after restoring values, MotherGoose fires `input` and `change` events, so calculated fields update. Add `data-mg-ignore` to keep an element (or a container) out of saving and syncing.
- Editable areas keep formatting (bold, lists, headings, tables, links, pasted images). Anything else arriving from another device is removed before it's shown (scripts, event handlers, frames, forms, SVG, remote images), so no one can run code on someone else's screen.
- **Markdown pages** are shown in the reader's theme and font. Task-list boxes (`- [ ] item`) are saved and synced; raw HTML in them is left out.

### Saving custom state

For things that aren't form fields, such as a clickable HP tracker or a map with tokens, use the small API that MotherGoose adds to every page:

```js
MotherGoose.set('hp', 17);              // save any JSON value (null deletes it)
MotherGoose.get('hp');                  // read it back
MotherGoose.on('hp', v => render(v));   // called now (if saved) and whenever another device changes it
MotherGoose.status();                   // 'connecting' | 'live' | 'offline' | 'closed' | 'offline-copy'
```

The script is added at the end of the page, so start your own code on `DOMContentLoaded`. `set()` doesn't call your own `on()` listener: update the page yourself after setting. Check `if (window.MotherGoose)` first if the page should also work when opened without the server.

Values from `MotherGoose.get` and `MotherGoose.on` can come from any device on the network. Show them with `textContent`, `value` or `setAttribute`, never with `innerHTML`, so a player can't run code in a page the referee opens.

When two people edit the same field at the same moment, the last change wins. If someone is typing in a field when another device changes it, their cursor isn't disturbed: the update waits until they leave the field.

### Looking like MotherGoose

Add `<meta name="mothergoose" content="theme">` to a page's `<head>` and it follows each reader's MotherGoose colour theme and font. MotherGoose adds its design tokens as CSS custom properties (`--bg`, `--surface`, `--line`, `--text`, `--muted`, `--accent`, `--font`, `--fs-body` and more; the guide lists them), kept in step with Display settings. Use them with fallbacks, so the page still looks right on its own, for example as an exported copy. The templates are written this way.

---

## Security notes

MotherGoose is meant for a trusted home or club network.

- **Players need no login.** Anyone on the network can open the shared pages of the live campaign, apart from hidden pages and pages shown only to other players.
- **Player names aren't passwords.** A per-player copy, or a page shown only to some players, is only sent to a device that picked one of those names (and to the host), but any device can pick any name.
- **Fillable PDFs' own scripts** (their calculations) run inside PDF.js's sandbox, never in the page itself.
- **The host check:** the dashboard and the referee pages answer only to the computer running MotherGoose, whether it uses `localhost` or its own network address.
- **Other websites can't use that check against you.** A site open in the referee's browser could try to reach `localhost`. MotherGoose refuses any change that doesn't come from its own pages, any address that isn't an IP, `localhost` or this computer's name, and being shown inside another site's frame.
- **Players' entries are shown as text and formatting only** (see *Making pages for MotherGoose*), so a player can't use a shared page to run code on the host.
- **What isn't protected:** there are no passwords or HTTPS. Don't expose the port to the internet.

---

## Building from source

You need [Go](https://go.dev/dl/) 1.25 or newer.

```sh
go run ./cmd/mothergoose          # run while developing (data/ in the current folder)
go test ./...                     # tests
scripts/build.sh                  # all platforms into dist/ (macOS/Linux)
scripts\build.ps1                 # same, from Windows PowerShell
```

How the code is organised:

```
cmd/mothergoose/     entry point: flags, startup banner, browser launch
internal/store/      everything on disk: campaigns (sessions/), pages, entries, the party, who sees what
internal/pages/      what's inside pages: Markdown to HTML, and the self-contained check
internal/server/     HTTP routes, access checks, the API, WebSocket sync and events, templates, LAN addresses/QR
internal/firewall/   whether a Linux firewall lets players in, and letting them in (asks for the password)
web/                 embedded UI, no build step:
  admin/, shell/       the dashboard and the player view, one module per feature
  viewer/              the PDF and image viewers
  ui.js, theme.css     shared UI pieces (overlays, notices, events, shortcuts) and the app's styles
  tokens.css           the Catppuccin palettes, design tokens and fonts (also given to pages that ask)
  page-theme.js        makes such pages follow the reader's theme and font
  md.css               how Markdown pages look
  jump.js              quick jump (Ctrl+K), in both dashboards
  prefs.js             display settings: theme, font, icons/text
  icons.svg            Iconoir icon sprite (rebuild with scripts/icons.py)
  sync.js              the live-sync connection, shared by HTML pages and the PDF viewer
  inject.js            the save-and-sync script added to HTML pages (served together with sync.js)
  templates/           the templates, and templates.json (their names and details)
  guide/SKILL.md       the guide to making pages, which is also an AI skill
  vendor/              PDF.js (library, viewer component, scripting sandbox), bundled
```

How it's put together, and the rules that keep it simple, are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). How the server, the dashboards and the pages talk to each other (endpoints, WebSocket messages, when things update) is in [docs/NETWORK.md](docs/NETWORK.md).

The web UI is plain HTML, CSS and JS with no build step, and it is embedded in the binary. Markdown is rendered with [goldmark](https://github.com/yuin/goldmark) (MIT). It uses JetBrains Mono, Atkinson Hyperlegible Mono, Atkinson Hyperlegible Next and OpenDyslexic, all bundled under the SIL Open Font License (see `web/fonts/`). Icons are [Iconoir](https://iconoir.com) 7.12.1 (MIT, `web/icons-LICENSE.txt`), built into `web/icons.svg` by `scripts/icons.py`. The fonts and icons came from the npm registry and were checked against the registry's published hashes.

PDFs are shown with [PDF.js](https://mozilla.github.io/pdf.js/) 4.10.38, legacy build for older phones, bundled in `web/vendor/` under the Apache 2.0 licence: the library and its worker, its viewer component (`web/pdf_viewer.mjs` and `.css`, with their images) for fillable fields, and its scripting sandbox (`pdf.sandbox.min.mjs`), which runs a fillable PDF's own calculations in an isolated JavaScript engine. The sandbox is loaded only for PDFs that contain scripts. Everything came from the npm registry and was checked against the registry's published hash. Fillable PDFs: AcroForm fields (text, checkboxes, radio buttons, dropdowns and lists) are supported. Older XFA forms aren't: the viewer says so and shows what it can. A calculation runs when a field is confirmed (Tab, Enter or clicking elsewhere in the page). Only its standard fonts are bundled, not its CJK character maps, so a PDF with unembedded Chinese, Japanese or Korean fonts may show boxes for that text.

---

## Licence

MotherGoose is released under the [MIT License](LICENSE). The bundled third-party files keep their own licences: PDF.js (Apache 2.0, `web/vendor/pdfjs-4.10.38/LICENSE`), the fonts (SIL Open Font License, `web/fonts/`) and Iconoir (MIT, `web/icons-LICENSE.txt`).
