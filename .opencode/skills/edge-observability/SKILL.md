---
name: edge-observability
description: Use when debugging a call or adding instrumentation.
---
## Rules
- One JSON log line per event: telnyx_conversation_id, node, outcome, latency_ms; no PII.
- Time every hop (kv_ms, session_ms, actor_ms, sqldb_ms). 0 ms means the call never happened (the kv.getText bug).
- Logs arrive ~30-90 s late; `GET /stats` on the MCP function is instant.
- Read logs: `telnyx-edge logs <fn> --type runtime|invocations`; exclude /stats and /health from metrics.
- Dashboard: `functions/wadeea-observe` (public, key-gated).
