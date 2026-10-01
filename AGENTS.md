# AGENTS.md — Wadeea

Instructions for AI coding agents working in this repository. Read this before making changes.

## Product

Wadeea is a fictional Dubai-based car-rental voice assistant running on Telnyx. It
answers inbound voice calls, books rentals, and helps existing renters. All data
(vehicles, availability, prices, customers, charges, policies) is fictional and must
come from a real backing store via tools — never from the model's imagination.

## Scope

In:
- New bookings: collect vehicle category, start date, duration, delivery area → check availability → quote → confirm → create booking.
- Existing rentals: rental extension; deposit/charge questions.
- Rental documents and requirements.
- Human handoff when a request cannot be handled.

Out (hard boundary):
- Never invent availability, prices, customer data, charges, or policies. If a tool does not return it, it does not exist. Say so and route to handoff if needed.
- No payments, no PII storage beyond what tools explicitly persist, no outbound marketing.

## Architecture

Telnyx AI Assistant drives the conversation. Our Edge Compute code provides the data
and the atomic operations behind it.

1. **AI Assistant** (Telnyx portal/API): the only thing the caller talks to. Configured with instructions, greeting, attached MCP server, `dynamic_variables_webhook_url`, and a Conversation Workflow (`conversation_flow`). Handoff/Transfer available as tools.
2. **Conversation Workflow** (Telnyx primitive — `conversation_flow`): a directed graph stored on the assistant, built in the Portal **Workflow** tab or via the Assistants API. Not something we host.
   - **Prompt nodes**: LLM-driven steps, each with its own instructions; `instructions_mode` is `append` (keep base rules) or `replace` (standalone prompt). Optional per-node model and voice override.
   - **Speak nodes**: deterministic, verbatim scripted messages with **no model turn** — used for greetings, disclosures, and compliance statements that must be delivered word-for-word. Carry `{{variable}}` placeholders and must have exactly one outgoing **default** edge.
   - **Tool nodes**: deterministic, run a single shared tool with no model turn; route on the reserved `telnyx_last_tool_status_code` system variable (e.g. `== "200"` on voice). A node with no outgoing edges is a valid end step (e.g. hangup).
   - **Edges**: `llm` (natural-language condition), `expression` (variable comparison — deterministic, e.g. `telnyx_conversation_duration_secs >= 300`), or `default` (fallback; required on speak/tool nodes). Edges are evaluated in declared order; the first match wins; `default` is considered last. An edge may also target **another assistant** for specialist routing.
   - Per-node tool scoping: configure all tools on the assistant, then enable only the relevant subset per node so the model has fewer choices and calls the right tool more consistently.
3. **Custom MCP server** (Edge function, streamable-http): exposes tools. Telnyx injects `telnyx_conversation_id` in each call's `_meta`. Initial tools: `check_availability`, `get_quote`, `create_booking`. MCP tools are called from prompt nodes. Whether `create_booking` should later be invoked through a workflow **tool node** is an open question (see ADR).
4. **Dynamic-variables webhook** (Edge function): receives Telnyx's signed `assistant.initialization` event at call start; returns per-caller context (`dynamic_variables`), a memory query, and `conversation.metadata`. Values can influence workflow routing via variable-comparison edges. Must respond within the configured timeout (default 1.5s, up to 10s via `dynamic_variables_webhook_timeout_ms`).
5. **KV** (`@telnyx/edge-runtime` binding / REST): sessions, pricing, rental rules, feature flags, and indexes. Globally distributed, opaque bytes, server-side TTL. KV must not cache vehicle availability.
6. **FleetInventory Actor** (`@telnyx/edge-runtime` Stateful Actor): single-threaded, one instance per name, durable-before-reply → atomic read-modify-write with no locks. Owns authoritative availability and atomic reservation; `create_booking` does atomic check-and-reserve to prevent double-booking.
7. **Deploy**: `telnyx-edge ship`. Edge Functions (webhook + MCP server) deploy publicly; MCP server must be publicly reachable by the assistant.

Data flow: call → assistant → (start) dynamic-variables webhook returns caller context →
workflow starts at its start node → prompt nodes collect slots and call MCP tools →
tools read KV / call the FleetInventory actor → result returned to assistant → assistant
speaks to caller → edges route to the next node.

## Repository layout

```
/functions/wadeea-dynamic-variables-v3/  webhook box (LIVE): src/{actors,shared}: Ed25519, UAE phone, KV flag, CallSession actor
/functions/mcp/wadeea-mcp/               MCP box (LIVE): src/{actors,mcp,storage,shared,observability}: 6 tools, FleetInventory actor, SQLDB
/functions/wadeea-observe/               observability dashboard as an Edge Function (LIVE): Telnyx logs REST API + MCP /stats, key-gated
/lib/                                    shared tested modules (protocol, clients, pure actor logic, fakes)
/test/                                   Vitest suites (root) — function-local suites live beside their function
/sql/                                    sqldb_schema_seed.sql — schema + seed for Telnyx SQLDB (wadeea-db-2)
/docs/adr/                               architecture decision records (0001–0003)
opencode.jsonc                           OpenCode config with @telnyx/opencode plugin active
```

Both live functions are single-dependency (`@telnyx/edge-runtime`) umbrella
projects; module scope must stay inert (bare-Node load test before any ship).

Each Edge Function has its own `func.toml` (classic manifest with `[edge_compute]` identity, written by `telnyx-edge new-func`). The FleetInventory Actor uses a `telnyx.toml` umbrella project (TypeScript only, esbuild-bundled, `[[actors]]` block). There is no root-level `func.toml`. — https://developers.telnyx.com/docs/edge-compute/configuration

## Conventions

- Language: TypeScript, `strict`. Runtime: Telnyx Edge Compute (`@telnyx/edge-runtime`). Shared SQL via the Telnyx SQLDB binding (`[storage.sqldb]`, zero client deps). No externally-managed servers beyond Edge functions.
- MCP: hand-rolled streamable-http subset (`lib/mcp_protocol.ts`, ADR 0003) — no SDK, to keep bundles single-dependency for actor hosts. Tool names are snake_case; one tool = one business action.
- Workflow nodes: name them descriptively (names appear in transcripts). Prefer `append` mode to keep base safety/brand rules; use `replace` only for tightly-scoped steps. Scope tools per node — leave enabled only what that step needs.
- Speak nodes for anything that must be delivered verbatim (greetings, the Dubai rental disclosure, compliance statements). Never use a prompt node where exact wording is required.
- Use **variable-comparison** edges for deterministic routing (account state, auth flags, `telnyx_last_tool_status_code`, elapsed time) and **LLM** edges for intent/sentiment/completeness. Declare edges in priority order.
- Secrets: never in code or logs. Use Telnyx Integration Secrets / Edge secrets. Per-caller credentials go through `encrypted_dynamic_variables`, never plain `dynamic_variables`.
- Logging: structured JSON, one line per event. Every line carries `telnyx_conversation_id`, `call_control_id` (if available), `event`, the active workflow `node`, plus action-specific fields. No PII.
- Naming: dynamic variables and tool args are snake_case; do not use the reserved `telnyx_` prefix for our variables.
- Verify Telnyx behavior against docs before relying on it: https://developers.telnyx.com/llms.txt (index) or append `.md` to a doc URL for clean markdown. Do not guess Telnyx semantics — record uncertainty as an open question in the ADR.

## Development tooling

- Build with **Telnyx Inference via the OpenCode plugin** (`@telnyx/opencode`) using Telnyx-hosted LLMs — this dogfoods Telnyx's own inference product. Authenticate with `opencode auth login --provider telnyx --method "API Key"`; pick a model via the `/telnyx` TUI command.
- Commit `opencode.jsonc` (or `opencode.json`) showing the Telnyx plugin active; it is part of the submission.

## Testing

- Framework: Vitest. Unit-test tools and the actor against fakes of KV/actor storage; integration-test the MCP server end-to-end with an in-memory store.
- Every MCP tool has tests for: happy path, "not available" (tool returns structured unavailable; model must not fabricate), and arg validation.
- The FleetInventory actor's reserve must be tested for atomicity (concurrent reserve calls → exactly N successes).
- No live Telnyx calls in CI. Conversation-flow assertions use recorded fixtures, not real calls.
- Test every workflow path: happy path, fallback path, escalation path, and at least one negative case per important node.
- Run before considering work done: `npm run typecheck` (`tsc --noEmit`), `npm run lint`, `npm test`.

## Observability

- Application logs (Edge functions) + Telnyx Conversation History, Insights, and per-conversation webhook logs (portal). Correlate via `telnyx_conversation_id`; workflow node context appears in transcripts.
- The MCP function logs one structured `tool_call` line per tool invocation (tool, ok, `latency_ms`, `telnyx_conversation_id`; never args/PII) and serves `GET /stats`: in-memory per-instance counters + last 50 calls — the instant signal (no log-ingestion delay).
- `/observability` — local judge-facing dashboard (`npm run observe`): tails both live functions, polls `/stats`, renders metrics/alerts/traces. Read-only against the platform.
- At least one signal beyond logs: a counter or a latency trace of a request's path through Function → KV/Actor → MCP.
- Alert on: dynamic-variables webhook timeouts, MCP tool error rate, FleetInventory reserve failures.
- README documents the "broken within a minute" story: what we'd see first and where we'd look.

## Agent instructions (for AI agents editing this repo)

- Do not implement application code unless asked.
- `assignment.md` (local, untracked) is the source of truth for requirements; do not modify it. Align these docs to it.
- Keep AGENTS.md, README.md, and docs/adr/ in sync with any architecture change. New decision → new ADR; update README status.
- Never invent Telnyx behavior. Cite the doc URL or mark it an open question in docs/adr/0001-architecture.md.
- Never invent product data. Tools own all data; the assistant only relays tool results.
- When adding an MCP tool: list it here (scope), add a test, update the ADR if it changes state ownership, and document the workflow node that calls it.
- Keep docs concise and operational. No boilerplate.

## Current status

- **LIVE (2026-09-29):** canonical two-box architecture (ADR 0003) — `wadeea-mcp` (6 tools, FleetInventory actor, SQLDB) and `wadeea-dynamic-variables-v3` (Ed25519, KV flag, CallSession actor), both verified on real phone calls; 5 production reservations migrated into the actor and count-verified.
- **Instrumentation ship (2026-09-29, verified):** `wadeea-mcp` re-shipped with `GET /stats` + per-tool-call structured logging; actor survived the redeploy (`check_availability` returned real data post-ship). Observability dashboard added under `/observability`.
- Remaining: portal polish (farewell speak node → end_call, Existing Rental branch), README demo package, git commit.


## MCP tools

| Tool | Branch | Reads | Writes |
|---|---|---|---|
| `check_availability` | New Booking | SQL (total_units) + Actor (reservations) | — |
| `get_quote` | New Booking | SQL (pricing) | — |
| `create_booking` | New Booking | SQL (pricing, total_units) | Actor (reserve) + SQL (booking record) |
| `get_document_requirements` | Documents | SQL (document_requirements) | — |
| `get_rental_rules` | Documents | SQL (rental_rules) | — |
| `lookup_booking` | Existing Rental | SQL (bookings) | — |

## Storage ownership

| Data | Source of truth | Store | Notes |
|---|---|---|---|
| Vehicle categories, pricing, rules, documents | Telnyx SQLDB `wadeea-db-2` | shared, read-mostly (5-min in-function cache) | seeded via `telnyx-edge storage sqldb execute --file sql/sqldb_schema_seed.sql` |
| **Reservations (date ranges)** | **FleetInventory actor** (`ctx.storage`, per category) | authoritative | atomic check-and-reserve; blueprint get/put shape |
| Booking/rental records | Telnyx SQLDB `wadeea-db-2` | shared lookup | never used for availability |
| Caller sessions (`call_count`, `last_intent`) | CallSession actor (per caller) | webhook-owned | feeds dynamic variables |
| Feature flag `flag/bookings_enabled` | KV `wadeea-config` | toggle | read by the webhook per call |

**Never calculate availability from booking records.** Availability comes from the FleetInventory actor.

**Ops invariant (ADR 0003):** the account snapshot bucket holds ~5 objects and is never GC'd by the platform — run the janitor (prune superseded `gen-*` objects) during any write activity, or SQLDB writes and actor activations fail with `TooManyObjects`.
