---
name: telnyx-actor-pattern
description: Use when adding or changing a Stateful Actor (FleetInventory, CallSession).
---
## Rules
- `extends StatefulActor`, no constructor; `this.ctx.storage.get` then `put`.
- Decision logic lives in a pure module (`reservation_logic.ts`, `session_logic.ts`): state + input -> new state + result.
- One instance per entity via `env.BINDING.idFromName(id)`; single-threaded, so read-modify-write needs no lock.
- Test the pure logic directly, and atomicity with concurrent calls (N units -> exactly N successes).
- Callers fence actor calls with a timeout (webhook: 1200 ms) and degrade gracefully.
