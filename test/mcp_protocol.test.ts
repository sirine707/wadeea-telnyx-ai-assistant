import { describe, it, expect } from "vitest";
import { handleMcpRequest, toSse, type McpToolDef } from "../lib/mcp_protocol";

const tools: McpToolDef[] = [
  {
    name: "check_availability",
    description: "Check vehicle availability",
    inputSchema: {
      type: "object",
      properties: { category_id: { type: "string" } },
      required: ["category_id"],
    },
    handler: async (args) => ({ echoed: args.category_id }),
  },
];

const call = (body: unknown) => handleMcpRequest(body, tools);

describe("hand-rolled MCP protocol (streamable-http subset)", () => {
  it("answers initialize with protocol version and server info", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(res.kind).toBe("response");
    if (res.kind !== "response") return;
    expect(res.body.id).toBe(1);
    const result = res.body.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-03-26");
    expect((result.serverInfo as Record<string, unknown>).name).toBe("wadeea");
    expect((result.capabilities as Record<string, unknown>).tools).toBeDefined();
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const res = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.kind).toBe("accepted");
  });

  it("lists tools with schemas", async () => {
    const res = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    if (res.kind !== "response") throw new Error("expected response");
    const list = (res.body.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("check_availability");
    expect(list[0].inputSchema).toBeDefined();
  });

  it("executes tools/call and wraps the result as text content", async () => {
    const res = await call({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "check_availability", arguments: { category_id: "suv" } },
    });
    if (res.kind !== "response") throw new Error("expected response");
    const content = (res.body.result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe("text");
    expect(JSON.parse(content[0].text)).toEqual({ echoed: "suv" });
  });

  it("marks tool handler failures as isError content, not protocol errors", async () => {
    const failing: McpToolDef[] = [{ ...tools[0], handler: async () => { throw new Error("db down"); } }];
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "check_availability", arguments: {} } },
      failing,
    );
    if (res.kind !== "response") throw new Error("expected response");
    const body = res.body.result as { isError: boolean; content: { text: string }[] };
    expect(body.isError).toBe(true);
    expect(body.content[0].text).toContain("db down");
  });

  it("returns JSON-RPC errors for unknown tool and unknown method", async () => {
    const badTool = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
    if (badTool.kind !== "response") throw new Error("expected response");
    expect(badTool.body.error?.code).toBe(-32602);

    const badMethod = await call({ jsonrpc: "2.0", id: 6, method: "resources/list" });
    if (badMethod.kind !== "response") throw new Error("expected response");
    expect(badMethod.body.error?.code).toBe(-32601);
  });

  it("serializes responses as SSE data frames", () => {
    const sse = toSse({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(sse).toBe('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
  });
});
