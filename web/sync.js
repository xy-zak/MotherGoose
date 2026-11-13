/*
 * MotherGoose sync: keeps one copy of a page's entries in step with the
 * server over /ws/file. The protocol is described in docs/NETWORK.md.
 *
 * Both sync clients use it: inject.js for HTML pages and viewer/pdf.js for
 * PDFs. Each says how to read a field and how to show a value; everything
 * about the connection is here, so the two can't drift apart.
 *
 * A classic script in ES5 style. The server wraps it together with inject.js
 * into the one script it adds to every HTML page (and inlines into exported
 * copies), inside a function, so createSync never reaches the page's own
 * globals. The PDF viewer loads it on its own, before its module.
 *
 *   var sync = createSync({
 *     query:      the /ws/file query: session, scope, file and player
 *     accept:     function (key): whether a key from the server is this page's
 *     read:       function (key): the value here now (undefined: none)
 *     apply:      function (key, value): show a value from the server
 *     onStatus:   function (status): 'connecting' | 'live' | 'offline' | 'closed'
 *     onSnapshot: function (): optional, after each snapshot is applied
 *     onClose:    function (): optional, whenever the connection closes
 *   });
 *   sync.changed(key)   a field changed here: send it soon
 *   sync.flush()        send what's waiting now
 */
function createSync(o) {
  'use strict';
  var BATCH_MS = 200;      // changes this close together go out together
  var ACK_MS = 20000;      // no ack this long after a send: the connection is dead
  var SILENT_MS = 60000;   // the server says something every 25 s

  var outbox = {};         // keys changed here, not yet sent
  var lastSeen = {};       // key -> the value the server is known to have
  // Sets sent but not acknowledged yet: key -> number of its latest send. If
  // the connection dies first, they may never have arrived, so they go back
  // in the outbox, to be sent again after reconnecting.
  var unacked = {};
  var ws = null, synced = false, gone = false, retry = 0, seq = 0;
  var ackDue = 0, heard = 0, watch = null, sendTimer = null;

  function norm(v) { return v === undefined ? null : v; }
  function same(a, b) { return JSON.stringify(norm(a)) === JSON.stringify(norm(b)); }
  function isEmpty(m) { for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) return false; return true; }

  function changed(key) {
    outbox[key] = true;
    if (!sendTimer) sendTimer = setTimeout(flush, BATCH_MS);
  }

  function flush() {
    clearTimeout(sendTimer);
    sendTimer = null;
    if (!ws || ws.readyState !== 1 || !synced) return;
    Object.keys(outbox).forEach(function (k) {
      var v = norm(o.read(k));
      // Never send what the server already has: pages whose scripts calculate
      // fields would otherwise bounce the results between devices.
      if (same(v, lastSeen[k])) return;
      lastSeen[k] = v;
      unacked[k] = ++seq;
      ws.send(JSON.stringify({ type: 'set', key: k, value: v, seq: seq }));
    });
    outbox = {};
    if (!ackDue && !isEmpty(unacked)) ackDue = Date.now() + ACK_MS;
  }

  function remote(k, v) {
    v = norm(v);
    lastSeen[k] = v;
    o.apply(k, v);
  }

  // The snapshot is everything the server has, so it replaces what we knew.
  // An edit made here that hasn't reached the server wins over it.
  function snapshot(state) {
    lastSeen = {};
    Object.keys(state).forEach(function (k) {
      if (!o.accept(k)) return;
      if (outbox[k] && !same(o.read(k), state[k])) { lastSeen[k] = norm(state[k]); return; }
      remote(k, state[k]);
    });
  }

  function connect() {
    o.onStatus('connecting');
    ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/file?' + o.query);
    heard = Date.now();
    watch = setInterval(function () {
      var now = Date.now();
      if (now - heard > SILENT_MS || (ackDue && now > ackDue)) drop();
    }, 5000);
    ws.onopen = function () { retry = 0; heard = Date.now(); };
    ws.onmessage = function (ev) {
      heard = Date.now();
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'snapshot') {
        synced = true;
        snapshot(m.state || {});
        o.onStatus('live');
        flush();
        if (o.onSnapshot) o.onSnapshot();
      } else if (m.type === 'set') {
        if (typeof m.key === 'string' && o.accept(m.key)) remote(m.key, m.value);
      } else if (m.type === 'ack') {
        Object.keys(unacked).forEach(function (k) { if (unacked[k] <= m.seq) delete unacked[k]; });
        ackDue = isEmpty(unacked) ? 0 : Date.now() + ACK_MS;
      } else if (m.type === 'reload') {
        location.reload();
      } else if (m.type === 'gone') {
        // The page was closed by the referee: what's typed from now on
        // stays on this device.
        gone = true;
        o.onStatus('closed');
        drop();
      }
    };
    ws.onclose = closed;
  }

  function closed() {
    ws = null;
    synced = false;
    clearInterval(watch);
    Object.keys(unacked).forEach(function (k) { outbox[k] = true; });
    unacked = {};
    ackDue = 0;
    if (o.onClose) o.onClose();
    if (gone) return;
    o.onStatus('offline');
    setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry++)));
  }

  // drop gives up on a connection: the browser can take minutes to notice one
  // that died without closing (Wi-Fi lost, laptop asleep).
  function drop() {
    var old = ws;
    if (!old) return;
    old.onopen = old.onmessage = old.onclose = null;
    try { old.close(); } catch (e) { /* already closing */ }
    closed();
  }

  addEventListener('pagehide', flush);
  connect();
  return { changed: changed, flush: flush };
}
