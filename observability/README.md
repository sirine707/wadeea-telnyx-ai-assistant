# Wadeea live observability dashboard

**Public, judge-shareable version (an Edge Function itself):**
`https://wadeea-observe-23449883-5.telnyxcompute.com/?key=<DASH_KEY>` — key in
`.env`. Source: `functions/wadeea-observe/` (Telnyx logs REST API + MCP
`/stats`, key-gated; the API key stays in an Edge secret, never in the
browser). What follows is the local variant of the same dashboard.

The judge-facing observability surface for demo day (assignment §5 + Demo Day
"logs or metrics visible while the demo runs"). A local web dashboard that
tails both live Edge Functions and renders logs, metrics, alerts, and
per-call traces in real time while the phone call happens.

**Read-only**: it only shells out to `telnyx-edge logs`. No ships, no platform
writes, no external services. Works offline except for the log stream itself.

## Run (demo day)

```bash
npm run observe        # then open http://localhost:8787
```

Requires: `telnyx-edge` CLI authenticated (same as the rest of the project).
On start it backfills the last hour so the screen isn't empty, then attaches
live tails to `wadeea-dynamic-variables-v3` and `wadeea-mcp`.

## What the judges see

- **Metric cards** — per function: request count, error count/rate, platform
  latency p50/p95; the webhook card also shows application `latency_ms`
  p50/p95 against its 3000 ms `dynamic_variables_webhook_timeout_ms` budget.
  This is the "signal beyond logs", computed live.
- **Alerts** — `signature_invalid` (→ check `TELNYX_PUBLIC_KEY`), non-2xx
  invocations (→ replay with curl; if `booking_failed`, check the snapshot
  bucket / run the janitor), slow webhook, session timeout. Each alert carries
  its "what to check first" hint from the runbook.
- **Live log stream** — the webhook's structured JSON lines and the MCP
  server's platform invocation records (one per tool call), from **all
  autoscaled replicas interleaved**.
- **Call traces** — events grouped by `telnyx_conversation_id`: dial the
  assistant and watch the call's path appear.

## Structure — one file per pipeline step

Data flows in a straight line: **read → parse → compute → serve**.

```
dashboard.html               the page the judges see (vanilla JS, no external assets)
src/read_logs.ts             step 1: raw lines from `telnyx-edge logs` (the only file that touches the CLI)
src/parse_logs.ts            step 2: raw JSON lines → typed events                 (pure, tested)
src/compute_metrics.ts       step 3: events → counters, alerts, call traces        (pure, tested)
src/serve_dashboard.ts       step 4: entry point — http server + SSE push to the page
test/                        Vitest suites for the two pure steps
```

The instant path (shipped 2026-09-29): the MCP function exposes `GET /stats` —
in-memory per-instance tool-call counters plus the last 50 calls (tool, ok,
latency_ms, conversation_id; never args, so no PII). `poll_stats.ts` reads it
every 2 s, so tool calls appear on the dashboard within ~2 s instead of after
the ~30–90 s platform log-ingestion delay. The same instrumentation point also
emits one structured `tool_call` runtime log line per call for the late-but-
durable trail. Counters reset when an instance restarts — by design; durable
records live in SQLDB.
