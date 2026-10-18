// MAIN-world TradingView WebSocket sniffer.
// Injected as a <script> tag (web-accessible resource) so it runs in the page
// world and can observe the TradingView data stream. It forwards parsed quote
// ticks to the ISOLATED content script via window.postMessage.
(function () {
  if (window.__llmTvSnifferInstalled) return;
  window.__llmTvSnifferInstalled = true;

  var latest = {};

  function emit(tick) {
    try {
      latest = tick;
      window.postMessage({ source: 'LLM-TV-SNIFFER', type: 'tick', tick: tick }, '*');
    } catch (e) {
      // ignore
    }
  }

  function parseFrames(data) {
    if (typeof data !== 'string' || data.indexOf('~m~') === -1) return;
    // TradingView frames: ~m~<len>~m~<payload>
    var re = /~m~(\d+)~m~([\s\S]*?)(?=~m~\d+~m~|$)/g;
    var m;
    while ((m = re.exec(data)) !== null) {
      var payload = m[2];
      if (!payload || payload.charAt(0) === '{') {
        try {
          var obj = JSON.parse(payload);
          handleMessage(obj);
        } catch (e) {
          // not JSON (e.g. ~h~ heartbeat) — ignore
        }
      }
    }
  }

  function handleMessage(obj) {
    if (!obj || typeof obj !== 'object') return;
    try {
      // Quote stream data: {m:'qsd', p:[<sid>, {s:'ok'|'error', n:<symbol>, v:[{v:<value>, f?}...]}]}
      if (obj.m === 'qsd' && Array.isArray(obj.p) && obj.p[1] && typeof obj.p[1] === 'object') {
        var q = obj.p[1];
        if (q.s !== 'ok') return;
        var values = Array.isArray(q.v) ? q.v : [];
        var last = null;
        var prevClose = null;
        var change = null;
        var changePercent = null;
        for (var i = 0; i < values.length; i++) {
          var item = values[i];
          if (!item || typeof item !== 'object') continue;
          if (item.v === undefined) continue;
          // index 0 = last price, 1 = high?, per TV convention: 0 last, 1 prev close-ish
          if (last === null && typeof item.v === 'number') last = item.v;
        }
        // Explicit numeric fields when present
        if (typeof q.lp === 'number') last = q.lp;
        emit({
          symbol: q.n || null,
          last: last,
          prevClose: typeof q.pc === 'number' ? q.pc : null,
          change: typeof q.d === 'number' ? q.d : change,
          changePercent: typeof q.dp === 'number' ? q.dp : changePercent,
          high: typeof q.h === 'number' ? q.h : null,
          low: typeof q.l === 'number' ? q.l : null,
          open: typeof q.o === 'number' ? q.o : null,
          time: Date.now(),
        });
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  var NativeWebSocket = window.WebSocket;
  function PatchedWebSocket() {
    var ws = arguments.length === 1 ? new NativeWebSocket(arguments[0]) : new NativeWebSocket(arguments[0], arguments[1]);
    try {
      ws.addEventListener('message', function (event) {
        if (typeof event.data === 'string') parseFrames(event.data);
      });
    } catch (e) {
      // ignore
    }
    return ws;
  }
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  PatchedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = NativeWebSocket.OPEN;
  PatchedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  window.WebSocket = PatchedWebSocket;

  // Answer queries from the content script.
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (data && data.source === 'LLM-TV-SNIFFER-QUERY' && data.query === 'latest') {
      window.postMessage({ source: 'LLM-TV-SNIFFER', type: 'latest', tick: latest }, '*');
    }
  });
})();
