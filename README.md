# MotherGoose

A small server for running tabletop RPG sessions over your local network. It runs on the referee's computer (the game master, GM or DM).

A **session** is a folder of pages, such as character sheets, a player handout, the referee's notes, a rulebook PDF or a map. You make these anywhere you like, then drop them in. Each session has a **game type**, the game or rules being played, written in your own words and shown next to its name so you can tell your campaigns apart.

| Page type | Files | What players get |
|---|---|---|
| HTML page | `.html`, `.htm` (up to 32 MB) | The page itself. Anything typed into it is saved and synced live. |
| PDF | `.pdf` (up to 100 MB) | A built-in viewer that works the same on phones, tablets and laptops: page numbers, zoom, fit to width. Fillable PDFs (for example official character sheets) can be filled in, are saved and synced like HTML pages, run their own calculations, and can be downloaded filled in. |
| Image | `.png`, `.jpg`, `.jpeg` (up to 32 MB) | Fitted to the screen. Tap or click for actual size, and scroll around. |

MotherGoose checks that a PDF or image really is one before accepting it.

- **Players** pages can be opened by every player on the same Wi-Fi or LAN. They're marked in **blue** everywhere.
- **Referee** pages open only on the computer running MotherGoose. They're marked in **orange** everywhere.
- Every page can have a **description** and **tags** (for example `map`, `handout`, `level 2`). Players see them for their pages, in the page's details.
- Anything typed into a page is **saved** and **synced live** to everyone viewing it. That covers text boxes, checkboxes, dropdowns and editable areas, and the fields of fillable PDFs.
- A players' page can be **per player**, such as a character sheet: each player on the session's roster gets their own copy, which only they and the referee can see.

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

The dashboard opens in your browser, and a console window shows the addresses:

```
  MOTHERGOOSE

  Referee (this computer)      http://localhost:8080/admin
  Players (same network)       http://192.168.1.20:8080/

  Data folder  /Users/you/Documents/MotherGoose/data
```

Players open the **Players** address on their phone, tablet or laptop. You can also have them scan the QR code on the dashboard. Close the console window, or press Ctrl+C, to stop the server. Everything is saved as you go.

### Options

```
mothergoose --port 9000        # use another port (default 8080; tries the next few if busy)
mothergoose --data D:\dnd      # keep sessions somewhere else (default: "data" next to the program)
mothergoose --no-browser       # don't open the dashboard on start
```

---

## Running a session

1. In the dashboard (`/admin`), create a session. Give it a name and, optionally, a game type.
2. Drag `.html`, `.pdf`, `.png` or `.jpg` files into **Players** or **Referee**, or use **+ add**. Use **to referee** / **to players**, or drag a file between the panels, to change which side it's on.
3. Click **▶ go live**. Only one session is live at a time, and players see its shared pages as tabs.
4. Click **■ end session** when you're done. Players return to a waiting screen, and every entry is kept for next time.

The dashboard has two panes. The sessions list is on the left and the selected session is on the right. Each file row has **open ↗**, a move button and **info**. **info** opens the page's details, where you can edit it and reach the less common actions:

- **Edit the page**: change its file name (the type stays the same), description, tags and, for players' pages, **per player**. **save** applies them together.
- **Party** (per-player pages): add or remove players right there. This changes the session's party and applies straight away.
- **Export filled** (HTML pages and fillable PDFs): download a copy with every entry filled in. An HTML copy works offline; a PDF copy is a normal filled-in PDF you can open anywhere. Archive it or send it to a player.
- **Reset entries** (HTML pages and fillable PDFs): clear everything typed into the page.
- **Delete**: remove the file.

Deleting or resetting always asks first. **Join Info** in the top bar shows the players' address and a QR code, and **data folder** shows where everything is stored.

**edit** on a session changes its name or game type. On the host computer, the player view (`/`) also shows the referee pages, in their own orange group of tabs. On every other device they are hidden and refused.

### The player view

The top of the player view has two slim rows:

- **Info bar:** session name, connection status, theme. Click the session name or the status for details.
- **Tab bar:** one tab per page, numbered, with PDF and image pages marked by an icon. The open tab is tinted blue for players' pages and orange for the referee's.

Press **⤢ full** (or `f`) for full screen. The browser goes full screen where it can, and MotherGoose hides everything except a thin row of tabs at the top. Press **⤡ shrink** at the top right, or `Esc`, to come back. On iPhones, which don't support browser full screen, you still get the full-screen layout.

Keyboard shortcuts (press `?` to see them): `f` full screen, `1`–`9` jump to a tab, `[` `]` previous/next tab, `i` details. In the dashboard: `n` new session, `↑` `↓` move through sessions, `e` edit the session, `p` add a player to the party, `u` add players' files, `j` Join Info.

### Players and per-player sheets

Each session has a **PARTY**: the players' names, added in the PARTY panel of the referee's dashboard. A roster belongs to one session, so each campaign has its own.

- **Who are you?** On a player's device, per-player tabs ask the player to pick their name from the roster. The device remembers it. **not you?** in the player dashboard header switches to another name.
- **Per-player pages:** in a players' page's **info**, tick **per player** and **save**. That one file becomes a template: every player gets their own copy, with their own entries, saved and synced separately. HTML pages and fillable PDFs both work.
- **Starting values:** anything the referee fills into the template is copied into a player's sheet the first time they open it. A player added later starts from the same template.
- **The referee's view:** on the host computer, a per-player tab has a strip at the top to switch between the template and each player's copy. In the dashboard, a per-player page's row names each player, shaded once they've filled in their copy, and its **info** lists every copy with open, export filled and reset.
- **Turning per player off** goes back to the single shared copy. Everyone's copies stay on disk and come back if you turn it on again.
- **Removing a player** asks whether to keep their entries. They're kept by default and come back if a player with the same name is added again.

Choosing a name is an honour system, not a login: anyone can pick any name. It keeps sheets out of each other's way rather than secret.

### Display settings

The UI is a terminal-style layout in the [Catppuccin](https://catppuccin.com) palette. **display** (the gear icon) in the top bar sets three things, and each device remembers its own choice:

- **Colour theme:** **Auto** (Latte when the device is in light mode, Mocha in dark mode), **Latte**, **Frappé**, **Macchiato** or **Mocha**.
- **Font:** JetBrains Mono (the default), **Atkinson Hyperlegible Mono** or **Atkinson Hyperlegible**, both designed for readers with low vision, **OpenDyslexic** for dyslexic readers, or the device's own font.
- **Buttons show:** icons and text, icons only (names appear on hover and are read out by screen readers), or text only.

These change MotherGoose itself. Pages you add keep their own fonts and colours.

---

## The data folder

Everything lives in plain folders you can browse, back up or edit by hand:

```
data/
  config.json                 which session is live
  sessions/
    the-sunken-keep/
      session.json            name, game type, roster (players), page descriptions, tags and per-player switches
      shared/                 players' pages
        intro.html
        aria-sheet.html
      gm/                     referee's pages (only the host computer can open them)
        gm-notes.html
      state/                  what people have typed (managed by MotherGoose)
        shared/aria-sheet.html.json
        gm/gm-notes.html.json
        players/ana/aria-sheet.html.json   Ana's copy of a per-player page
```

- **Adding pages by hand:** copy `.html`, `.pdf`, `.png` or `.jpg` files into `shared/` (players) or `gm/` (referee). The folder names are kept from earlier versions, so older data folders keep working. They appear in the dashboard and in players' tabs within a couple of seconds.
- **Adding a session by hand:** create a folder in `sessions/` with `shared/` and/or `gm/` inside it.
- **Replacing a page:** upload or copy a file with the same name. The entries already typed into it, and its description and tags, are kept.
- **Editing by hand:** `session.json` is plain JSON, with `gameType` and a `pages` object (for example `"shared/intro.html": {"description": "...", "tags": ["handout"]}`). Changes show up within a couple of seconds.
- **Backing up:** copy the `data` folder.
- **Broken files:** if a `.json` file can't be read, for example after a hand edit with a typo, MotherGoose renames it to `<name>.corrupt-<date>` and starts that file fresh. It never overwrites it, so you can fix it and copy it back.

---

## Making pages for MotherGoose

PDFs and images work as they are. For HTML, any self-contained `.html` file works: inline your CSS, JS and images (as data URIs). MotherGoose never changes your file. When it serves a page, it adds a small script that saves and syncs these form fields:

- `<input>` of any type except password, file, hidden and buttons
- `<textarea>`
- `<select>`, including `multiple`
- any element with `contenteditable`

Tips for pages that save reliably:

- **Give fields an `id` or a `name`.** That is how a field's saved value is matched to it. Fields without one are matched by their position in the page, which still works as long as the page layout doesn't change.
- Radio buttons that share a `name` are saved as one choice.
- Your page's own scripts keep working. After values are restored, MotherGoose fires `input` and `change` events, so calculated fields such as ability modifiers update.
- Add `data-mg-ignore` to an element, or to a container, to keep it out of saving and syncing.
- Editable areas (`contenteditable`) keep formatting: bold, italics, lists, headings, tables, links and pasted images. Anything else that arrives from another device is removed before it's shown, such as scripts, event handlers, embedded frames, forms, SVG and remote images, so no one can run code on someone else's screen.

### Saving custom state

For things that aren't form fields, such as a clickable HP tracker or a map with tokens, use the small API that MotherGoose adds to every page:

```js
MotherGoose.set('hp', 17);              // save any JSON value (null deletes it)
MotherGoose.get('hp');                  // read it back
MotherGoose.on('hp', v => render(v));   // called now (if saved) and whenever another device changes it
MotherGoose.status();                   // 'connecting' | 'live' | 'offline' | 'closed' | 'offline-copy'
```

Check `if (window.MotherGoose)` first if the page should also work when opened without the server.

Values from `MotherGoose.get` and `MotherGoose.on` can come from any device on the network. Show them with `textContent`, `value` or `setAttribute`, never with `innerHTML`, so a player can't run code in a page the referee opens.

When two people edit the same field at the same moment, the last change wins. If someone is typing in a field when another device changes it, their cursor isn't disturbed: the update waits until they leave the field.

---

## Security notes

MotherGoose is meant for a trusted home or club network.

- **Players need no login.** Anyone on the network can open the shared pages of the live session.
- **Player names aren't passwords.** A per-player copy is only sent to the device that picked that name (and to the host), but any device can pick any name.
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
internal/store/      sessions, files and saved state on disk
internal/server/     HTTP routes, host-only checks, WebSocket sync, LAN addresses/QR
web/                 embedded UI, no build step:
  admin/, shell/       the dashboard and the player view
  viewer/              the PDF and image viewers
  ui.js, theme.css     shared UI pieces (overlays, events) and the Catppuccin theme
  prefs.js             display settings: theme, font, icons/text
  icons.svg            Iconoir icon sprite (rebuild with scripts/icons.py)
  inject.js            the save-and-sync script added to HTML pages
  vendor/              PDF.js (library, viewer component, scripting sandbox), bundled
examples/            sample pages to try things out
```

The web UI is plain HTML, CSS and JS with no build step, and it is embedded in the binary. It uses JetBrains Mono, Atkinson Hyperlegible Mono, Atkinson Hyperlegible Next and OpenDyslexic, all bundled under the SIL Open Font License (see `web/fonts/`). Icons are [Iconoir](https://iconoir.com) 7.12.1 (MIT, `web/icons-LICENSE.txt`), built into `web/icons.svg` by `scripts/icons.py`. The fonts and icons came from the npm registry and were checked against the registry's published hashes.

PDFs are shown with [PDF.js](https://mozilla.github.io/pdf.js/) 4.10.38, legacy build for older phones, bundled in `web/vendor/` under the Apache 2.0 licence: the library and its worker, its viewer component (`web/pdf_viewer.mjs` and `.css`, with their images) for fillable fields, and its scripting sandbox (`pdf.sandbox.min.mjs`), which runs a fillable PDF's own calculations in an isolated JavaScript engine. The sandbox is loaded only for PDFs that contain scripts. Everything came from the npm registry and was checked against the registry's published hash. Fillable PDFs: AcroForm fields (text, checkboxes, radio buttons, dropdowns and lists) are supported. Older XFA forms aren't: the viewer says so and shows what it can. A calculation runs when a field is confirmed (Tab, Enter or clicking elsewhere in the page). Only its standard fonts are bundled, not its CJK character maps, so a PDF with unembedded Chinese, Japanese or Korean fonts may show boxes for that text.
