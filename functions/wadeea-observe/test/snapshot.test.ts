import { describe, it, expect } from "vitest";
import { buildSnapshot } from "../snapshot.js";

const runtimeBody = JSON.stringify({
  meta: { has_more: false },
  data: [
    {
      record_type: "compute_func_runtime_log",
      timestamp: "2026-09-30T10:00:00.000Z",
      level: "log",
      message:
        '{"event":"assistant.initialization","telnyx_conversation_id":"conv-1","node":"dynamic-variables","latency_ms":90,"outcome":"ok"}',
    },
  ],
});

const invocationBody = JSON.stringify({
  meta: { has_more: false },
  data: [
    {
      record_type: "compute_func_invocation_log",
      timestamp: "2026-09-30T10:00:01.000Z",
      method: "POST",
      path: "/mcp",
      status_code: 200,
      duration_ms: 2.5,
      request_size_bytes: 10,
      response_size_bytes: 20,
      region: "us-east-2",
    },
  ],
});

function fakeFetch(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${url} auth=${(init?.headers as Record<string, string> | undefined)?.Authorization ?? "none"}`);
    if (url.includes("/stats")) return new Response(JSON.stringify({ instance_id: "i1", tool_calls: { get_quote: 2 } }));
    if (url.includes("type=runtime")) return new Response(runtimeBody);
    return new Response(invocationBody);
  }) as typeof fetch;
}

const OPTS = {
  funcs: [
    { id: "id-webhook", label: "webhook" },
    { id: "id-mcp", label: "mcp" },
  ],
  statsUrl: "https://mcp.example.com/stats",
  apiKey: "KEY123",
};

describe("buildSnapshot (assembles the dashboard payload from the Telnyx REST API + /stats)", () => {
  it("fetches runtime+invocation logs per function with bearer auth, plus /stats", async () => {
    const calls: string[] = [];
    await buildSnapshot({ ...OPTS, fetchImpl: fakeFetch(calls) });
    const logCalls = calls.filter((c) => c.includes("/logs"));
    expect(logCalls).toHaveLength(4); // 2 funcs × 2 types
    expect(logCalls.every((c) => c.includes("auth=Bearer KEY123"))).toBe(true);
    expect(calls.some((c) => c.startsWith("https://mcp.example.com/stats"))).toBe(true);
  });

  it("returns aggregated metrics, recent events sorted by time, and the stats payload", async () => {
    const snap = await buildSnapshot({ ...OPTS, fetchImpl: fakeFetch([]) });
    expect(snap.funcs["webhook"].appP50).toBe(90);
    expect(snap.funcs["mcp"].requests).toBeGreaterThan(0);
    expect(snap.recent.length).toBeGreaterThan(0);
    expect([...snap.recent].map((e) => e.ts)).toEqual([...snap.recent].map((e) => e.ts).sort());
    expect(snap.conversations[0].conversationId).toBe("conv-1");
    expect((snap.stats as { instance_id: string }).instance_id).toBe("i1");
  });

  it("excludes monitoring self-traffic (/health, /stats) from metrics and the stream", async () => {
    const monitorBody = JSON.stringify({
      meta: { has_more: false },
      data: [
        { record_type: "compute_func_invocation_log", timestamp: "2026-09-30T10:00:02.000Z", method: "GET", path: "/stats", status_code: 200, duration_ms: 2, request_size_bytes: 0, response_size_bytes: 100, region: "us-east-2" },
        { record_type: "compute_func_invocation_log", timestamp: "2026-09-30T10:00:03.000Z", method: "GET", path: "/health", status_code: 200, duration_ms: 1, request_size_bytes: 0, response_size_bytes: 2, region: "us-east-2" },
        { record_type: "compute_func_invocation_log", timestamp: "2026-09-30T10:00:04.000Z", method: "POST", path: "/mcp", status_code: 200, duration_ms: 3, request_size_bytes: 10, response_size_bytes: 20, region: "us-east-2" },
      ],
    });
    const monitorFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/stats")) return new Response(JSON.stringify({ instance_id: "i1", tool_calls: {} }));
      if (url.includes("type=runtime")) return new Response(JSON.stringify({ meta: {}, data: [] }));
      return new Response(monitorBody);
    }) as typeof fetch;
    const snap = await buildSnapshot({ ...OPTS, fetchImpl: monitorFetch });
    expect(snap.funcs["mcp"].requests).toBe(1); // only the real /mcp call
    expect(snap.recent.every((e) => e.kind !== "invocation" || e.path === "/mcp")).toBe(true);
  });

  it("tolerates failing sources: a dead API or stats endpoint yields an empty but valid snapshot", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const snap = await buildSnapshot({ ...OPTS, fetchImpl: failing });
    expect(snap.recent).toEqual([]);
    expect(snap.stats).toBeNull();
    expect(snap.alerts).toEqual([]);
  });
});
