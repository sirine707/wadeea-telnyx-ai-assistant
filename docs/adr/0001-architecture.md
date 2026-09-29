# ADR 0001 — Architecture

- **Status:** Proposed
- **Date:** 2026-09-25
- **Supersedes:** —

## Context

Wadeea is a fictional Dubai car-rental voice assistant on Telnyx. It must book rentals,
help existing renters (extensions, deposits/charges), answer document/requirement
questions, and hand off to a human when stuck — without ever fabricating data.

Telnyx provides the building blocks: AI Assistants (portal-configured, with a
Conversation Workflow, dynamic variables, MCP server attachment, and Handoff/Transfer
tools), Edge Compute (functions, KV, Stateful Actors), and MCP integration that injects
`telnyx_conversation_id` into each tool call. Conversation Workflows are a Telnyx primitive
(`conversation_flow`) — a directed graph of prompt/speak/tool nodes with LLM, variable,
and default edges — documented at
https://developers.telnyx.com/docs/inference/ai-assistants/workflows.

## Decisions

1. **TypeScript end-to-end, `strict`.** Runtime: Telnyx Edge Compute. Ship with `telnyx-edge ship`.
2. **AI Assistant = conversation driver.** It owns instructions, greeting, tool attachment, the `conversation_flow` workflow, dynamic-variables webhook, and handoff/transfer. It is the only thing the caller hears. We configure it in the Telnyx portal/API; no custom voice server. Must be reachable via a phone number.
3. **Conversation Workflow = Telnyx `conversation_flow` graph**, authored in the Portal Workflow tab or via the Assistants API. Not something we host.
   - **Speak node** for the greeting and a Dubai rental compliance disclosure delivered verbatim (no model turn). Speak nodes carry `{{variable}}` placeholders and require exactly one outgoing `default` edge.
   - **Prompt nodes** for LLM-driven steps (intent detection, collecting slots, reviewing the request). `instructions_mode` = `append` by default to preserve base safety/brand rules; `replace` only for tightly-scoped steps.
   - **Edges**: `llm` conditions for intent/completeness routing; `expression` (variable comparison) for deterministic routing (account flags, `telnyx_last_tool_status_code`, `telnyx_conversation_duration_secs >= 300` escalation); `default` fallback on speak/tool nodes. Edges declared in priority order; first match wins; `default` considered last. An edge may target another assistant for specialist routing.
   - **Per-node tool scoping**: all tools configured on the assistant, then only the relevant subset enabled per node so the model calls the right tool more consistently.
4. **Data and actions behind a custom MCP server** (Edge function, streamable-http). Telnyx injects `telnyx_conversation_id` into each call's `_meta`. Initial tools: `check_availability`, `get_quote`, `create_booking`. `create_booking` is an MCP tool called from a prompt node; whether it should later be invoked through a workflow **tool node** is an open question (Q2). The assistant relays tool results verbatim; it never invents data.
5. **Per-caller context via a dynamic-variables webhook** (Edge function). It receives Telnyx's signed `assistant.initialization` event at call start and returns `dynamic_variables` + `memory` + `conversation.metadata`. Returned values can influence workflow routing via variable-comparison edges. Kept under the webhook timeout.
6. **KV for sessions, pricing, rental rules, feature flags, and indexes.** Opaque bytes, server-side TTL. KV must not cache vehicle availability.
7. **FleetInventory Actor for atomic read-modify-write.** The FleetInventory Actor owns authoritative availability and atomic reservation; `create_booking` does atomic check-and-reserve so two concurrent callers cannot book the last car. Chosen over a KV check-then-write because KV has no atomic compare-and-swap for this pattern and is eventually consistent.
8. **Human handoff via the assistant's Handoff/Transfer tools** when a request is out of scope or a tool cannot satisfy it. A workflow edge to another (specialist) assistant is also available as a routing option.
9. **Observability = structured JSON logs from Edge functions** (keyed by `telnyx_conversation_id`, tagged with the active workflow `node`) plus Telnyx Conversation History, Insights, and per-conversation webhook logs. At least one metric/trace beyond logs (request path Function → KV/Actor → MCP). README documents the "broken within a minute" story.
10. **Development via Telnyx Inference through the OpenCode plugin** (`@telnyx/opencode`), dogfooding Telnyx-hosted LLMs. `opencode.jsonc` committed as part of the submission.
11. **Neon Postgres (`DATABASE_URL`)** for shared business data: vehicle categories, pricing, rental rules, document requirements, and booking/rental records. Accessed via `@neondatabase/serverless` from Edge functions. Read-mostly, operator-seeded via `psql`. Booking records exist for Existing Rental lookup — never for availability calculation. Chosen over Telnyx SQLDB (SQLite) for Postgres feature set and independent accessibility outside Edge Compute. — https://developers.telnyx.com/docs/edge-compute/sqldb (comparison), https://neon.tech/docs/serverless/serverless-driver
12. **FleetInventory Actor** (one instance per category, `idFromName(category_id)`) owns authoritative date-range reservations in `ctx.storage.sql`. Availability = overlapping reservations vs `total_units` (read from Neon Postgres). `reserve` is atomic (single-threaded actor), `release` is idempotent. — https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/storage/sql
13. **`create_booking` consistency**: reserve in actor → Neon Postgres insert → compensating release on SQL failure. Idempotency via `booking_id` as the operation key: actor returns `{ ok, idempotent: true }` if `booking_id` already exists; Neon uses `ON CONFLICT (booking_id) DO NOTHING`. Retries with the same `booking_id` cannot create a second reservation or booking record.

## Consequences

- **Positive:** Race-free booking via the FleetInventory actor; caller-facing behavior in one configurable assistant with a deterministic workflow graph; verbatim compliance via speak nodes; tools are independently testable; the "never invent" boundary is enforced because all data is tool-backed.
- **Negative:** Two Edge functions to build/deploy (webhook + MCP); the dynamic-variables webhook has a tight latency budget (≤1.5s default); Stateful Actors and the MCP server are relatively new Telnyx surfaces with open questions below.

## Open Telnyx-specific questions

1. **Workflow + conversation state.** Variable comparison edges can use custom dynamic variables defined on the assistant (verified — https://developers.telnyx.com/docs/inference/ai-assistants/workflows). Conversation transcripts show workflow node context (verified — same). Open: whether `conversation.metadata` set via the webhook persists across turns for routing, or only `dynamic_variables` are reliable for variable-comparison edges — https://developers.telnyx.com/docs/inference/ai-assistants/memory.
2. **create_booking as a workflow tool node (open).** `create_booking` is currently an MCP tool called from a prompt node. Whether it should later be invoked through a workflow **tool node** (deterministic, routes on `telnyx_last_tool_status_code`) is open. Tool nodes reference a *shared* (org-level) tool by `shared_tool_id`; confirm an MCP tool can be registered as such, or whether tool nodes only support webhook/built-in tools. Verify — https://developers.telnyx.com/docs/inference/ai-assistants/workflows (Tool nodes), /docs/inference/ai-assistants/tools-library.
3. **MCP server hosting & auth.** Deploy the MCP server as an Edge function (streamable-http) vs. a standalone host. What auth does Telnyx expect on a custom MCP URL, and should the URL be stored as an Integration Secret? Verify — https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant (MCP section), /docs/inference/ai-assistants/per-caller-credentials.
4. **Dynamic-variables webhook (resolved).** `assistant.initialization` payload: `data.payload` contains `call_control_id`, `assistant_id`, `telnyx_end_user_target` (caller number), `telnyx_end_user_target_verified`, `telnyx_conversation_channel`, `telnyx_agent_target`. `telnyx_conversation_id` is documented as sent in the payload but not shown in examples — read from `data.payload.telnyx_conversation_id` (https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant). Ed25519 signing: headers `telnyx-signature-ed25519` + `telnyx-timestamp`, public key from portal as `TELNYX_PUBLIC_KEY`, raw body required, Node SDK `client.webhooks.unwrap(rawBody, { headers })` throws on invalid (https://developers.telnyx.com/docs/development/sdk/node/webhooks). Timeout default 1.5s, up to 10s via `dynamic_variables_webhook_timeout_ms`; on timeout/non-2xx/malformed JSON Telnyx falls back to defaults then unset `{{var}}`.
5. **Stateful Actors (Beta) limits (resolved).** Actor storage (`ctx.storage`) is durable across calls, restarts, evictions, and deployments — guarantee 3 ("writes are durable before the caller sees a result") and guarantee 4 ("only persisted state survives; memory is a cache"). Actor SQL (`ctx.storage.sql`) is durable at turn granularity. 1 GB limit per actor database. The FleetInventory Actor uses `ctx.storage.sql` as the authoritative store for reservations (https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/execution-model, /docs/edge-compute/stateful-actors/guides/storage/sql).
6. **KV consistency.** Confirm read-your-writes / cross-region propagation for the values KV does hold (sessions, pricing, rules, flags, indexes); set TTLs to bound staleness so the FleetInventory actor remains the authority for availability — https://developers.telnyx.com/docs/edge-compute/kv.
7. **Human handoff mechanism.** Three options now: Handoff (assistant-to-assistant, shared context), Transfer (to a named phone/SIP target), or a workflow edge to another assistant. Decide which models "route to a human agent" and how the human target list is configured — https://developers.telnyx.com/docs/inference/ai-assistants/agent-handoff.
8. **Voice model.** Confirm the chosen model (e.g. `zai-org/GLM-5.2`) is on the voice-verified list, and confirm tool-calling reliability given reasoning is always disabled on voice calls — https://developers.telnyx.com/docs/voice/conversational-ai/quickstart.
9. **Per-caller secrets (resolved).** `encrypted_dynamic_variables` is the correct channel for per-caller MCP/tool credentials — AES-256-GCM, nonce-prefixed, base64url; plain `dynamic_variables` are never usable as credentials. MCP servers that fail credential resolution are excluded from the conversation (https://developers.telnyx.com/docs/inference/ai-assistants/per-caller-credentials).
