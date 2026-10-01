---
name: telnyx-workflow-design
description: Use when editing the assistant's Conversation Workflow in the portal.
---
## Rules
- LLM edges for intent; expression edges for system state (e.g. `bookings_enabled`); default edge last. First match wins.
- Speak nodes for verbatim wording; one default edge; cannot branch.
- Prompt nodes speak before edges are evaluated; gate nodes say one short line.
- Scope tools per node: a node with hangup that is told to hang up ends the call before its edges fire.
- Greeting is verbatim: `{{variables}}` work, if/else does not.
- Re-open after saving; the portal can drop edges. Node per message: `metadata.flow_node_id`.
