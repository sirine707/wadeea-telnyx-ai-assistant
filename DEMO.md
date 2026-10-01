# Demo script (~10 min)

**Setup on screen:** observability dashboard (`https://wadeea-observe-23449883-5.telnyxcompute.com/?key=…`)
on the projector, a terminal beside it. Phone: **+1 (737) 335-1093**.

| # | Time | What we do | What it proves |
|---|---|---|---|
| 1 | 0:00 | One sentence: Wadeea books Dubai car rentals by voice; every price and availability answer comes from a tool, never the model. | Use case |
| 2 | 0:30 | **Call and book:** "I'd like an SUV from October 10 for 3 days, delivered to Dubai Marina." Give name and a UAE number (`050 123 4567`). Accept the quote → hear the verbatim deposit-hold notice → booking confirmed. | Multi-step workflow; MCP tools `check_availability` → `get_quote` → `create_booking`; speak node delivers exact wording |
| 3 | 3:00 | **Dashboard while it lands:** the instant tool-call panel moves within seconds; the call trace shows the node path and `booking_pipeline` (`actor_ms` vs `sqldb_ms`). | Observability surface live; Function → Actor → SQLDB trace |
| 4 | 4:00 | **Call again:** the webhook line on the dashboard shows `call_count` went up by one and `returning_caller=true` (CallSession actor, one instance per caller). | Dynamic variables + actor state (single-threaded read-modify-write) |
| 5 | 5:00 | **Kill switch:** run the *disable* command below, call, ask to book → booking-paused message. Run *enable* to flip back. | KV write → dynamic variable → deterministic expression edge, no redeploy |
| 6 | 6:30 | **Boundary test:** try to book an unknown category ("a Mercedes") and a US phone number. The assistant relays the tool's refusal instead of inventing. | Anti-fabrication: rules live in tools, not prompts |
| 7 | 7:30 | **Handoff:** "Can I talk to a human?" → transfer fails → offer to take a message. | Fallback path; per-node tool scoping |
| 8 | 8:30 | **The bug we found with our own logs:** `kv_ms=0` — a "KV read" that took zero ms never happened (wrong method name; the flag had never been read in production). | Evidence-driven debugging |

**Kill-switch commands (step 5):**
```bash
# disable bookings
telnyx-edge storage kv key put d6bfa576-5a6e-4d5d-a92a-e259f43a7c71 flag/bookings_enabled false

# enable bookings (leave it like this after the demo)
telnyx-edge storage kv key put d6bfa576-5a6e-4d5d-a92a-e259f43a7c71 flag/bookings_enabled true

# check the current value
telnyx-edge storage kv key get d6bfa576-5a6e-4d5d-a92a-e259f43a7c71 flag/bookings_enabled
```

**Walkthrough after the demo (from README):** architecture diagram, why actors vs KV vs plain logic,
LLM edges for intent vs expression edges for system state, and OpenCode + Telnyx inference (`opencode.jsonc`).
