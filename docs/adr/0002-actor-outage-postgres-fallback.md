# ADR 0002 — Actor-runtime outage and Postgres reservation fallback

- **Status:** Accepted
- **Date:** 2026-09-27
- **Supersedes:** — (amends ADR 0001 decision "Reservations live in the FleetInventory Actor")

## Context

On 2026-09-27 the Telnyx Stateful Actor invocation layer became unusable on our account,
while plain Edge Functions kept working. Evidence gathered the same day:

- `wadeea-mcp-server` deployed and served successfully on 2026-09-26 19:41 (actor
  `FleetInventory` provisioned and answered). Byte-identical actor code failed every
  deploy from 2026-09-27 08:46 onward.
- Isolation probes (stock `telnyx-edge new-func` templates, unmodified):
  - Plain function (`debug-probe`, `29b4794c-d28b-48a6-ae31-a18ee782ea3f`): deploys,
    serves HTTP 200.
  - Actor function (`debug-actor-probe`, `9c5fbee6-4346-4055-9e6d-72e904af6278`): deploys,
    function serves, actor type reaches `ready`, but every actor invocation fails —
    `actor invocation …ProbeCounter/demo.increment returned 502: bad gateway`
    (live at https://debug-actor-probe-9c5fbee6-4.telnyxcompute.com/).
- Failed actor functions wedge permanently: `reset-func` reverts to `deploy_failed`,
  `delete-func` lands in `delete_failed`, `actors delete` refuses while the binding
  exists — circular, no CLI exit. Reported to Telnyx.
- Separately, `wadeea-dynamic-variables` (`4374037b-49bf-400c-8862-c60711869e2d`) has 10
  consecutive build failures since 2026-09-25, each with `failure_stage: platform`
  ("temporary problem on our side, not your code").

The submission requires a deployed, callable assistant. Blocking on Telnyx support is
not acceptable; dropping the actor is not either (assignment §4c requires one).

## Decision

1. **Keep the FleetInventory actor** as the designed reservation owner: code, tests, and
   the 2026-09-26 successful deploy stand as evidence of requirement 4c. Re-enable when
   the platform heals.
2. **Add a Postgres fallback** behind the existing `ActorClient` interface:
   `SqlReservationClient` + `NeonReservationDb` (`lib/sql_reservation_client.ts`).
   Atomicity is delegated to Postgres in a single transaction:
   `pg_advisory_xact_lock(hashtext(category_id))` — the SQL analogue of the actor's
   per-instance single-threading — followed by a conditional `INSERT … WHERE
   count(overlapping) < total_units`. No check-then-act in JS. Table:
   `sql_reservations` (see `sql/schema.sql`), distinct from `bookings` records.
3. **Backend selection = presence of the actor binding.** `env.FLEET` exists only when
   `telnyx.toml` declares `[[actors]]`; when absent, the MCP server constructs the SQL
   fallback. Re-enabling the actor is a manifest change + re-ship, no code edit.
   The `bookings` table remains non-authoritative for availability in both modes.
4. **Ship the fallback configuration** (no `[[actors]]` block) on a fresh function while
   the outage lasts — fresh plain functions deploy and serve (probe evidence above).

## Consequences

- The "never calculate availability from SQL bookings" rule in AGENTS.md is preserved:
  availability is computed from `sql_reservations` (authoritative in fallback mode),
  never from `bookings`.
- Two reservation stores exist in the codebase but never simultaneously as source of
  truth. Cutover back to the actor requires migrating any `sql_reservations` rows into
  the actor's storage (manual step, documented here as the revert cost).
- The MCP tool contracts (`check_availability`, `create_booking`, …) are unchanged;
  tools are unaware of the backend.

## Open questions

- Whether a failed actor registration (`FleetInventoryV2`) can be cleared without
  Telnyx intervention — currently circular (function ↔ binding). Tracked with support.
- Why `wadeea-dynamic-variables` fails platform-side builds; recreate on a fresh
  function ID (plain functions deploy fine).

## Closure (2026-09-29)

Root causes fully established and the fallback era ended: see ADR 0003. The
"platform actor outage" decomposed into (a) a ~5-object, never-GC'd snapshot
bucket that blocks both actor activation fences and SQLDB writes when full, and
(b) one-shot actor-host launches with no retry, making provisioning-time bucket
state decisive. The Postgres fallback carried production bookings throughout and
is retained, deployed, as the documented failover (`wadeea-mcp-server-v3`). The
FleetInventory actor now runs live in the canonical `wadeea-mcp` function; all
fallback-era reservations were migrated in with original booking ids and
verified against this ledger.
