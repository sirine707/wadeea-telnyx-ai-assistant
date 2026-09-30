import { describe, it, expect } from "vitest";
import { parseLogLine } from "../src/parse_logs";

const runtimeRecord = {
  record_type: "compute_func_runtime_log",
  timestamp: "2026-09-29T15:35:12.269Z",
  level: "unknown",
  message:
    '{"event":"assistant.initialization","telnyx_conversation_id":"96916a0b","node":"dynamic-variables","latency_ms":87,"outcome":"ok","session_outcome":"ok","call_count":3}',
};

const invocationRecord = {
  record_type: "compute_func_invocation_log",
  timestamp: "2026-09-29T15:35:13.318Z",
  method: "POST",
  path: "/mcp",
  status_code: 200,
  duration_ms: 1.813702,
  request_size_bytes: 46,
  response_size_bytes: 1595,
  region: "us-east-2",
};

describe("parseLogLine (telnyx-edge logs --json records)", () => {
  it("parses a runtime record and decodes the structured JSON message", () => {
    const events = parseLogLine("webhook", JSON.stringify(runtimeRecord));
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev.kind !== "runtime") throw new Error("expected runtime event");
    expect(ev.func).toBe("webhook");
    expect(ev.ts).toBe("2026-09-29T15:35:12.269Z");
    expect(ev.structured?.latency_ms).toBe(87);
    expect(ev.structured?.telnyx_conversation_id).toBe("96916a0b");
  });

  it("keeps a non-JSON runtime message as raw text with structured=null", () => {
    const rec = { ...runtimeRecord, message: "listening on :8080" };
    const events = parseLogLine("webhook", JSON.stringify(rec));
    const ev = events[0];
    if (ev.kind !== "runtime") throw new Error("expected runtime event");
    expect(ev.structured).toBeNull();
    expect(ev.raw).toBe("listening on :8080");
  });

  it("parses an invocation record", () => {
    const events = parseLogLine("mcp", JSON.stringify(invocationRecord));
    const ev = events[0];
    if (ev.kind !== "invocation") throw new Error("expected invocation event");
    expect(ev.func).toBe("mcp");
    expect(ev.method).toBe("POST");
    expect(ev.path).toBe("/mcp");
    expect(ev.status).toBe(200);
    expect(ev.durationMs).toBeCloseTo(1.813702);
    expect(ev.region).toBe("us-east-2");
  });

  it("unwraps a {data: [...]} envelope (non-tail --json output)", () => {
    const envelope = { meta: { has_more: false }, data: [runtimeRecord, invocationRecord] };
    const events = parseLogLine("webhook", JSON.stringify(envelope));
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("runtime");
    expect(events[1].kind).toBe("invocation");
  });

  it("returns [] for garbage lines and unknown record types", () => {
    expect(parseLogLine("webhook", "⚠️  Showing the 2 most recent lines")).toEqual([]);
    expect(parseLogLine("webhook", JSON.stringify({ record_type: "mystery" }))).toEqual([]);
  });
});
