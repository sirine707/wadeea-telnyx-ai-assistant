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

## Current workflow (tested branch)

```
Greeting (speak)
  → Identify Intent (prompt)
       ├── New Booking (prompt)
       │     → Review Booking Request (prompt)
       │           → Request Ready for Availability Check (prompt)
       │                 → [check_availability tool] → availability/quote → confirm → create_booking
       ├── Existing Rental (prompt)   [not started]
       └── Escalate (prompt / handoff) [not started]
```

The tested branch collects vehicle category, start date, duration, and delivery area,
reviews the request back with the caller, and reaches the point where it can call
`check_availability`.

## How to interact

> Phone number and live URLs will be filled in once deployed.

- **Phone:** `+1 ...` (dial to start the workflow)
- **Dynamic-variables webhook:** `https://<func>.telnyxcompute.com/...`
- **MCP server:** `https://<func>.telnyxcompute.com/...` (publicly reachable)

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

## Observability — "broken within a minute"

**What we'd see first, and where we'd look:**

- **Call starts but the assistant is silent / generic (no personalization):** the dynamic-variables webhook timed out or errored. → Portal **per-conversation webhook logs** (request/response + timing) and our Edge function logs filtered to `event=assistant.initialization`. First signal: webhook latency > `dynamic_variables_webhook_timeout_ms` or non-200 in the portal webhook log.
- **Assistant fabricates availability/price:** a tool returned a structured "unavailable"/error and the model hallucinated instead of relaying it. → Telnyx **Conversation History** transcript (shows the workflow node + tool call/result) + our MCP logs for that `telnyx_conversation_id`. First signal: tool result = unavailable but assistant spoke a price.
- **Double-booking / "already booked" for a free car:** FleetInventory reserve race. → our actor logs (`event=reserve`, `latency_ms`, outcome). First signal: two `reserve` successes for the same category in the same window.
- **Booking never finalizes / loops:** the `create_booking` MCP tool errored or returned non-200. → transcript tool-call step + our MCP logs for `create_booking`. First signal: non-200 / error result on `create_booking`.

Beyond logs: a counter (MCP tool error rate) and a latency trace of the request path
Edge Function → KV/Actor → MCP, both keyed by `telnyx_conversation_id`. On demo day we
walk through one real bug found via these signals — evidence, not vibes.

**The story we actually lived (demo-day material):** bookings started failing
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
