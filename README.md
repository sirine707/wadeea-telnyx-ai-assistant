# Wadeea

A fictional Dubai car-rental voice assistant built on Telnyx. Inbound callers book
rentals, manage existing rentals, hear rental requirements, and get handed to a human
when the assistant can't help. All vehicle, price, and customer data is fictional and
tool-backed — the assistant never invents it.

## Architecture

Telnyx AI Assistant drives the call; Telnyx Edge Compute provides the data and the
atomic operations behind it.

```
┌──────────────┐
│  Caller       │
└──────┬───────┘
       ▼
┌──────────────────────────────────────────────┐
│  Telnyx AI Assistant                          │
│  Conversation Workflow (conversation_flow):    │
│   Greeting (speak) → Identify Intent (prompt) │
│      ├── New Booking (prompt)                  │
│      ├── Existing Rental (prompt)              │
│      └── Escalate (prompt / handoff)            │
└───┬───────────────┬──────────────┬────────────┘
    ▼               ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────────┐
│ Edge Fn  │  │ MCP      │  │ Workflow     │
│ webhook  │  │ server   │  │ routing      │
│ (dyn vars│  │ (Edge Fn)│  │ (LLM / expr) │
│ + KV)    │  └────┬─────┘  └──────────────┘
└────┬─────┘       │
     ▼             ▼
┌──────────┐  ┌──────────────┐
│   KV     │  │ FleetInventory│
│ (cache)  │  │ Actor         │
└──────────┘  │ (availability)│
              └──────────────┘
```

- **AI Assistant (Telnyx)** — conversation driver: instructions, greeting, a `conversation_flow` workflow (prompt/speak/tool nodes + LLM/variable/default edges), attached MCP server, dynamic-variables webhook, Handoff/Transfer. Callable via phone number.
- **Conversation Workflow** — Telnyx `conversation_flow` graph. Speak node for the greeting + Dubai rental disclosure (verbatim); prompt nodes for intent detection, slot collection, review.
- **Custom MCP server** (Edge function) — tools: `check_availability`, `get_quote`, `create_booking`. Telnyx injects `telnyx_conversation_id` per call.
- **Dynamic-variables webhook** (Edge function) — returns per-caller context at call start; values feed variable-comparison routing edges.
- **KV** — sessions, pricing, rental rules, feature flags, indexes (not vehicle availability).
- **FleetInventory Actor** — atomic read-modify-write; owns authoritative availability and reservation, prevents double-booking.
- **Deploy** — `telnyx-edge ship`.

See [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md) for decisions and open Telnyx questions.

## Workflow (all branches voice-tested)

```
Greeting (speak: verbatim greeting + Dubai rental disclosure)
  → Identify Intent (prompt)
       ├── New Booking (prompt)
       │     → Review Booking Request → Availability Check
       │         → check_availability → get_quote → confirm → create_booking
       ├── Existing Rental (prompt) → lookup_booking
       ├── Documents (prompt) → get_document_requirements / get_rental_rules
       └── Deposit-back / out-of-scope → Human Handoff (speak) → Transfer, or
           take-a-message → thank + hang up
```

Deterministic routing (edge order matters): deposit-back → handoff is declared
above the existing-rental edge; wrap-up is the last catch-all. Hang-up is
authorized in the base assistant instructions (the pattern the stock Front Desk
template uses) rather than a dedicated end node.

## How to interact

- **Phone:** `+1 ...` ← fill in the assistant's number (dial to start the workflow)
- **Dynamic-variables webhook:** https://wadeea-dynamic-variables-v3-923bbb9e-9.telnyxcompute.com
- **MCP server:** https://wadeea-mcp-c722fc30-3.telnyxcompute.com/mcp (publicly reachable; `/health` for liveness)

## Setup

```bash
# Telnyx Inference via OpenCode (dogfood Telnyx-hosted LLMs)
opencode plugin @telnyx/opencode
opencode auth login --provider telnyx --method "API Key"
# pick a model via the /telnyx TUI command

# Edge Compute
telnyx-edge new-func wadeea-dynamic-variables -l typescript
telnyx-edge new-func wadeea-mcp -l typescript
# edit func.toml to add KV + actor bindings
telnyx-edge ship

# Local checks before considering work done
npm run typecheck   # tsc --noEmit
npm run lint
npm test            # Vitest
```

## Observability

### Structured logging (live)

Every webhook call emits one structured JSON line — real production output:

```
[2026-09-29T15:35:12.269Z] {"event":"assistant.initialization","telnyx_conversation_id":"96916a0b-…","node":"dynamic-variables","latency_ms":87,"outcome":"ok","session_outcome":"ok","call_count":3}
```

Enough context to reconstruct what happened: who called (`telnyx_conversation_id`),
where (`node`), what happened (`outcome`: `ok` / `signature_invalid` /
`unexpected_event_type`; `session_outcome`: `ok` / `timeout` / `error`), and how it
felt (`latency_ms`). No PII.

```bash
telnyx-edge logs wadeea-dynamic-variables-v3 --tail            # our code's log lines, live
telnyx-edge logs wadeea-mcp --type invocations --since 1h      # platform: one record per HTTP request
```

The MCP server logs one structured `tool_call` line per tool invocation (tool, ok,
`latency_ms`, `telnyx_conversation_id` — never args, no PII) and exposes `GET /stats`,
an **instant** per-instance counter read that bypasses log ingestion entirely.

Two independent surfaces per function: **runtime** logs (what our code says) and
**invocation** records (what the platform saw — method, status, duration — emitted
even if the code logs nothing).
The platform runs each function as multiple autoscaled instances behind its own
load balancer; `logs --tail` streams from **all replicas interleaved**, so instance
churn (new boots, SIGTERM drains during revision swaps) is visible in the same stream.

### Signals beyond logs

- **A latency measurement:** `latency_ms` on every webhook line — the exact number the
  3000 ms `dynamic_variables_webhook_timeout_ms` budget is judged against (live values:
  87–153 ms, including the Ed25519 verify and the fenced CallSession actor call).
- **A counter:** `call_count` in the CallSession actor — a durable per-caller counter
  incremented on every call, surfaced in the same log line *and* spoken by the
  assistant (returning-caller greeting), so a stuck counter is audible, not just visible.
- **An instant counter read:** `GET /stats` on the MCP function — per-tool call/error
  counts and the last 50 calls, straight from the running instance (a data-plane
  read: visible on the dashboard within ~2 s, vs the ~30–90 s log-ingestion delay).
- **A single-request trace:** one `telnyx_conversation_id` correlates all four hops —
  portal per-conversation webhook log → our webhook runtime line → MCP invocation
  records → the tool call/result shown inline in the Conversation History transcript
  (with the active workflow node). That is the request's path through
  Function → KV/Actor → MCP, reconstructable end to end.

### "Broken within a minute" — what we'd see first, where we'd look

- **Assistant is generic (no personalization / no returning-caller greeting):** the dynamic-variables webhook failed or timed out. → Portal **per-conversation webhook logs** (request/response + timing), then `telnyx-edge logs wadeea-dynamic-variables-v3`. First signal: non-200 in the portal webhook log, or `outcome:"signature_invalid"` in ours — exactly how we caught the missing `TELNYX_PUBLIC_KEY` secret after cutover.
- **Assistant fabricates availability/price:** a tool returned structured "unavailable" and the model spoke a price anyway. → **Conversation History** transcript (shows node + tool call/result inline). First signal: tool result says unavailable, assistant says a number.
- **Bookings fail / loop:** `create_booking` erring. → `telnyx-edge logs wadeea-mcp --type invocations` (non-200s / durations), then replay the exact tool call with `curl` against `/mcp`. First signal: `booking_failed` in the tool result — historically this meant the **actor-runtime snapshot bucket is full** (`TooManyObjects`): check object count, run `scripts/janitor.py`.
- **Everything MCP is down:** `/health` on the function answers instantly and touches no dependency, so it separates "function down" (repoint assistant to the fallback engine) from "dependency down" (bucket/SQLDB — janitor first).

### One thing that broke and how we found it (demo-day)

**The story we actually lived:** bookings started failing
mid-test with `booking_failed`; invocation logs showed the tool erring inside a
healthy function; the SQLDB CLI reproduced it as `ShipError … TooManyObjects`;
listing the account's actor-runtime bucket over S3 showed it capped at 5 objects,
full of never-pruned snapshot generations — the same mechanism that had silently
killed actor activations for three days. Fix: an external janitor pruning
superseded generations. Full forensic trail: ADR 0002/0003.

**We lived this story on 2026-09-27:** every deploy of an actor-bearing function
failed with no logs. Isolation probes (stock CLI templates) narrowed it to one broken
hop — actor invocations returning `502: bad gateway` from the platform's actor runtime,
while plain functions served fine. Full timeline, evidence, and the resulting Postgres
fallback: [ADR 0002](docs/adr/0002-actor-outage-postgres-fallback.md).

## Status — LIVE (2026-09-29)

| Component | URL / ID | State |
|---|---|---|
| MCP server (canonical) | https://wadeea-mcp-c722fc30-3.telnyxcompute.com/mcp | live — assistant attached; 6 tools; FleetInventory actor bookings |
| Dynamic-variables webhook | https://wadeea-dynamic-variables-v3-923bbb9e-9.telnyxcompute.com | live — Ed25519 verified; CallSession actor; KV flag |
| Fallback MCP engine | https://wadeea-mcp-server-v3-99a58ff6-c.telnyxcompute.com/mcp | deployed, dormant (failover: repoint the assistant's MCP URL) |
| Observability dashboard | https://wadeea-observe-23449883-5.telnyxcompute.com/?key=… | live — the dashboard is itself an Edge Function (key in `.env` as `DASH_KEY`) |
| SQLDB | `wadeea-db-2` (d6b65834-…) | seeded; booking records live |
| Actors | `FleetInventory` (per category), `CallSession` (per caller) | both live, verified on real calls |

All six MCP tools, the actor state machine (persist / idempotent replay / capacity
refusal), signature verification, and dynamic-variable personalization are verified
on production. Architecture: ADR 0003 (canonical), ADR 0002 (the outage + fallback
era), ADR 0001 (original design).

### Ops runbook (the two things that matter)

1. **The snapshot-bucket janitor.** The account's actor-runtime bucket holds ~5
   objects and the platform never prunes it; every SQLDB write and actor
   activation ships an object. During demos or write activity, prune superseded
   `gen-*` objects (keep fence + newest) every ~2 minutes — otherwise writes fail
   with `TooManyObjects`. One SQL file = one object, so bulk-load via `--file`.
2. **Never redeploy the live actor functions casually.** Actor hosts launch once,
   at provisioning, with no retry (ADR 0003). Batch changes, verify locally
   (typecheck, tests, bare-Node bundle load), ship rarely.


## Working in this repo

Read [AGENTS.md](AGENTS.md) first. Product scope, boundaries, conventions, testing,
observability, and agent instructions live there. Requirements source of truth:
[assignment.md](assignment.md) (do not modify).
