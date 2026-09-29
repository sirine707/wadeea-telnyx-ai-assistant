# ADR 0003 — Canonical architecture: bindings over dependencies

- **Status:** Accepted (implemented, deployed, verified live 2026-09-29)
- **Date:** 2026-09-29
- **Supersedes:** parts of ADR 0001 (Neon, MCP SDK); closes ADR 0002's fallback era

## Context

ADR 0002 documented the Stateful Actor outage and the Postgres fallback. Continued
investigation (see Findings) showed the actor failures were driven by platform
mechanics that punish heavy bundles and unpruned snapshot storage — and that every
Telnyx reference example avoids both by construction: **one self-contained function
per concern, platform bindings instead of npm dependencies, actors co-located with
the code that uses them**. The assignment's own architecture diagram places KV and
the Actor inside the webhook Edge Function and shows the MCP server as its own box.

We rebuilt to that canon.

## Decisions

1. **Two-box architecture (the assignment diagram, literally):**
   - `wadeea-dynamic-variables-v3` — the webhook box: Ed25519 verification via
     `node:crypto` (no `telnyx` SDK), the `bookings_enabled` KV flag, and the
     **CallSession** actor (per-caller `call_count`/`last_intent`, feeding dynamic
     variables). Single dependency: `@telnyx/edge-runtime`.
   - `wadeea-mcp` — the MCP box: all six tools, the **FleetInventory** actor
     in-function (per-category reservations, `get/put`, no constructor), business
     data via the **`[storage.sqldb]` binding** (replacing the Neon driver), and a
     **hand-rolled MCP streamable-http subset** (~140 lines: initialize,
     notifications→202, tools/list, tools/call, SSE framing) replacing
     `@modelcontextprotocol/sdk`. Single dependency: `@telnyx/edge-runtime`.
2. **`wadeea-mcp-server-v3` is retained, deployed, as the rehearsed fallback**
   (Postgres/Neon engine behind the same `ActorClient`/`SqlClient` seams).
   Failover = repoint the assistant's MCP server URL; reservations must then be
   reconciled to the engine taking over (one script; both sides idempotent by
   `booking_id`).
3. **Module scope stays inert in every bundle** (no env reads, no client
   construction, no storage access) — the actor container loads the same bundle
   and dies otherwise. Enforced by a bare-Node load test before every ship.
4. **Actors follow the assignment's 4c example shape exactly**: no constructor,
   `ctx.storage.get<T>() ?? default` → pure decision function → `put`. Pure logic
   lives in `lib/` with unit tests (`reservation_logic`, `session_logic`).

## Findings that forced these decisions (platform behavior, established empirically)

1. **Actor hosts launch once — at provisioning — and are never retried.** A
   registration created while the launcher is unhealthy stays `ready` in the
   registry forever but never gets a host; every invocation returns
   `FailedPrecondition: did not find address`. No re-ship, revision swap, reset,
   or fresh instance id revives it. Remedy: re-provision (fresh function) while
   the launcher is healthy.
2. **The launcher is healthy only intermittently** ("windows"). Controlled pairs:
   identical actors provisioned 16 minutes apart — one lives (CallSession, 11:31),
   one never gets a host (11:47). Windows correlate with the snapshot bucket state
   (below); `deploy_ok` and `ready` prove nothing about hosts.
3. **The account's actor-runtime snapshot bucket
   (`edge-compute-actor-runtime-<account>`, S3-accessible with the API key) holds
   ~5 objects, and the platform never garbage-collects it.** Both actor state
   shipping *and* SQLDB write transactions ship generation objects there. At the
   cap: SQLDB writes fail with `ShipError … TooManyObjects`, and new actor hosts
   cannot write their activation fence — the outage mechanism behind (1)/(2).
4. **Operational requirement — the janitor:** superseded generations must be
   pruned externally (keep fence + newest gen). `scripts` note: prune every ~2
   minutes during write activity. One batch SQL file = one generation, so bulk
   loads should be single-file executions.
5. **Heavy bundles compound the risk** (MCP SDK + Neon ≈ 3.3 MB); every observed
   host launch succeeded only with scaffold-profile bundles. Bindings-first keeps
   every bundle in that profile permanently.
6. `new-func --from-dir` copies `.telnyx/` and a later `ship` **reuses the stale
   bundle silently** — always delete `.telnyx/` before shipping; verify by bundle
   byte-size change.

## Verification (all live, 2026-09-29)

- Actor state machine hand-verified over HTTP: read (2 units) → book → read (1) →
  idempotent replay (`idempotent: true`, still 1) → capacity math across three
  categories matching the pre-migration Postgres ledger to the unit.
- All six tools verified with real payloads, including case normalization
  ("SUV"→"suv") and self-correcting errors (unknown category lists valid ids).
- CallSession verified on a live phone call (`session_outcome: ok`,
  `call_count: 1`, 153 ms webhook latency, Ed25519 signature verified).
- Five production reservations migrated into the actor with original booking ids;
  counts verified against the independent Neon ledger.

## Consequences

- Final platform state: three functions (`wadeea-mcp` live, webhook live,
  `wadeea-mcp-server-v3` fallback), two actors (`FleetInventory`, `CallSession`),
  one SQLDB (`wadeea-db-2`), one KV namespace, two secrets.
- The MCP protocol subset is ours to maintain if MCP evolves (seven tests pin it).
- Any redeploy of an actor-bearing function re-enters the launch lottery —
  ship rarely, batch changes, verify locally first (each ship costs 25–40 min).
