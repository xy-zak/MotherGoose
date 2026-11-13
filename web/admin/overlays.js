// The referee dashboard's overlays: Join Info, the data folder, a session's
// details and editing, a page's info popup (where a page is edited, its party
// and copies), and renaming or removing players.
import {
  agoText, api, attempt, canPerPlayer, confirmDialog, enc, esc, filledUrl,
  formOverlay, gameTag, hasEntries, ic, KIND_NAME, kindTag, kv, overlay,
  parseTags, playerName, SCOPE, scopeTag, size, titleOf, toast, viewUrl,
  when, withIcon
} from '/_mg/ui.js';
import { A, app, fileBase, filledCount, livePort, MAX_PLAYERS, other, playersBase } from './state.js';

export function joinOverlay() {
  const urls = (A.info && A.info.urls) || [];
  const others = urls.slice(1).map((u) => '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u) + '</a>').join('<br>');
  const body = urls.length
    ? '<div class="mg-section-label">Players open</div>' +
      '<a class="join-url" href="' + esc(A.info.primary) + '" target="_blank" rel="noopener">' + esc(A.info.primary) + '</a>' +
      '<div class="qr"><img src="/api/qr.png" alt="QR code for ' + esc(A.info.primary) + '"></div>' +
      '<p class="mg-muted">Players need to be on the same Wi-Fi or network as this computer. They can scan the code with a phone camera.</p>' +
      (others ? '<hr class="mg-rule"><div class="mg-section-label">If that doesn\'t work, try</div><p>' + others + '</p>' : '')
    : '<p>No network connection found. Connect this computer to Wi-Fi or a LAN, then reload.</p>';
  overlay({ title: 'Join Info', icon: 'join', body });
}

export function dataOverlay() {
  overlay({
    title: 'Data folder',
    icon: 'data',
    wide: true,
    body: kv([['location', '<code>' + esc(A.info ? A.info.dataDir : '') + '</code>']]) +
      '<pre class="tree">data/\n  config.json              which session is live\n  sessions/\n    the-sunken-keep/\n      session.json         name, game type, page descriptions and tags\n' +
      '      shared/              players\' pages\n      gm/                  referee\'s pages (this computer only)\n      state/               what people typed (managed for you)\n        players/           each player\'s copy of per-player pages</pre>' +
      '<p class="mg-muted">Copy .html, .pdf, .png or .jpg files into <code>shared/</code> (players) or <code>gm/</code> (referee) and they appear within a couple of seconds. Back up by copying the whole folder.</p>'
  });
}

export async function editSession() {
  const s = A.current;
  const v = await formOverlay({
    title: 'Edit session', icon: 'edit',
    fields: [
      { name: 'name', label: 'Name', value: s.name, max: 120, required: true },
      { name: 'gameType', label: 'Game type', hint: 'the game or rules you\'re playing', value: s.gameType, max: 60 }
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
    title: 'Session: ' + s.name,
    icon: 'info',
    wide: true,
    body: kv([
      ['name', esc(s.name)], ['game type', s.gameType ? gameTag(s.gameType) : '<span class="mg-muted">not set</span>'],
      ['id', '<code>' + esc(s.id) + '</code>'],
      ['status', s.active ? livePort() : 'not running'],
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
  const row = (who, name, note, filled) =>
    '<li class="copy' + (who ? '' : ' template') + '">' +
      '<span class="who">' + ic(who ? 'player' : 'template', 'deco') + '<b>' + esc(name) + '</b><span class="mg-muted">' + note + '</span></span>' +
      '<span class="state">' + (filled ? '<span class="mg-tag filled">filled in</span>' : '<span class="mg-muted">no entries</span>') + '</span>' +
      '<span class="acts">' +
        '<a class="mg-btn quiet small compact" href="' + viewUrl(s.id, f, '', who) + '" target="_blank" rel="noopener" title="Open ' + esc(who ? name + '\'s copy' : 'the template') + '">' + withIcon('open', 'open') + '</a>' +
        '<a class="mg-btn quiet small compact" href="' + filledUrl(s.id, f, who) + '"' + (f.kind === 'pdf' ? ' target="_blank" rel="noopener"' : ' download') +
          ' title="Export ' + esc(who ? name + '\'s copy' : 'the template') + ' filled in' + (f.kind === 'pdf' ? ' (opens the viewer, which downloads it)' : '') + '">' + withIcon('export', 'export filled') + '</a>' +
        '<button type="button" class="mg-btn quiet small compact" data-copy-reset="' + esc(who) + '"' + (filled ? '' : ' disabled') + ' title="Clear ' + esc(who ? name + '\'s entries' : 'the template\'s entries') + '">' + withIcon('reset', 'reset') + '</button>' +
      '</span></li>';
  const players = s.players || [];
  return '<div><div class="mg-section-label">' + ic('player') + ' Copies</div>' +
    '<ul class="copies">' + row('', 'template', 'starting values', f.hasState) +
      players.map((p) => row(p.id, p.name, '', !!(f.playerState && f.playerState[p.id]))).join('') + '</ul></div>' +
    (players.length ? '' : '<p class="mg-muted">No players in the party yet: add them in the PARTY panel.</p>');
}

// The info popup is where a page is edited: name, description, tags and the
// per-player switch are saved together with "save"; party changes (when the
// page is per player) apply straight away, as in the PARTY panel.
export async function fileOverlay(scope, name) {
  const s = A.current;
  const f = (s.files[scope] || []).find((x) => x.name === name);
  if (!f) return;
  const base = fileBase(s, scope, name);
  const per = !!f.perPlayer;
  const perOk = canPerPlayer(Object.assign({}, f, { scope }));
  const dot = f.name.lastIndexOf('.');
  const stem = f.name.slice(0, dot), ext = f.name.slice(dot);

  const body = document.createElement('div');
  body.className = 'finfo';
  body.innerHTML =
    '<form class="fform" id="fform" autocomplete="off">' +
      '<label class="mg-field"><span>File name <span class="hint">the type (' + esc(ext) + ') stays the same</span></span>' +
        '<span class="fname-row"><input class="mg-input" name="stem" value="' + esc(stem) + '" maxlength="190" required aria-label="File name"><span class="ext">' + esc(ext) + '</span></span></label>' +
      '<label class="mg-field"><span>Description <span class="hint">' + (scope === 'gm' ? 'only you see this' : 'players see this') + '</span></span>' +
        '<textarea class="mg-input" name="description" maxlength="1000" placeholder="What is this page? When should players open it?">' + esc(f.description || '') + '</textarea></label>' +
      '<label class="mg-field"><span>Tags <span class="hint">separated by commas</span></span>' +
        '<input class="mg-input" name="tags" value="' + esc((f.tags || []).join(', ')) + '" placeholder="map, level 2, handout"></label>' +
      (perOk
        ? '<label class="pp-toggle"><input type="checkbox" name="perPlayer"' + (per ? ' checked' : '') + '>' +
            '<span><b>' + ic('player', 'deco') + ' Per player</b><span class="hint">Every player in the party fills in their own copy, seen only by them and you. ' +
            'Entries already in the page become each player\'s starting values. Turning it off keeps their copies for later.</span></span></label>'
        : '') +
      '<button type="submit" hidden></button>' +
    '</form>' +
    '<div class="fparty" id="fparty"' + (per ? '' : ' hidden') + '></div>' +
    '<div class="fcopies" id="fcopies"></div>' +
    '<hr class="mg-rule">' +
    kv([
      ['for', scopeTag(scope) + ' <span class="mg-muted">' + (scope === 'gm' ? 'this computer only' : per ? 'each player their own copy, when the session is live' : 'every player, when the session is live') + '</span>'],
      ['type', kindTag(f.kind) + ' ' + KIND_NAME[f.kind]],
      ['size', size(f.size)], ['changed', esc(when(f.modified)) + ' <span class="mg-muted">(' + esc(agoText(f.modified)) + ')</span>'],
      ['entries', !hasEntries(f) ? '<span class="mg-muted">not applicable</span>'
        : per ? filledCount(s, f) + ' of ' + (s.players || []).length + ' players' + (f.hasState ? ', and the template' : '')
        : f.hasState ? '<span class="mg-tag filled">filled in</span>' : 'none yet']
    ]) +
    (hasEntries(f) ? '<p class="mg-muted">Export filled downloads a copy with ' + (per ? 'that copy\'s entries' : 'every entry') + ' baked in' +
      (f.kind === 'pdf' ? ': it opens the PDF viewer, which fills in the fields and downloads the PDF.' : '. It works offline.') + '</p>' : '');

  const form = body.querySelector('#fform');
  const partyEl = body.querySelector('#fparty');
  const copiesEl = body.querySelector('#fcopies');

  // The party and each copy, redrawn after every party change.
  function drawParty() {
    const sess = A.current;
    const players = sess.players || [];
    const full = players.length >= MAX_PLAYERS;
    partyEl.innerHTML =
      '<div class="mg-section-label">' + ic('players') + ' Party</div>' +
      '<p class="mg-muted fnote">The party of this whole session. Adding or removing a player applies straight away.</p>' +
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
    copiesEl.innerHTML = live.perPlayer ? copiesList(sess, live) : '';
  }
  drawParty();

  async function reloadSession() {
    A.current = await api('GET', '/api/admin/sessions/' + enc(s.id));
    drawParty();
  }

  async function save(d) {
    const v = Object.fromEntries(new FormData(form).entries());
    const newStem = (v.stem || '').trim();
    if (!newStem) { toast('The file name can\'t be empty', true); return; }
    let target = name;
    const changed = [];
    if (newStem !== stem) {
      await api('PATCH', base, { name: newStem + ext });
      target = newStem + ext;
      changed.push('renamed to ' + target);
    }
    const metaBody = { description: v.description || '', tags: parseTags(v.tags) };
    const wantPer = perOk && !!v.perPlayer;
    if (perOk) metaBody.perPlayer = wantPer;
    await api('PUT', fileBase(s, scope, target) + '/meta', metaBody);
    if (perOk && wantPer !== per) changed.push(wantPer ? 'now per player' : 'shared again: everyone sees one copy');
    toast((changed.length ? target + ' ' + changed.join(', ') : 'Saved details for ' + target));
    d.close();
  }

  const actions = [];
  if (!per) actions.push({ label: 'open', href: viewUrl(s.id, f), kind: 'quiet', icon: 'open' });
  if (!per && hasEntries(f)) actions.push({ label: 'export filled', href: filledUrl(s.id, f), download: f.kind === 'html', icon: 'export', kind: 'quiet' });
  if (!per && f.hasState) actions.push({ label: 'reset entries', value: 'reset', kind: 'danger', icon: 'reset' });
  const to = other(scope);
  actions.push({ label: 'move to ' + SCOPE[to].label, value: 'move', kind: SCOPE[to].cls, icon: to === 'gm' ? 'to-referee' : 'to-players' });
  actions.push({ label: 'delete', value: 'delete', kind: 'danger', icon: 'delete' });
  actions.push({ label: 'save', value: 'save', kind: 'primary', icon: 'check' });

  let reset;  // a copy to reset, from the list: '' is the template
  const v = await overlay({
    title: titleOf(f),
    icon: 'info',
    wide: true,
    body,
    actions,
    onOpen: (d) => {
      const first = form.querySelector('textarea');
      if (first) first.focus();
      // Save keeps the popup open if something fails, so nothing typed is lost.
      const saveBtn = d.querySelector('.mg-dialog-foot .primary');
      saveBtn.addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        attempt(save)(d);
      }, { capture: true });
      form.addEventListener('submit', (e) => { e.preventDefault(); attempt(save)(d); });
      // Ticking per player shows the party, so players can be added before saving.
      const pp = form.querySelector('[name=perPlayer]');
      if (pp) pp.addEventListener('change', () => { partyEl.hidden = !pp.checked; });
      d.addEventListener('click', attempt(async (e) => {
        const r = e.target.closest('[data-copy-reset]');
        if (r && !r.disabled) { reset = r.dataset.copyReset; d.close(); return; }
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
  if (reset !== undefined) {
    const whose = reset ? playerName(A.current.players, reset) + '\'s copy of "' + f.name + '"' : 'the template of "' + f.name + '"';
    if (await confirmDialog('Reset entries', 'Clear everything typed into ' + whose + '? Anyone viewing it reloads empty.' +
        (reset ? '' : ' Players\' copies are kept.'), 'clear entries')) {
      await api('DELETE', base + '/state' + (reset ? '?player=' + enc(reset) : ''));
      toast('Entries cleared');
    }
  } else if (v === 'reset' && await confirmDialog('Reset entries', 'Clear everything typed into "' + f.name + '"? Every device viewing it reloads empty.', 'clear entries')) {
    await api('DELETE', base + '/state');
    toast('Entries cleared');
  } else if (v === 'move') {
    await move(scope, name, to);
    return;
  } else if (v === 'delete' && await confirmDialog('Delete file', 'Delete "' + f.name + '"' + (per ? ' and every player\'s copy of it' : f.hasState ? ' and everything typed into it' : '') + '? This can\'t be undone.', 'delete file')) {
    await api('DELETE', base);
    toast('Deleted ' + f.name);
  }
  app.refresh();
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


export async function move(scope, name, to) {
  await api('PATCH', fileBase(A.current, scope, name), { scope: to });
  toast('Moved ' + name + ' to the ' + SCOPE[to].label);
  app.refresh();
}
