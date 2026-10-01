// The dashboard page, served at "/". Same visual as observability/dashboard.html,
// but it polls this function's /api/snapshot every 5s instead of a local SSE
// stream, so it works from any browser given the access key in the URL.

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wadeea Observability</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #12161f; --border: #1f2633; --text: #d7dce5;
    --dim: #7a8496; --accent: #4cc38a; --warn: #e5c07b; --err: #e06c75; --blue: #61afef;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 16px; overflow-x: hidden; }
  header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; letter-spacing: 1px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--err); display: inline-block; }
  .dot.live { background: var(--accent); box-shadow: 0 0 6px var(--accent); }
  .dim { color: var(--dim); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .card h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--blue); }
  .stats { display: flex; gap: 18px; flex-wrap: wrap; }
  .stat b { display: block; font-size: 19px; font-weight: 600; }
  .stat span { color: var(--dim); font-size: 11px; }
  .bar { height: 6px; background: var(--border); border-radius: 3px; margin-top: 10px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); }
  .cols { display: flex; align-items: stretch; }
  .cols > .panel { min-width: 0; }
  #streamPanel { flex: 0 0 60%; }
  #divider { flex: 0 0 6px; cursor: col-resize; background: var(--border); border-radius: 3px; margin: 0 3px; }
  #tracesPanel { flex: 1; }
  @media (max-width: 900px) { .cols { flex-direction: column; } #divider { display: none; } #streamPanel { flex: none; } }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .panel h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--blue); }
  #alerts:empty::after { content: "no alerts — system healthy"; color: var(--dim); }
  .alert { color: var(--err); margin: 2px 0; }
  .alert .hint { color: var(--warn); }
  #stream { height: 420px; overflow-y: auto; }
  /* hanging indent: wrapped continuation lines indent so they read as part of the same entry */
  .row { overflow-wrap: anywhere; padding-left: 2ch; text-indent: -2ch; }
  .row .t { color: var(--dim); }
  .dup { opacity: 0.3; } /* repeated date/time stays in place, just fades */
  .fn-webhook { color: var(--warn); } .fn-mcp { color: var(--blue); }
  .ok { color: var(--accent); } .bad { color: var(--err); }
  details { margin: 4px 0; } summary { cursor: pointer; }
  .step { margin-left: 16px; color: var(--dim); overflow-wrap: anywhere; padding-left: 2ch; text-indent: -2ch; }
  .badge { border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
</style>
</head>
<body>
<header>
  <h1>WADEEA <span class="dim">· live observability</span></h1>
  <span><span id="conn" class="dot"></span> <span id="connText" class="dim">connecting…</span></span>
  <span class="dim">watching: wadeea-dynamic-variables-v3 · wadeea-mcp — served from Telnyx Edge</span>
  <span class="dim" id="clock"></span>
</header>

<div class="cards" id="cards"></div>

<div class="panel" style="margin-bottom:12px; display:none" id="statsPanel">
  <h2>Instant tool calls <span class="dim">(GET /stats — data-plane read, no log delay)</span></h2>
  <div id="stats"></div>
</div>

<div class="panel" style="margin-bottom:12px">
  <h2>Alerts</h2>
  <div id="alerts"></div>
</div>

<div class="cols">
  <div class="panel" id="streamPanel">
    <h2>Live log stream</h2>
    <div id="stream"></div>
  </div>
  <div id="divider" title="drag to resize"></div>
  <div class="panel" id="tracesPanel">
    <h2>Call traces <span class="dim">(by telnyx_conversation_id)</span></h2>
    <div id="traces"></div>
  </div>
</div>

<script>
"use strict";
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
};
var fmt = function (n) { return n == null ? "—" : (n >= 100 ? Math.round(n) : n.toFixed(1)); };
var time = function (ts) { return ts ? ts.slice(5, 10) + " " + ts.slice(11, 19) : ""; };
// Timestamp for stream rows: hide the parts identical to the previous row.
var tsHtml = function (ts, prevTs) {
  var cur = time(ts);
  var prev = prevTs ? time(prevTs) : "";
  if (cur === prev) return '<span class="t dup">' + cur + "</span>";
  if (prev && cur.slice(0, 5) === prev.slice(0, 5))
    return '<span class="t"><span class="dup">' + cur.slice(0, 5) + "</span>" + cur.slice(5) + "</span>";
  return '<span class="t">' + cur + "</span>";
};
setInterval(function () {
  $("clock").textContent = new Date().toISOString().slice(0, 19).replace("T", " ") + "Z";
}, 1000);

var FUNC_TITLES = { webhook: "Dynamic-variables webhook", mcp: "MCP server (6 tools + FleetInventory actor)" };
var EXTRA_KEYS = ["latency_ms", "call_count", "session_outcome", "session_ms", "kv_ms", "bookings_enabled",
  "returning_caller", "is_uae_caller", "node", "tool", "reserve", "actor_ms", "sqldb_ms", "total_ms", "booking_id"];
var flat = function (obj, name) { // one-level object -> "name(k=v ...)"
  if (!obj || typeof obj !== "object") return "";
  var keys = Object.keys(obj);
  if (!keys.length) return "";
  return name + "(" + keys.map(function (k) { return k + "=" + esc(obj[k]); }).join(" ") + ") ";
};
var extras = function (st) {
  return flat(st.args, "args") + flat(st.result, "result") +
    EXTRA_KEYS.filter(function (x) { return st[x] !== undefined; })
      .map(function (x) { return x + "=" + esc(st[x]); }).join(" ");
};
var KEY = new URLSearchParams(location.search).get("key") || "";
var traceOpen = {}; // conversation id -> user's open/closed choice (default open)
document.addEventListener("toggle", function (e) {
  var d = e.target;
  if (d.tagName === "DETAILS" && d.dataset.conv) traceOpen[d.dataset.conv] = d.open;
}, true);

function renderCards(funcs) {
  $("cards").innerHTML = Object.keys(funcs).map(function (name) {
    var f = funcs[name];
    var errCls = f.errors > 0 ? "bad" : "ok";
    var budget = "";
    if (name === "webhook" && f.appP95 != null) {
      budget = '<div class="bar"><i style="width:' + Math.min(100, f.appP95 / 3000 * 100) + '%"></i></div>' +
        '<span class="dim">app latency p50 ' + fmt(f.appP50) + "ms · p95 " + fmt(f.appP95) + "ms · budget 3000ms</span>";
    }
    return '<div class="card"><h2>' + esc(FUNC_TITLES[name] || name) + "</h2>" +
      '<div class="stats">' +
      '<div class="stat"><b>' + f.requests + "</b><span>requests</span></div>" +
      '<div class="stat"><b class="' + errCls + '">' + f.errors + "</b><span>errors</span></div>" +
      '<div class="stat"><b class="' + errCls + '">' + (f.errorRate * 100).toFixed(1) + "%</b><span>error rate</span></div>" +
      '<div class="stat"><b>' + fmt(f.p50) + '<span class="dim">ms</span></b><span>p50</span></div>' +
      '<div class="stat"><b>' + fmt(f.p95) + '<span class="dim">ms</span></b><span>p95</span></div>' +
      "</div>" + budget + "</div>";
  }).join("");
}

function renderAlerts(alerts) {
  $("alerts").innerHTML = alerts.slice(-8).reverse().map(function (a) {
    return '<div class="alert">▲ ' + time(a.ts) + " [" + esc(a.func) + "] " + esc(a.type) + ": " + esc(a.detail) +
      ' <span class="hint">→ ' + esc(a.hint) + "</span></div>";
  }).join("");
}

function renderTraces(convs, flows) {
  flows = flows || {};
  $("traces").innerHTML = convs.slice(0, 12).map(function (c) {
    var steps = c.steps.map(function (s) {
      var d = s.detail || {};
      var bits = (d.outcome !== undefined ? "outcome=" + esc(d.outcome) + " " : "") + extras(d);
      return '<div class="step">' + time(s.ts) +
        ' <span class="fn-' + esc(s.func) + '">[' + esc(s.func) + "]</span> " + esc(s.event) + " " + bits + "</div>";
    }).join("");
    var openAttr = traceOpen[c.conversationId] === false ? "" : " open";
    var flow = flows[c.conversationId]
      ? '<div class="step" style="color: var(--blue)">' + esc(flows[c.conversationId]) + "</div>"
      : "";
    return '<details data-conv="' + esc(c.conversationId) + '"' + openAttr + "><summary><span class=\\"badge\\">" + esc(c.conversationId.slice(0, 8)) + "</span> " +
      time(c.firstTs) + " · " + c.steps.length + " step(s)</summary>" + flow + steps + "</details>";
  }).join("") || '<span class="dim">no calls yet — dial the assistant</span>';
}

function rowHtml(ev, prevTs) {
  var fn = '<span class="fn-' + esc(ev.func) + '">[' + esc(ev.func) + "]</span>";
  var cls, st, outcome, conv;
  if (ev.kind === "invocation") {
    cls = ev.status < 400 ? "ok" : "bad";
    return '<div class="row">' + tsHtml(ev.ts, prevTs) +
      " " + fn + " " + esc(ev.method) + " " + esc(ev.path) + ' <span class="' + cls + '">' + ev.status +
      "</span> " + fmt(ev.durationMs) + 'ms <span class="dim">' + esc(ev.region) + "</span></div>";
  }
  if (ev.structured) {
    st = ev.structured;
    outcome = st.outcome === "ok" ? '<span class="ok">ok</span>' : '<span class="bad">' + esc(st.outcome == null ? "" : st.outcome) + "</span>";
    conv = st.telnyx_conversation_id ? '<span class="badge">' + esc(String(st.telnyx_conversation_id).slice(0, 8)) + "</span>" : "";
    return '<div class="row">' + tsHtml(ev.ts, prevTs) +
      " " + fn + " " + esc(st.event || "log") + " " + conv + " " + outcome + ' <span class="dim">' + extras(st) + "</span></div>";
  }
  return '<div class="row dim">' + tsHtml(ev.ts, prevTs) + " " + fn + " " + esc(ev.raw) + "</div>";
}

function renderStream(events) {
  var stream = $("stream");
  var atBottom = stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 30 || !stream.children.length;
  var saved = stream.scrollTop;
  var prev = "";
  stream.innerHTML = events.map(function (ev) {
    var html = rowHtml(ev, prev);
    prev = ev.ts;
    return html;
  }).join("");
  stream.scrollTop = atBottom ? stream.scrollHeight : saved;
}

function renderStats(s) {
  $("statsPanel").style.display = "";
  var tools = Object.keys(s.tool_calls);
  var counts = tools.length
    ? tools.map(function (t) {
        var errs = s.tool_errors[t] || 0;
        return '<span class="badge">' + esc(t) + ': <b class="' + (errs ? "bad" : "ok") + '">' + s.tool_calls[t] + "</b>" +
          (errs ? ' <span class="bad">(' + errs + " err)</span>" : "") + "</span>";
      }).join(" ")
    : '<span class="dim">no tool calls yet on this instance</span>';
  var recent = s.recent.slice(-6).reverse().map(function (r) {
    return '<div class="row">' + time(r.ts) + " " + esc(r.tool) + ' <span class="' + (r.ok ? "ok" : "bad") + '">' +
      (r.ok ? "ok" : "error") + "</span> " + fmt(r.latency_ms) + "ms " +
      (r.conversation_id ? '<span class="badge">' + esc(r.conversation_id.slice(0, 8)) + "</span>" : "") + "</div>";
  }).join("");
  $("stats").innerHTML = '<div style="margin-bottom:6px">' + counts +
    ' <span class="dim">· instance ' + esc(s.instance_id) + " up since " + time(s.started_at) + "</span></div>" + recent;
}

async function poll() {
  try {
    var res = await fetch("/api/snapshot?key=" + encodeURIComponent(KEY));
    if (!res.ok) throw new Error(String(res.status));
    var s = await res.json();
    renderCards(s.funcs);
    renderAlerts(s.alerts);
    renderTraces(s.conversations, s.flows);
    renderStream(s.recent);
    if (s.stats) renderStats(s.stats);
    $("conn").classList.add("live");
    $("connText").textContent = "live";
  } catch (e) {
    $("conn").classList.remove("live");
    $("connText").textContent = "reconnecting…";
  }
}
(function () {
  var divider = $("divider"), left = $("streamPanel");
  try { var w = localStorage.getItem("streamw"); if (w) left.style.flexBasis = w; } catch (e) {}
  divider.addEventListener("mousedown", function (e) {
    e.preventDefault();
    var move = function (ev) {
      var rect = left.parentNode.getBoundingClientRect();
      var px = Math.min(Math.max(ev.clientX - rect.left, 220), rect.width - 220);
      left.style.flexBasis = px + "px";
    };
    var up = function () {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      try { localStorage.setItem("streamw", left.style.flexBasis); } catch (e) {}
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
})();

setInterval(poll, 5000);
poll();
</script>
</body>
</html>
`;
