// wadeea-observe: the observability dashboard, itself a Telnyx Edge Function.
// Serves the dashboard page and one API route that assembles metrics from the
// Telnyx logs REST API (API key stays server-side) and the MCP /stats endpoint.
// Plain function: no actors, no bindings; stateless except a short cache.
//
// Access: every route except /health requires ?key=<DASH_KEY> (Edge secret).

import * as http from "node:http";
import { buildSnapshot, type WatchedFunc } from "./snapshot.js";
import { PAGE } from "./page.js";

const FUNCS: WatchedFunc[] = [
  { id: "923bbb9e-9ed1-4018-83d8-cab9da76381b", label: "webhook" }, // wadeea-dynamic-variables-v3
  { id: "c722fc30-3d55-47cc-9427-3cfb2bd8f652", label: "mcp" }, // wadeea-mcp
];
const STATS_URL = "https://wadeea-mcp-c722fc30-3.telnyxcompute.com/stats";
const CACHE_MS = 4_000; // several viewers share one REST round-trip

let cached: { at: number; body: string } | null = null;

function authorized(url: URL): boolean {
  const want = process.env.DASH_KEY;
  return typeof want === "string" && want.length > 0 && url.searchParams.get("key") === want;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");

  if (url.pathname === "/health" || url.pathname.startsWith("/health/")) {
    res.writeHead(200);
    res.end();
    return;
  }

  if (!authorized(url)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing or wrong key" }));
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }

  if (url.pathname === "/api/snapshot") {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      const snap = await buildSnapshot({
        funcs: FUNCS,
        statsUrl: STATS_URL,
        apiKey: process.env.TELNYX_API_KEY ?? "",
      });
      cached = { at: Date.now(), body: JSON.stringify(snap) };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(cached.body);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`wadeea-observe listening on :${port}`);
});
