---
name: mcp-tool-authoring
description: Use when adding or changing an MCP tool in functions/mcp/wadeea-mcp.
---
## Rules
- One tool = one business action; snake_case; JSON Schema in the TOOLS registry (`src/index.ts`).
- Implement in `lib/mcp_tools.ts`, mirror to `src/mcp/mcp_tools.ts`.
- Tools own data and rules (e.g. UAE phone check in `create_booking`). Never invent data; return structured errors (`{ok:false, reason}`).
- Logs go through `tool_io.ts` whitelists; never log customer_name, customer_phone, delivery_area.
- Tests: happy path, refusal/unavailable, argument validation. Update the AGENTS.md tool table.
