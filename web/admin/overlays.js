// The referee dashboard's overlays: Join Info, the data folder, a campaign's
// details and editing, a page's info popup (where a page is edited, its party
// and copies), and renaming or removing players.
import {
  agoText, allTags, api, attempt, audienceText, canPerPlayer, confirmDialog, enc, esc, filledUrl, isPage, perPlayerTag, tagField,
  formOverlay, gameTag, hasEntries, ic, isHidden, isOnly, KIND_NAME, kindTag, kv, overlay,
  parseTags, playerName, SCOPE, scopeTag, size, titleOf, toast, viewUrl,
  visTags, when, withIcon
} from '/_mg/ui.js';
import { A, app, fileBase, filledCount, livePort, MAX_PLAYERS, other, playersBase } from './state.js';
import { tourRunning } from '/_mg/tour.js';
import { clearAllCopies, clearEntries, deletePage, move, pointHere } from './table.js';

// Join Info: the address players open, as a link and a QR code. The
// computer's name (<name>.local) stays the same between game nights, unlike
// its IP address, so it goes first when it answers here; any address can be
// picked to show its QR code instead.
export async function joinOverlay() {
  // The addresses are read again each time: the network may have changed.
  if (!tourRunning()) { try { A.info = await api('GET', '/api/info'); } catch (e) { /* keep the last ones */ } }
  const info = A.info || {};
  const urls = info.urls || [];
  if (!urls.length) {
    overlay({ title: 'Join Info', icon: 'join', body: '<p>No network connection found. Connect this computer to Wi-Fi or a LAN, then open Join Info again.</p>' });
    return;
  }
  const body = document.createElement('div');
  body.className = 'join';
  let addrs = urls.map((u) => ({ url: u, note: '' }));
  let shown = urls[0];
  const draw = () => {
    const main = addrs.find((a) => a.url === shown) || addrs[0];
    body.innerHTML =
      '<div class="mg-section-label">Players open</div>' +
      '<a class="join-url" href="' + esc(main.url) + '" target="_blank" rel="noopener">' + esc(main.url) + '</a>' +
      (main.note ? '<p class="mg-muted join-note">' + esc(main.note) + '</p>' : '') +
      '<div class="qr"><img src="/api/qr.png?u=' + enc(main.url) + '" alt="QR code for ' + esc(main.url) + '"></div>' +
      '<p class="mg-muted">Players need to be on the same Wi-Fi or network as this computer. They can scan the code with a phone camera.</p>' +
      (addrs.length > 1
        ? '<hr class="mg-rule"><div class="mg-section-label">Other addresses</div><ul class="join-list">' +
          addrs.filter((a) => a !== main).map((a) =>
            '<li><a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.url) + '</a>' +
            (a.note ? ' <span class="mg-muted">' + esc(a.note) + '</span>' : '') +
            ' <button type="button" class="mg-btn quiet small compact" data-qr="' + esc(a.url) + '" title="Show the QR code for this address">' + withIcon('join', 'QR') + '</button></li>').join('') +
          '</ul><p class="mg-muted">Each device remembers its name and tab order for the address it used, so it\'s easiest if everyone keeps to one.</p>'
        : '');
  };
  draw();
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-qr]');
    if (b) { shown = b.dataset.qr; draw(); }
  });
  overlay({
    title: 'Join Info', icon: 'join', body, size: 'wide',
    actions: [{ label: 'show to the table', value: 'present', icon: 'present', kind: 'primary', title: 'A big QR code and address, to turn the screen towards the players' }]
  }).then((v) => { if (v === 'present') presentJoin(shown); });
  if (!info.localUrl || tourRunning()) return;
  // Does this computer's name answer on this network? Ask it, from here.
  reachable(info.localUrl).then((ok) => {
    const local = { url: info.localUrl, note: ok ? 'by this computer\'s name: stays the same between game nights' : 'may work on some devices' };
    if (ok) { addrs = [local].concat(addrs); if (shown === urls[0]) shown = local.url; }
    else addrs = addrs.concat([local]);
    if (body.isConnected) draw();
  });
}

// presentJoin fills the screen with one address and its QR code, big enough
// to read across the table. Esc or a tap closes it.
function presentJoin(url) {
  overlay({
    title: 'Join: ' + url, icon: 'join', size: 'xwide',
    body: '<div class="present"><div class="qr big"><img src="/api/qr.png?u=' + enc(url) + '" alt="QR code for ' + esc(url) + '"></div>' +
      '<p class="present-url">' + esc(url) + '</p><p class="mg-muted">Open this on your device, on the same Wi-Fi as this computer, or scan the code.</p></div>',
    onOpen: (d) => { d.classList.add('presenting'); d.addEventListener('click', (e) => { if (e.target.closest('.present')) d.close(); }); }
  });
}

// reachable tries to fetch a small file from an address, for at most 2 s.
async function reachable(base) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2000);
  try {
    await fetch(base + '_mg/icons.svg', { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function dataOverlay() {
  const v = await overlay({
    title: 'Data folder',
    icon: 'data',
    wide: true,
    actions: [{ label: 'open folder', value: 'reveal', icon: 'folder' }],
    body: kv([['location', '<code>' + esc(A.info ? A.info.dataDir : '') + '</code>']]) +
      '<pre class="tree">data/\n  config.json              which campaign is live\n  sessions/                one folder per campaign\n    the-sunken-keep/\n      session.json         name, game type, party, page details and who sees them\n' +
      '      shared/              players\' pages\n      gm/                  referee\'s pages (this computer only)\n      state/               what people typed (managed for you)\n        players/           each player\'s copy of per-player pages</pre>' +
      '<p class="mg-muted">Copy .html, .md, .pdf, .png or .jpg files into <code>shared/</code> (players) or <code>gm/</code> (referee) and they appear within a couple of seconds. Back up by copying the whole folder.</p>'
  });
  if (v === 'reveal') await api('POST', '/api/admin/data/reveal');
}

export async function editSession() {
  const s = A.current;
  const v = await formOverlay({
    title: 'Edit campaign', icon: 'edit',
    fields: [
      { name: 'name', label: 'Name', value: s.name, max: 120, required: true },
      { name: 'gameType', label: 'Game type', hint: 'the game or rules you\'re playing', value: s.gameType, max: 60,
        list: Array.from(new Set(A.sessions.map((x) => x.gameType).filter(Boolean))) }
    ]
  });
  if (!v) return;
  await api('PATCH', '/api/admin/sessions/' + enc(s.id), { name: v.name, gameType: v.gameType });
  toast('Saved');
  app.refresh();
}

export async function sessionOverlay() {
  const s = A.current;
  const v = await overlay({
    title: 'Campaign: ' + s.name,
    icon: 'info',
    wide: true,
    body: kv([
      ['name', esc(s.name)], ['game type', s.gameType ? gameTag(s.gameType) : '<span class="mg-muted">not set</span>'],
      ['id', '<code>' + esc(s.id) + '</code>'],
      ['status', s.active ? livePort() + ' <span class="mg-muted">a session is on</span>' : 'not live'],
      ['pages', (s.files.shared || []).length + ' for players, ' + (s.files.gm || []).length + ' for the referee'],
      ['party', (s.players || []).length ? (s.players || []).map((p) => esc(p.name)).join(', ') : '<span class="mg-muted">no players yet</span>'],
      ['created', esc(when(s.created))], ['last edit', esc(when(s.lastEdited))],
      ['folder', '<code>' + esc(s.dir) + '</code>']
    ]),
    actions: [{ label: 'edit', value: 'edit', icon: 'edit', kind: 'quiet' }, { label: 'open folder', value: 'reveal', icon: 'folder' }]
  });
  if (v === 'reveal') await api('POST', '/api/admin/sessions/' + enc(s.id) + '/reveal');
  if (v === 'edit') await editSession();
}

// Per-player pages: the template and each player's copy, with who has
// entries and what can be done with each copy.
function copiesList(s, f) {
  const changed = (who) => who && f.playerModified && f.playerModified[who] ? ' · ' + agoText(f.playerModified[who]) : '';
  const row = (who, name, note, filled) =>
    '<li class="copy' + (who ? '' : ' template') + '">' +
      '<span class="who">' + ic(who ? 'player' : 'template', 'deco') + '<b>' + esc(name) + '</b><span class="mg-muted">' + note + '</span></span>' +
      '<span class="state">' + (filled ? '<span class="mg-tag filled">filled in</span><span class="mg-muted">' + esc(changed(who)) + '</span>' : '<span class="mg-muted">no entries</span>') + '</span>' +
      '<span class="acts">' +
        '<a class="mg-btn quiet small compact" href="' + viewUrl(s.id, f, '', who, true) + '" target="_blank" rel="noopener" title="Open ' + esc(who ? name + '\'s copy' : 'the template') + '">' + withIcon('open', 'open') + '</a>' +
        '<a class="mg-btn quiet small compact" href="' + filledUrl(s.id, f, who) + '"' + (f.kind === 'pdf' ? ' target="_blank" rel="noopener"' : ' download') +
          ' title="Export ' + esc(who ? name + '\'s copy' : 'the template') + ' filled in' + (f.kind === 'pdf' ? ' (opens the viewer, which downloads it)' : '') + '">' + withIcon('export', 'export filled') + '</a>' +
        '<button type="button" class="mg-btn danger small compact" data-copy-reset="' + esc(who) + '"' + (filled ? '' : ' disabled') + ' title="Clear ' + esc(who ? name + '\'s entries' : 'the template\'s entries') + '">' + withIcon('reset', 'clear entries') + '</button>' +
      '</span></li>';
  const players = s.players || [];
  return '<div><div class="mg-section-label">' + ic('player') + ' Copies</div>' +
    '<ul class="copies">' + row('', 'template', 'starting values', f.hasState) +
      players.map((p) => row(p.id, p.name, '', !!(f.playerState && f.playerState[p.id]))).join('') + '</ul></div>' +
    (players.length ? '' : '<p class="mg-muted">No players in the party yet: add them under PARTY in the campaign panel.</p>');
}

// The info popup is where a page is edited. It has sections: Details (title,
// file name, description, tags), Who sees it (per player, audience, hidden),
// Copies (the party and each copy, for per-player pages), and More (facts).
// Details are saved together with "save" (one request, renaming too); party
// changes and clearing a copy apply straight away. Closing with unsaved
// edits asks first.
export async function fileOverlay(scope, name) {
  const s = A.current;
  const f = (s.files[scope] || []).find((x) => x.name === name);
  if (!f) return;
  const base = fileBase(s, scope, name);
  const per = !!f.perPlayer;
  const perOk = canPerPlayer(Object.assign({}, f, { scope }));
  const dot = f.name.lastIndexOf('.');
  const stem = f.name.slice(0, dot), ext = f.name.slice(dot);
  const ownTitle = f.title !== f.docTitle ? f.title : '';
  const allTagsHere = allTags([].concat(...A.sessions.map((x) => [].concat(x.files.shared || [], x.files.gm || []))));

  const body = document.createElement('div');
  body.className = 'finfo';
  body.innerHTML =
    (isPage(f) ? '<div class="fcheck" id="fcheck"><span class="mg-muted check-wait">' + ic('search') + ' checking the page…</span></div>' : '') +
    '<form class="fform" id="fform" autocomplete="off">' +
      '<section class="fsec"><h3 class="fsec-t">Details</h3>' +
        '<label class="mg-field"><span>Title <span class="hint">on tabs and lists; leave empty to use the page\'s own</span></span>' +
          '<input class="mg-input" name="title" value="' + esc(ownTitle) + '" maxlength="80" placeholder="' + esc(f.docTitle || stem) + '"></label>' +
        '<label class="mg-field"><span>File name <span class="hint">the type (' + esc(ext) + ') stays the same</span></span>' +
          '<span class="fname-row"><input class="mg-input" name="stem" value="' + esc(stem) + '" maxlength="190" required aria-label="File name"><span class="ext">' + esc(ext) + '</span></span></label>' +
        '<label class="mg-field"><span>Description <span class="hint">' + (scope === 'gm' ? 'only you see this' : 'players see this') + '</span></span>' +
          '<textarea class="mg-input" name="description" maxlength="1000" placeholder="What is this page? When should players open it?">' + esc(f.description || '') + '</textarea></label>' +
        '<div class="mg-field"><span>Tags <span class="hint">Enter or comma after each</span></span><div id="ftags"></div></div>' +
      '</section>' +
      (scope === 'shared'
        ? '<section class="fsec"><h3 class="fsec-t">Who sees it</h3>' +
            (perOk
              ? '<label class="pp-toggle"><input type="checkbox" name="perPlayer"' + (per ? ' checked' : '') + '>' +
                  '<span><b>' + ic('player', 'deco') + ' Per player</b><span class="hint">Every player in the party fills in their own copy, seen only by them and you. ' +
                  'What\'s in the page now becomes each player\'s starting copy. Turning it off keeps their copies for later.</span></span></label>'
              : '') +
            '<div id="fvis"></div>' +
          '</section>'
        : '<p class="mg-muted">' + ic('referee') + ' A referee page: only this computer opens it.</p>') +
      '<button type="submit" hidden></button>' +
    '</form>' +
    '<section class="fsec fcopies-sec" id="fcopysec"' + (per ? '' : ' hidden') + '><h3 class="fsec-t">Copies</h3>' +
      '<div class="fparty" id="fparty"></div><div class="fcopies" id="fcopies"></div></section>' +
    '<details class="fmore"><summary>More about this page</summary>' +
      kv([
        ['for', scopeTag(scope) + ' <span class="mg-muted">' + (scope === 'gm' ? 'this computer only'
          : (isHidden(f) ? 'hidden; once revealed, ' : '') + audienceText(f, s.players) + (per ? ', each their own copy' : '') + ', when the session is live') + '</span>' +
          (scope === 'shared' ? ' ' + visTags(f, s.players) : '')],
        ['type', kindTag(f.kind) + ' ' + KIND_NAME[f.kind]],
        ['size', size(f.size)], ['changed', esc(when(f.modified)) + ' <span class="mg-muted">(' + esc(agoText(f.modified)) + ')</span>'],
        ['entries', !hasEntries(f) ? '<span class="mg-muted">not applicable</span>'
          : per ? filledCount(s, f) + ' of ' + (s.players || []).length + ' players' + (f.hasState ? ', and the starting copy' : '')
          : f.hasState ? '<span class="mg-tag filled">filled in</span>' : 'none yet']
      ]) +
      (hasEntries(f) ? '<p class="mg-muted">Export filled downloads a copy with ' + (per ? 'that copy\'s entries' : 'every entry') + ' baked in' +
        (f.kind === 'pdf' ? ': it opens the PDF viewer, which fills in the fields and downloads the PDF.' : '. It works offline.') + '</p>' : '') +
    '</details>';

  const form = body.querySelector('#fform');
  const partyEl = body.querySelector('#fparty');
  const copiesEl = body.querySelector('#fcopies');
  const tags = tagField(body.querySelector('#ftags'), { tags: f.tags || [], suggest: allTagsHere });

  // What checking the page finds, in one line laid out from the start (so
  // nothing jumps while typing), with the details a click away.
  // (The tutorial's example pages aren't on disk.)
  if (isPage(f) && !tourRunning()) {
    api('GET', base + '/check').then((c) => {
      const el = body.querySelector('#fcheck');
      if (!el) return;
      const rep = c.report || {};
      const notes = checkNotes(rep);
      el.innerHTML = notes
        ? '<details class="check-more"><summary class="check-warn">' + ic('warning') + ' Worth a look: ' +
            [rep.local && rep.local.length ? 'loads files that aren\'t inside it' : '', rep.web && rep.web.length ? 'needs the internet' : '', rep.unnamed ? rep.unnamed + ' unnamed field' + (rep.unnamed === 1 ? '' : 's') : '']
              .filter(Boolean).join(', ') + '</summary>' + notes +
            '<button type="button" class="mg-btn quiet small" data-guide>' + withIcon('guide', 'making HTML pages') + '</button></details>'
        : '<span class="mg-muted check-ok">' + ic('check') + ' One self-contained file' + (rep.fields ? ', ' + esc(rep.fields) + ' field' + (rep.fields === 1 ? '' : 's') + ' saved and synced' : '') + '.</span>';
    }).catch(() => { const el = body.querySelector('#fcheck'); if (el) el.textContent = ''; });
  }

  // Who sees it, drawn again when the party changes, keeping what's chosen.
  function drawVis() {
    const host = body.querySelector('#fvis');
    if (!host) return;
    const was = host.querySelector('fieldset') ? readVis() : { audience: f.audience || '', allowed: f.allowed || [], hidden: isHidden(f) };
    host.innerHTML = visibilityFields(A.current, Object.assign({}, f, { scope, audience: was.audience, allowed: was.allowed, hidden: was.hidden }));
    syncVis();
  }
  function readVis() {
    return {
      audience: form.querySelector('[name=audience][value=only]:checked') ? 'only' : '',
      allowed: Array.from(form.querySelectorAll('[name=allowed]:checked')).map((i) => i.value),
      hidden: !!(form.querySelector('[name=hidden]') || {}).checked
    };
  }
  // The players to show it to only matter with "only these players".
  function syncVis() {
    const only = !!form.querySelector('[name=audience][value=only]:checked');
    form.querySelectorAll('[name=allowed]').forEach((i) => { i.disabled = !only; });
  }

  // The party and each copy, redrawn after every party change.
  function drawParty() {
    const sess = A.current;
    const players = sess.players || [];
    const full = players.length >= MAX_PLAYERS;
    partyEl.innerHTML =
      '<p class="mg-muted fnote">' + ic('players') + ' The party of this whole campaign. Adding or removing a player applies straight away.</p>' +
      '<div class="party-row">' +
        (players.length
          ? '<ul class="roster" aria-label="Players">' + players.map((p) =>
              '<li class="pchip compact"><span class="pname">' + ic('player', 'deco') + '<span>' + esc(p.name) + '</span></span>' +
              '<button type="button" class="pdel" data-fremove="' + esc(p.id) + '" title="Remove ' + esc(p.name) + ' from the party">' + withIcon('close', 'remove') + '</button></li>').join('') + '</ul>'
          : '<span class="mg-muted">No players yet.</span>') +
        '<span class="add-player"><input class="mg-input" id="fnewp" placeholder="' + (full ? MAX_PLAYERS + ' players at most' : 'player name') + '" maxlength="40" aria-label="New player\'s name"' + (full ? ' disabled' : '') + '>' +
          '<button class="mg-btn players small" type="button" data-fadd' + (full ? ' disabled' : '') + ' title="Add this player to the party">' + withIcon('add-player', 'add') + '</button></span>' +
      '</div>';
    const live = (sess.files[scope] || []).find((x) => x.name === name) || f;
    // Copies only exist once per player is saved.
    copiesEl.innerHTML = live.perPlayer ? copiesList(sess, live) : '<p class="mg-muted">Save with "per player" ticked, and each player\'s copy shows here.</p>';
    drawVis();
  }
  drawParty();

  async function reloadSession() {
    A.current = await api('GET', '/api/admin/sessions/' + enc(s.id));
    drawParty();
  }

  // What the form holds, to tell whether anything changed.
  const formState = () => JSON.stringify([new FormData(form).get('title'), new FormData(form).get('stem'), new FormData(form).get('description'),
    tags.get(), !!(form.querySelector('[name=perPlayer]') || {}).checked, scope === 'shared' ? readVis() : null]);
  let startState = '';
  let saved = false;

  async function save(d) {
    const v = Object.fromEntries(new FormData(form).entries());
    const newStem = (v.stem || '').trim();
    if (!newStem) { toast('The file name can\'t be empty', true); return; }
    const changed = [];
    const metaBody = { title: (v.title || '').trim(), description: v.description || '', tags: tags.get() };
    if (newStem !== stem) metaBody.name = newStem + ext;
    const wantPer = perOk && !!v.perPlayer;
    if (perOk) metaBody.perPlayer = wantPer;
    if (perOk && per && !wantPer && filledCount(s, f) &&
        !(await confirmDialog('Turn off per player', 'Players will see one shared copy instead of their own. Their copies are kept, and come back if you turn it on again.', 'turn it off', { icon: 'player' }))) return;
    if (scope === 'shared') {
      const vis = readVis();
      metaBody.hidden = vis.hidden;
      metaBody.audience = vis.audience;
      if (vis.audience === 'only') metaBody.allowed = vis.allowed;
      if (vis.hidden !== isHidden(f)) changed.push(vis.hidden ? 'hidden from players' : 'revealed');
    }
    const r = await api('PUT', base + '/meta', metaBody);
    const target = (r && r.name) || name;
    if (target !== name) changed.unshift('renamed to ' + target);
    if (perOk && wantPer !== per) changed.push(wantPer ? 'now per player' : 'shared again: everyone sees one copy');
    toast((changed.length ? target + ' ' + changed.join(', ') : 'Saved details for ' + target));
    saved = true;
    d.close();
  }

  const actions = [];
  // The footer (R3): looking at the page on the left, rarer and dangerous
  // actions under "more…", cancel and save on the right.
  if (scope === 'shared' && s.active && !isHidden(f)) actions.push({ label: 'point here', value: 'show', kind: 'quiet', icon: 'point', side: 'left', title: 'Ask every player who can see it to look at it now' });
  if (!per) actions.push({ label: 'open', href: viewUrl(s.id, f, '', '', true), kind: 'quiet', icon: 'open', side: 'left', keepOpen: true });
  if (!per && hasEntries(f)) actions.push({ label: 'export filled', href: filledUrl(s.id, f), download: f.kind !== 'pdf', icon: 'export', kind: 'quiet', side: 'left', keepOpen: true });
  const to = other(scope);
  actions.push({ label: 'move to ' + SCOPE[to].label, value: 'move', icon: to === 'gm' ? 'to-referee' : 'to-players', more: true });
  if (!per && f.hasState) actions.push({ label: 'clear entries', value: 'reset', kind: 'danger', icon: 'reset', more: true });
  if (per && filledCount(s, f)) actions.push({ label: 'clear every copy', value: 'clear-all', kind: 'danger', icon: 'reset', more: true });
  actions.push({ label: 'delete', value: 'delete', kind: 'danger', icon: 'delete', more: true });
  actions.push({ label: 'cancel', value: null, kind: 'quiet', icon: 'close' });
  actions.push({ label: 'save', value: 'save', kind: 'primary', icon: 'check' });

  const v = await overlay({
    title: titleOf(f),
    icon: 'info',
    wide: true,
    body,
    actions,
    // Closing without saving loses edits: ask, unless nothing changed or
    // what follows (delete, clear) makes them moot.
    canClose: async (value) => {
      if (saved || ['delete', 'reset', 'clear-all'].includes(value) || formState() === startState) return true;
      return confirmDialog('Discard changes', 'You changed this page\'s details. Close without saving them?', 'discard changes', { icon: 'close' });
    },
    onOpen: (d) => {
      startState = formState();
      const first = form.querySelector('textarea');
      if (first) first.focus();
      // Save keeps the popup open if something fails, so nothing typed is lost.
      const saveBtn = d.querySelector('.mg-dialog-foot .primary');
      saveBtn.addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        attempt(save)(d);
      }, { capture: true });
      form.addEventListener('submit', (e) => { e.preventDefault(); attempt(save)(d); });
      // Ticking per player shows the copies, so players can be added before saving.
      const pp = form.querySelector('[name=perPlayer]');
      if (pp) pp.addEventListener('change', () => { body.querySelector('#fcopysec').hidden = !pp.checked; });
      form.addEventListener('change', (e) => { if (e.target.name === 'audience') syncVis(); });
      d.addEventListener('click', attempt(async (e) => {
        if (e.target.closest('[data-guide]')) { guideOverlay(); return; }
        const r = e.target.closest('[data-copy-reset]');
        // Clearing a copy happens here, and the popup stays open.
        if (r && !r.disabled) { if (await clearEntries(scope, name, r.dataset.copyReset)) await reloadSession(); return; }
        const rm = e.target.closest('[data-fremove]');
        if (rm) { if (await removePlayer(rm.dataset.fremove)) await reloadSession(); return; }
        if (e.target.closest('[data-fadd]')) await addFromPopup();
      }));
      d.addEventListener('keydown', attempt(async (e) => {
        if (e.key === 'Enter' && e.target.id === 'fnewp') { e.preventDefault(); await addFromPopup(); }
      }));
      async function addFromPopup() {
        const i = d.querySelector('#fnewp');
        const n = (i.value || '').trim();
        if (!n) return;
        const p = await api('POST', playersBase(s), { name: n });
        toast('Added ' + p.name + ' to the party');
        await reloadSession();
        const again = d.querySelector('#fnewp');
        if (again) again.focus();
      }
    }
  });
  if (v === 'reset') { await clearEntries(scope, name); return; }
  if (v === 'clear-all') { await clearAllCopies(scope, name); return; }
  if (v === 'show') await pointHere(scope, name);
  else if (v === 'move') { await move(scope, name, to); return; }
  else if (v === 'delete') { await deletePage(scope, name); return; }
  app.refresh();
}

// ---- pages: what checking one found, templates, the guide to making them ----------------

/** checkNotes lists what checking a page found worth a look, as HTML <ul>. */
export function checkNotes(rep) {
  const notes = [];
  if (rep.local && rep.local.length) notes.push('<span class="bad">' + ic('warning') + ' loads files that aren\'t inside it, so they never load: ' + rep.local.map(esc).join(', ') + '</span>');
  if (rep.web && rep.web.length) notes.push(ic('server') + ' loads from the internet (' + rep.web.map(esc).join(', ') + '): it only works while the device viewing it has internet');
  if (rep.unnamed) notes.push(ic('warning') + ' ' + esc(rep.unnamed) + ' of ' + esc(rep.fields) + ' fields have no <code>id</code> or <code>name</code>: their saved values are lost if the page\'s layout changes');
  return notes.length ? '<ul class="check-notes">' + notes.map((n) => '<li>' + n + '</li>').join('') + '</ul>' : '';
}

// The guide to making pages: shown in a frame, and offered as a file (it is
// also an AI skill) or as text to paste into an AI assistant.
export async function guideOverlay() {
  const body = '<iframe class="guide-frame" src="/_mg/guide/" title="Making HTML pages"></iframe>' +
    '<p class="mg-muted">This guide is also an <b>AI skill</b>: download it for an assistant that takes skills (for Claude Code, put it in <code>~/.claude/skills/mothergoose-pages/SKILL.md</code>), or copy it into any AI chat, then ask for the page you want.</p>';
  const v = await overlay({
    title: 'Making HTML pages', icon: 'guide', wide: true, body,
    actions: [
      { label: 'open in a tab', href: '/_mg/guide/', kind: 'quiet', icon: 'open' },
      { label: 'copy for an AI assistant', value: 'copy', kind: 'quiet', icon: 'copy' },
      { label: 'download as AI skill', href: '/_mg/guide/SKILL.md', download: true, icon: 'skill', kind: 'primary' }
    ]
  });
  if (v === 'copy') {
    const text = await (await fetch('/_mg/guide/SKILL.md', { cache: 'no-cache' })).text();
    toast(await copyText(text) ? 'Copied the guide: paste it into an AI chat, then ask for your page' : 'Couldn\'t copy here: use "download as AI skill" instead', false);
  }
}

// copyText puts text on the clipboard, also where the clipboard API isn't
// offered (a plain-http address that isn't localhost).
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove();
  return ok;
}

// The template gallery: ready-made pages, each with a live preview, added
// to a column of the open campaign.
export async function templateOverlay(scope) {
  const list = await api('GET', '/api/admin/templates');
  const body = document.createElement('div');
  body.className = 'tgallery';
  body.innerHTML = '<p class="mg-muted">Ready-made pages that work with any game, in MotherGoose\'s look (they follow each reader\'s theme and font). Add one, then rename it and change its details under <b>info</b>.</p>' +
    '<div class="tg-wrap"><div class="tg-list" role="listbox" aria-label="Ready-made pages">' + list.map((t, i) =>
      '<button type="button" class="tg-item" role="option" data-i="' + i + '" aria-selected="' + (i === 0) + '">' +
        '<b>' + esc(t.title) + '</b><span class="mg-muted">' + esc(t.description) + '</span>' +
        '<span class="tg-tags">' + (t.perPlayer ? perPlayerTag() : '') + (t.hidden ? '<span class="mg-tag hidden">' + withIcon('hidden', 'starts hidden') + '</span>' : '') + '</span>' +
      '</button>').join('') + '</div>' +
    '<iframe class="tg-preview" title="Preview" src="/api/admin/templates/' + enc(list[0].file) + '"></iframe></div>';
  let at = 0;
  const v = await overlay({
    title: 'Add a page from a template', icon: 'template', size: 'xwide', body,
    actions: [{ label: 'cancel', value: null, kind: 'quiet', icon: 'close' }, { label: 'add for the ' + SCOPE[scope].label, value: 'add', kind: 'primary', icon: 'add' }],
    onOpen: (d) => {
      const pick = (i) => {
        at = i;
        body.querySelectorAll('.tg-item').forEach((x, j) => { x.setAttribute('aria-selected', String(j === i)); x.tabIndex = j === i ? 0 : -1; });
        body.querySelector('.tg-preview').src = '/api/admin/templates/' + enc(list[at].file);
      };
      body.addEventListener('click', (e) => {
        const b = e.target.closest('.tg-item');
        if (b) pick(+b.dataset.i);
      });
      // Double-click or Enter adds; ↑ ↓ move through the list.
      body.addEventListener('dblclick', (e) => { const b = e.target.closest('.tg-item'); if (b) { pick(+b.dataset.i); d.querySelector('.mg-dialog-foot .primary').click(); } });
      body.addEventListener('keydown', (e) => {
        if (!e.target.closest('.tg-item')) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          pick((at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
          body.querySelectorAll('.tg-item')[at].focus();
        } else if (e.key === 'Enter') { e.preventDefault(); d.querySelector('.mg-dialog-foot .primary').click(); }
      });
      pick(0);
      body.querySelector('.tg-item').focus();
    }
  });
  if (v !== 'add') return;
  const t = list[at];
  const r = await api('POST', '/api/admin/sessions/' + enc(A.current.id) + '/templates', { template: t.file, scope });
  toast('Added ' + t.title + ' (' + r.name + ') for the ' + SCOPE[scope].label + (r.meta && r.meta.hidden ? ': hidden until you reveal it' : ''));
  app.refresh();
}

// ---- who sees a players' page ---------------------------------------------------------

// The "who can see it" part of a players' page's info: everyone or only some
// players, and whether it is hidden until revealed (the audience is kept).
function visibilityFields(s, f) {
  const players = s.players || [];
  const only = isOnly(f);
  const allowed = new Set(f.allowed || []);
  return '<fieldset class="mg-choice vis"><legend>Shown to <span class="hint">the referee always sees it</span></legend>' +
    '<label><input type="radio" name="audience" value=""' + (only ? '' : ' checked') + '><span>every player</span></label>' +
    '<label><input type="radio" name="audience" value="only"' + (only ? ' checked' : '') + '><span>only these players' +
      '<span class="hint">for a clue or note meant for some of them. Ticking nobody keeps it for you alone.</span></span></label>' +
    '<div class="vis-players">' + (players.length
      ? players.map((p) => '<label class="vis-p"><input type="checkbox" name="allowed" value="' + esc(p.id) + '"' + (allowed.has(p.id) ? ' checked' : '') + '>' +
          ic('player', 'deco') + '<span>' + esc(p.name) + '</span></label>').join('')
      : '<span class="mg-muted">No players in the party yet: add them under PARTY in the campaign panel.</span>') + '</div>' +
    '</fieldset>' +
    '<label class="pp-toggle hide-toggle"><input type="checkbox" name="hidden"' + (isHidden(f) ? ' checked' : '') + '>' +
      '<span><b>' + ic('hidden', 'deco') + ' Hidden until I reveal it</b><span class="hint">No player sees it, not even its name. ' +
      'Reveal it from its row when the moment comes; it then goes to whoever is chosen above.</span></span></label>';
}

// ---- the party -------------------------------------------------------------------------

export async function renamePlayer(id) {
  const p = (A.current.players || []).find((x) => x.id === id);
  if (!p) return;
  const v = await formOverlay({
    title: 'Rename player', icon: 'player',
    fields: [{ name: 'name', label: 'Name', hint: 'their copies stay theirs', value: p.name, max: 40, required: true }]
  });
  if (!v || v.name.trim() === p.name) return;
  await api('PATCH', playersBase(A.current) + '/' + enc(id), { name: v.name });
  toast('Renamed ' + p.name + ' to ' + v.name.trim());
  app.refresh();
}

export async function removePlayer(id) {
  const p = (A.current.players || []).find((x) => x.id === id);
  if (!p) return false;
  const choice = await confirmDialog('Remove player', 'Remove ' + p.name + ' from the party? Their device goes back to "who are you?" on per-player pages.', 'remove player', {
    choice: {
      label: p.name + '\'s entries',
      options: [
        { value: 'keep', label: 'keep them', hint: 'adding ' + p.name + ' again brings them back' },
        { value: 'delete', label: 'delete them', hint: 'every per-player page they filled in. This can\'t be undone.' }
      ]
    }
  });
  if (!choice) return false;
  await api('DELETE', playersBase(A.current) + '/' + enc(id) + (choice === 'delete' ? '?entries=delete' : ''));
  toast('Removed ' + p.name + (choice === 'delete' ? ' and their entries' : '. Their entries are kept.'));
  app.refresh();
  return true;
}
