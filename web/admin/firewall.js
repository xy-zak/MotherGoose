// Whether players' devices can get through this computer's firewall, and a
// way to let them in. Linux firewalls (ufw, firewalld) drop players'
// connections without asking anyone, so the dashboard checks, says so in a
// yellow box, and offers to fix it: the server asks for the referee's
// password in the desktop's own prompt and opens MotherGoose's port to the
// local network only. Windows and macOS ask by themselves: nothing to show.
import { api, esc, ic, toast, withIcon } from '/_mg/ui.js';

let last = null;

/** firewallStatus asks the server (fresh: check again now, not a recent answer). */
export async function firewallStatus(fresh) {
  try { last = await api('GET', '/api/admin/firewall' + (fresh ? '?fresh=1' : '')); } catch (e) { last = null; }
  return last;
}

/** firewallNeedsAttention: the firewall blocks players, or might. */
export const firewallNeedsAttention = (st) => !!st && (st.state === 'blocked' || st.state === 'unknown');

/**
 * firewallBox is the yellow box: what's wrong, the button that fixes it, and
 * the command to run by hand. It is '' when there's nothing to say, or (with
 * okLine) a one-line all-clear.
 */
export function firewallBox(st, okLine) {
  if (!st) return '';
  if (!firewallNeedsAttention(st)) {
    return okLine && st.state === 'ok'
      ? '<p class="fw-ok mg-muted mg-small">' + ic('check') + ' The firewall (' + esc(st.firewall) + ') lets players\' devices in on port ' + st.port + '.</p>'
      : '';
  }
  const blocked = st.state === 'blocked';
  return '<div class="fw-box" role="alert">' +
    '<p class="fw-head">' + ic('warning') + '<b>' + (blocked ? 'Players can\'t join yet: this computer\'s firewall blocks them'
      : 'A firewall is on, and may stop players joining') + '</b></p>' +
    '<p>' + (blocked
      ? 'The firewall (' + esc(st.firewall) + ') turns away players\' devices, so the join links and QR codes won\'t open for them. It never asks: the connections are just dropped.'
      : 'The firewall (' + esc(st.firewall) + ') is on, but MotherGoose can\'t read its rules to tell whether players get through. If they can\'t open the join links, let them in.') + '</p>' +
    (st.canFix
      ? '<p class="fw-act"><button type="button" class="mg-btn fw-fix" data-fw-fix>' + withIcon('check', 'let players in') + '</button>' +
        '<span class="mg-small">Opens port ' + st.port + ' to devices on your network (' + esc(st.network) + ') only. Your password is asked for.</span></p>'
      : '') +
    (st.command
      ? '<details class="fw-cmd"' + (st.canFix ? '' : ' open') + '><summary>' + (st.canFix ? 'or run this in a terminal' : 'Run this in a terminal') + '</summary>' +
        '<p><code>' + esc(st.command) + '</code> <button type="button" class="mg-btn small quiet" data-fw-copy>' + withIcon('copy', 'copy') + '</button></p></details>'
      : '') +
    '</div>';
}

/**
 * wireFirewall handles the box's buttons inside el (once per element). After
 * a change, redraw(status) draws the box again.
 */
export function wireFirewall(el, redraw) {
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-fw-copy]')) {
      try { await navigator.clipboard.writeText(last ? last.command : ''); toast('Copied the command'); } catch (err) { toast('Select the command and copy it', true); }
      return;
    }
    const b = e.target.closest('[data-fw-fix]');
    if (!b || b.disabled) return;
    b.disabled = true;
    b.innerHTML = withIcon('search', 'waiting for your password…');
    try {
      last = await api('POST', '/api/admin/firewall/allow');
      toast(firewallNeedsAttention(last) ? 'The firewall was changed, but still seems to block players' : 'Players can get through the firewall now');
    } catch (err) {
      toast(err.message, true);
      last = await firewallStatus(true);
    }
    redraw(last);
  });
}
