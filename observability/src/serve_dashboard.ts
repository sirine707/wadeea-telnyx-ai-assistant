// STEP 4 of the pipeline: read_logs → parse_logs → compute_metrics → serve_dashboard.
// The entry point (`npm run observe`): glues the steps together and pushes
// events + metrics snapshots to dashboard.html over SSE. Runs locally.

import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLogLine, type WadeeaEvent } from "./parse_logs";
import { MetricsAggregator, type Alert } from "./compute_metrics";
import { backfillLines, tail, type TailHandle, type WatchedFunc } from "./read_logs";
import { pollStats } from "./poll_stats";

const FUNCS: WatchedFunc[] = [
  { name: "wadeea-dynamic-variables-v3", label: "webhook" },
  { name: "wadeea-mcp", label: "mcp" },
];
const PORT = Number(process.env.PORT ?? 8787);
const RECENT_MAX = 300;
// Instant tool-call counters, polled straight from the running MCP instance
// (no log delay). Silent until the /stats endpoint is deployed.
const MCP_STATS_URL = "https://wadeea-mcp-c722fc30-3.telnyxcompute.com/stats";

const metrics = new MetricsAggregator();
const recent: WadeeaEvent[] = [];
const clients = new Set<ServerResponse>();

function send(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown): void {
  for (const c of clients) send(c, event, data);
}

// Our own /stats polling and health probes are monitoring self-traffic; showing
// them would drown out real tool calls in every panel.
const MONITOR_PATHS = new Set(["/health", "/stats"]);

function ingest(label: string, line: string, live: boolean): void {
  for (const ev of parseLogLine(label, line)) {
    if (ev.kind === "invocation" && MONITOR_PATHS.has(ev.path)) continue;
    const alerts: Alert[] = metrics.add(ev);
    recent.push(ev);
    if (recent.length > RECENT_MAX) recent.shift();
    if (live) {
      broadcast("log", ev);
      for (const a of alerts) broadcast("alert", a);
    }
  }
}

// Backfill the last hour so the screen isn't empty, then attach live tails.
// Runs in the background: the page is reachable the moment the process starts.
const tails: TailHandle[] = [];

async function intake(): Promise<void> {
  console.log("[observe] backfilling last hour...");
  for (const f of FUNCS) {
    for (const type of ["runtime", "invocations"] as const) {
      for (const line of await backfillLines(f, type)) ingest(f.label, line, false);
    }
  }
  console.log(`[observe] backfill done (${recent.length} events); attaching live tails`);
  broadcast("backlog", recent);
  broadcast("snapshot", metrics.snapshot());
  for (const f of FUNCS) tails.push(tail(f, (line) => ingest(f.label, line, true)));
}

// Instant path: latest /stats snapshot, pushed to browsers as it changes.
let latestStats: unknown = null;
pollStats(MCP_STATS_URL, (snap) => {
  latestStats = snap;
  broadcast("stats", snap);
});

// Ctrl-C must also stop the `telnyx-edge logs --tail` child processes.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const t of tails) t.stop();
    process.exit(0);
  });
}

// Push fresh metrics to every open browser every 2 seconds.
setInterval(() => broadcast("snapshot", metrics.snapshot()), 2_000);

const page = readFileSync(join(__dirname, "..", "dashboard.html"));

createServer((req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    send(res, "snapshot", metrics.snapshot());
    send(res, "backlog", recent);
    if (latestStats) send(res, "stats", latestStats);
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  res.writeHead(404).end("not found");
}).listen(PORT, () => {
  console.log(`[observe] dashboard: http://wadeea.localhost:${PORT} (or http://localhost:${PORT})`);
  console.log(`[observe] watching: ${FUNCS.map((f) => f.name).join(", ")}`);
  void intake();
});
