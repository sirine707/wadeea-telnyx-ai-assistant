---
description: Trace the most recent call by telnyx_conversation_id
---

!`telnyx-edge logs wadeea-dynamic-variables-v3 --since 30m 2>&1 | grep assistant.initialization | tail -3`

!`telnyx-edge logs wadeea-mcp --since 30m 2>&1 | grep -E "tool_call|booking_pipeline" | tail -10`

Summarize the most recent call by telnyx_conversation_id: caller flags, each tool call with outcome and latency, and the slowest hop.
