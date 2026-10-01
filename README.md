# Wadeea

A fictional Dubai car-rental voice assistant built on Telnyx. Inbound callers book
rentals, manage existing rentals, hear rental requirements, and get handed to a human
when the assistant can't help. All vehicle, price, and customer data is fictional and
tool-backed — the assistant never invents it.

## Architecture

Telnyx AI Assistant drives the call; Telnyx Edge Compute provides the data and the
atomic operations behind it.

```
┌───────────────┐
│ Caller (phone)│
└───────┬───────┘
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Telnyx AI Assistant — Conversation Workflow (conversation_flow)        │
│                                                                        │
│  Greeting & Identify Intent (prompt, LLM edges)                        │
│   ├─ booking_gate ──[expr: bookings_enabled == false]─ bookings_paused │
│   │      └─(default)→ New Booking → Review → Check Availability        │
│   │              → Get Quote → Present Quote → Deposit Disclosure      │
│   │                (speak, verbatim) → Create Booking                  │
│   ├─ Rental Disclosure (speak) → Documents & Requirements              │
│   ├─ Existing Rental (lookup_booking)                                  │
│   └─ Human Handoff (transfer, tool-scoped: no hangup)                  │
│          └─[transfer failed + caller agrees]→ Take Message             │
└──────┬─────────────────────────┬───────────────────────────────────────┘
       │ dynamic vars webhook    │ MCP tools (streamable-http)
       ▼                         ▼
┌─────────────────────┐   ┌─────────────────────────────┐
│ Edge Fn: webhook    │   │ Edge Fn: MCP server         │
│ (dynamic-variables) │   │ (wadeea-mcp, 7 tools,       │
│  Ed25519 verify     │   │  hand-rolled protocol)      │
│ ┌─────┐ ┌─────────┐ │   │ ┌──────────────┐ ┌───────┐  │
│ │ KV  │ │CallSess │ │   │ │FleetInventory│ │ SQLDB │  │
│ │flag │ │ actor   │ │   │ │actor: atomic │ │records│  │
│ └─────┘ └─────────┘ │   │ │reserve/rebook│ │pricing│  │
└─────────────────────┘   │ └──────────────┘ └───────┘  │
                          └─────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ Edge Fn: observe — public dashboard (logs / metrics /      │
│ per-call node traces = "your evidence"); reads the Telnyx  │
│ logs REST API, MCP /stats, and the conversations API       │
└────────────────────────────────────────────────────────────┘
```

- **AI Assistant (Telnyx)** — conversation driver: instructions, greeting, `conversation_flow` (prompt/speak nodes + LLM/expression/default edges), attached MCP server, dynamic-variables webhook, Transfer/hangup tools (scoped per node). Callable via phone number.
- **Conversation Workflow** — LLM edges decide *intent*; the expression edge on `booking_gate` decides *system state* (`bookings_enabled` from KV); speak nodes deliver verbatim wording (greeting disclosure, deposit hold notice, paused message).
- **Custom MCP server** (Edge function) — 7 tools: `check_availability`, `get_quote`, `create_booking` (UAE-phone enforcement + normalization), `cancel_booking` (removes the record, then frees the car), `get_document_requirements`, `get_rental_rules`, `lookup_booking`. Telnyx injects `telnyx_conversation_id` per call; every tool call is logged (args/result whitelists, no PII) and counted on `GET /stats`.
- **Dynamic-variables webhook** (Edge function) — Ed25519-verified; returns 12 per-caller variables (`call_count`, `returning_caller`, `caller_number`, `is_uae_caller`, `bookings_enabled`, …) that personalize the greeting and drive expression-edge routing. Per-hop timings (`kv_ms`, `session_ms`) logged each call.
- **KV** — the `flag/bookings_enabled` kill switch: one CLI write flips the booking path with no redeploy.
- **Actors** — `FleetInventory` (per category): atomic check-and-reserve, prevents double-booking; `CallSession` (per caller): returning-caller memory.
- **Observability** (Edge function) — the dashboard is itself deployed on Telnyx Edge; live metrics, alerts with runbook hints, log stream, and per-call node-execution traces.
- **Deploy** — `telnyx-edge ship`; every function runs as autoscaled instances behind the platform's load balancer.

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

- **Phone:** **+1 (737) 335-1093** — dial to talk to Wadeea (starts the workflow)
- **Dynamic-variables webhook:** https://wadeea-dynamic-variables-v3-923bbb9e-9.telnyxcompute.com
- **MCP server:** https://wadeea-mcp-c722fc30-3.telnyxcompute.com/mcp (publicly reachable; `/health` for liveness)

### Try it — test scenarios

Call **+1 (737) 335-1093**. Fleet: SUV (3 cars), Sedan (5), Luxury (2), Economy (4).
Any UAE-format number works as a contact number, e.g. `050 123 4567`.

| # | Say | Expected |
|---|---|---|
| 1 | "I'd like to rent an SUV from October 10 for 3 days, delivered to Dubai Marina." Then give a name and `050 123 4567`, and accept the quote. | Availability check → quote (AED 250/day) → verbatim deposit-hold notice → booking confirmed with a booking ID |
| 2 | "Can you look up booking ‹ID from #1›?" | Reads back the booking (car, dates) |
| 3 | "Please cancel booking ‹ID›." | Confirms with you, cancels; the car is free again |
| 4 | Book **Luxury** for the same dates three times (on separate calls) | First two succeed, the third is told it's unavailable — no double-booking |
| 5 | "I want to rent a Mercedes." | Offers the real categories instead of inventing a car |
| 6 | Give a US number (`+1 415 555 2671`) as the contact number | Refuses; asks for a UAE number (enforced by the tool, not the prompt) |
| 7 | "What documents do I need as a tourist?" | Passport, international driving permit, credit card |
| 8 | "How much is the deposit? What's the minimum age?" | AED 1,500; 21 |
| 9 | "I want my deposit back." / "Can I talk to a human?" | Hands off to a human; if the transfer fails, offers to take a message |

Operator test (needs CLI access): set `flag/bookings_enabled` to `false` in KV, call and ask to
book → the booking-paused message, no redeploy. Commands in [DEMO.md](DEMO.md).

Everything above is visible live on the observability dashboard (URL in "Status" below).

## Setup

```bash
# 1. Telnyx Inference via OpenCode (the AI coding harness — see opencode.jsonc)
opencode plugin @telnyx/opencode
opencode auth login --provider telnyx --method "API Key"
# pick a model via the /telnyx TUI command

# 2. Local checks
npm install
npm run typecheck   # tsc --noEmit
npm test            # Vitest

# 3. Data: SQLDB schema + seed, KV feature flag
telnyx-edge storage sqldb execute <sqldb-id> --file sql/sqldb_schema_seed.sql --remote
telnyx-edge storage kv key put <kv-namespace-id> flag/bookings_enabled true

# 4. Secrets
telnyx-edge secrets add TELNYX_PUBLIC_KEY <org-public-key>   # webhook signature verification
telnyx-edge secrets add TELNYX_API_KEY <api-key>             # dashboard reads the logs API
telnyx-edge secrets add DASH_KEY <random-key>                # dashboard access key

# 5. Deploy (bindings live in each function's telnyx.toml / func.toml)
cd functions/mcp/wadeea-mcp && rm -rf .telnyx && telnyx-edge ship
cd ../../wadeea-dynamic-variables-v3 && rm -rf .telnyx && telnyx-edge ship
cd ../wadeea-observe && rm -rf .telnyx && telnyx-edge ship

# 6. While writing to SQLDB or actors: keep the snapshot-bucket janitor running
python3 scripts/janitor.py --loop   # needs TELNYX_API_KEY
```

Then, in the Telnyx portal, point the assistant at the MCP URL (`…/mcp`) and set the
dynamic-variables webhook URL (both under "Status" below).

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
- **Everything MCP is down:** `/health` on the function answers instantly and touches no dependency, so it separates "function down" from "dependency down" (bucket/SQLDB — janitor first).

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
| MCP server (canonical) | https://wadeea-mcp-c722fc30-3.telnyxcompute.com/mcp | live — assistant attached; 7 tools; FleetInventory actor bookings |
| Dynamic-variables webhook | https://wadeea-dynamic-variables-v3-923bbb9e-9.telnyxcompute.com | live — Ed25519 verified; CallSession actor; KV flag |
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


## Development harness — OpenCode on Telnyx Inference

Built with OpenCode using Telnyx-hosted models through the `@telnyx/opencode` plugin.

| Piece | Where | Role |
|---|---|---|
| Config | `opencode.jsonc` | Telnyx plugin; main model `telnyx/zai-org/GLM-5.2`; `small_model` MiniMax-M3 for session titles; auto-compaction with pruning off (keeps the cached prefix stable); shell commands require approval |
| Rules | `AGENTS.md` | Loaded into every session: scope, "never invent Telnyx behavior", tools own all data, no PII in logs, typecheck + tests before done |
| Commands | `.opencode/commands/` | `/verify`, `/tdd`, `/preship`, `/trace`, `/flag` |
| Skills | `.opencode/skills/` | Deploy, actor pattern, MCP tool authoring, workflow design, observability — lessons from this build, loaded on demand |

**Workflow:** failing tests written first as the spec → scoped prompt naming exact files → model implements to green → diff reviewed before any deploy.

### Session metrics (the Wadeea project session, 25 Sep – 1 Oct 2026)

| Metric | Value |
|---|---|
| Model | `telnyx/zai-org/GLM-5.2` (thinking variant) |
| Prompts / model steps | 44 / 382 |
| Tool calls | 420 — bash 160 (tests, typechecks, CLI), edit 74, read 71, write 57, webfetch 33 (Telnyx docs), todowrite 13, glob 7, grep 3 |
| File changes | 120 |
| Input tokens | 7.6 M full price + **64.4 M from cache (89%)** |
| Output tokens | 104 K |

Caching is automatic prefix caching on Telnyx-hosted GLM. A direct test sending the same
~3,084-token prompt twice returned `cached_tokens: 0`, then `3072` on the second call
(GLM-5.2 and GLM-5.1-FP8).

**Sources**
- Session metrics: OpenCode's local database `~/.local/share/opencode/opencode.db` (read-only) —
  `session` table (`model`, `tokens_input`, `tokens_output`, `tokens_cache_read`), `message` table
  (roles) and `part` table (tool calls, patches) for that session. OpenCode's `cost` field reads 0
  because it doesn't know Telnyx prices; real spend is in the
  [Telnyx Inference dashboard](https://portal.telnyx.com/#/ai/reports/dashboard?product=inference)
  and `GET /v2/spend_limits`.
- Cache test: `POST https://api.telnyx.com/v2/ai/chat/completions`, field
  `usage.prompt_tokens_details.cached_tokens`.
- OpenCode docs: [config](https://opencode.ai/docs/config/), [rules / AGENTS.md](https://opencode.ai/docs/rules/),
  [commands](https://opencode.ai/docs/commands/), [skills](https://opencode.ai/docs/skills/),
  [agents](https://opencode.ai/docs/agents/).
- Telnyx docs: [spending limits](https://developers.telnyx.com/docs/inference/spending-limits),
  [inference pricing](https://developers.telnyx.com/docs/inference/models/pricing).

## Working in this repo

Read [AGENTS.md](AGENTS.md) first. Product scope, boundaries, conventions, testing,
observability, and agent instructions live there.
