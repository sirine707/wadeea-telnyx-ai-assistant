// Hand-rolled MCP streamable-http subset (replaces @modelcontextprotocol/sdk
// to keep the bundle single-dependency — ADR 0002/0003). Covers exactly what
// the Telnyx AI Assistant integration uses: initialize, notifications,
// tools/list, tools/call — stateless, one response per POST, SSE-framed.

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export type McpOutcome =
  | { kind: "response"; body: JsonRpcResponse }
  | { kind: "accepted" } // notification → HTTP 202, empty body
  | { kind: "bad_request"; message: string };

const PROTOCOL_VERSION = "2025-03-26";

export async function handleMcpRequest(raw: unknown, tools: McpToolDef[]): Promise<McpOutcome> {
  const req = raw as { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return { kind: "bad_request", message: "invalid JSON-RPC request" };
  }

  // Notifications (no id) are acknowledged, never answered.
  if (req.id === undefined || req.id === null) {
    return { kind: "accepted" };
  }

  const respond = (result: unknown): McpOutcome => ({
    kind: "response",
    body: { jsonrpc: "2.0", id: req.id ?? null, result },
  });
  const fail = (code: number, message: string): McpOutcome => ({
    kind: "response",
    body: { jsonrpc: "2.0", id: req.id ?? null, error: { code, message } },
  });

  switch (req.method) {
    case "initialize":
      return respond({
        protocolVersion: (req.params?.protocolVersion as string) ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "wadeea", version: "1.0.0" },
      });

    case "ping":
      return respond({});

    case "tools/list":
      return respond({
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });

    case "tools/call": {
      const name = req.params?.name as string | undefined;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool: ${name}`);
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const result = await tool.handler(args);
        return respond({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        // Tool failures are content-level (isError), not protocol errors —
        // the model must see them and react, per MCP semantics.
        return respond({
          isError: true,
          content: [{ type: "text", text: String(e instanceof Error ? e.message : e) }],
        });
      }
    }

    default:
      return fail(-32601, `method not found: ${req.method}`);
  }
}

/** Frame a JSON-RPC response the way streamable-http clients expect. */
export function toSse(body: JsonRpcResponse): string {
  return `event: message\ndata: ${JSON.stringify(body)}\n\n`;
}
