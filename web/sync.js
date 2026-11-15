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
 *   sync.waiting()      how many changes haven't reached the server yet
 *
 * Changes that haven't reached the server are also kept in sessionStorage,
 * so typing done offline survives a reload of the page (for KEEP_MS). And
 * when the device wakes up or comes back online, a connection that has gone
 * quiet is replaced at once rather than after the dead-connection check.
 */
function createSync(o) {
  'use strict';
  var BATCH_MS = 200;      // changes this close together go out together
  var ACK_MS = 20000;      // no ack this long after a send: the connection is dead
  var SILENT_MS = 60000;   // the server says something every 25 s
  var WAKE_MS = 30000;     // quiet this long when the device wakes: reconnect now
  var KEEP_MS = 3600000;   // unsent changes kept over a reload for an hour
  var KEEP = 'mg-out:' + o.query;

  var outbox = {};         // keys changed here, not yet sent
  var lastSeen = {};       // key -> the value the server is known to have
  // Sets sent but not acknowledged yet: key -> number of its latest send. If
  // the connection dies first, they may never have arrived, so they go back
  // in the outbox, to be sent again after reconnecting.
  var unacked = {};
  var ws = null, synced = false, gone = false, retry = 0, seq = 0;
  var ackDue = 0, heard = 0, watch = null, sendTimer = null, retryTimer = null;
  var kept = load();       // unsent changes from before a reload: key -> value

  function norm(v) { return v === undefined ? null : v; }
  function same(a, b) { return JSON.stringify(norm(a)) === JSON.stringify(norm(b)); }
  function isEmpty(m) { for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) return false; return true; }

  function changed(key) {
    outbox[key] = true;
    if (!synced) keep();
    if (!sendTimer) sendTimer = setTimeout(flush, BATCH_MS);
  }

  function pendingKeys() {
    var m = {};
    Object.keys(outbox).forEach(function (k) { m[k] = true; });
    Object.keys(unacked).forEach(function (k) { m[k] = true; });
    return Object.keys(m);
  }

  // keep mirrors what hasn't reached the server into sessionStorage.
  function keep() {
    try {
      var keys = pendingKeys();
      if (!keys.length) { sessionStorage.removeItem(KEEP); return; }
      var v = {};
      keys.forEach(function (k) { v[k] = norm(o.read(k)); });
      sessionStorage.setItem(KEEP, JSON.stringify({ t: Date.now(), v: v }));
    } catch (e) { /* storage off or full: the outbox in memory still works */ }
  }

  function load() {
    try {
      var x = JSON.parse(sessionStorage.getItem(KEEP) || 'null');
      if (x && x.v && Date.now() - x.t < KEEP_MS) return x.v;
      sessionStorage.removeItem(KEEP);
    } catch (e) { /* nothing kept */ }
    return null;
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
    // Changes typed offline before a reload: shown again, and sent.
    if (kept) {
      Object.keys(kept).forEach(function (k) {
        if (!o.accept(k)) return;
        if (!(k in lastSeen)) lastSeen[k] = null;
        o.apply(k, kept[k]);
        outbox[k] = true;
      });
      kept = null;
    }
  }

  function connect() {
    retryTimer = null;
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
        if (isEmpty(unacked) && isEmpty(outbox)) keep();
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
    keep();
    if (o.onClose) o.onClose();
    if (gone) return;
    o.onStatus('offline');
    retryTimer = setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry++)));
  }

  // wake: the device woke up or came back online. A connection that has been
  // quiet for a while is probably dead: replace it now. One waiting to retry
  // tries now.
  function wake() {
    if (gone) return;
    if (ws && Date.now() - heard > WAKE_MS) { drop(); return; }
    if (!ws && retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
      retry = 0;
      connect();
    }
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

  addEventListener('pagehide', function () { flush(); keep(); });
  addEventListener('online', wake);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') wake(); });
  connect();
  return { changed: changed, flush: flush, waiting: function () { return pendingKeys().length; } };
}
