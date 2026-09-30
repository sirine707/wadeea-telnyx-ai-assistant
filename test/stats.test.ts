import { describe, it, expect } from "vitest";
import { StatsRecorder, getToolCallInfo } from "../lib/stats";

describe("StatsRecorder (in-memory per-instance /stats data)", () => {
  it("counts calls and errors per tool", () => {
    const s = new StatsRecorder();
    s.record("check_availability", true, 12);
    s.record("check_availability", true, 8);
    s.record("create_booking", false, 40);
    const snap = s.snapshot();
    expect(snap.tool_calls).toEqual({ check_availability: 2, create_booking: 1 });
    expect(snap.tool_errors).toEqual({ create_booking: 1 });
  });

  it("keeps recent calls newest-last with latency and conversation id, no args", () => {
    const s = new StatsRecorder();
    s.record("get_quote", true, 5, "conv-1");
    const snap = s.snapshot();
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0].tool).toBe("get_quote");
    expect(snap.recent[0].ok).toBe(true);
    expect(snap.recent[0].latency_ms).toBe(5);
    expect(snap.recent[0].conversation_id).toBe("conv-1");
  });

  it("caps recent calls at 50", () => {
    const s = new StatsRecorder();
    for (let i = 0; i < 60; i++) s.record("get_rental_rules", true, 1);
    expect(s.snapshot().recent).toHaveLength(50);
  });

  it("exposes an instance id and start time so replicas are tellable apart", () => {
    const a = new StatsRecorder().snapshot();
    const b = new StatsRecorder().snapshot();
    expect(a.instance_id).toBeTruthy();
    expect(a.instance_id).not.toBe(b.instance_id);
    expect(a.started_at).toBeTruthy();
  });
});

describe("getToolCallInfo (extracts tool name + conversation id from a tools/call body)", () => {
  it("returns the tool name and telnyx_conversation_id from _meta", () => {
    const body = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "check_availability",
        arguments: { category_id: "suv" },
        _meta: { telnyx_conversation_id: "conv-9" },
      },
    };
    expect(getToolCallInfo(body)).toEqual({ tool: "check_availability", conversationId: "conv-9" });
  });

  it("returns the tool with undefined conversationId when _meta is absent", () => {
    const body = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_quote", arguments: {} } };
    expect(getToolCallInfo(body)).toEqual({ tool: "get_quote", conversationId: undefined });
  });

  it("returns null for non-tool-call bodies and garbage", () => {
    expect(getToolCallInfo({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBeNull();
    expect(getToolCallInfo({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(getToolCallInfo(null)).toBeNull();
    expect(getToolCallInfo("nope")).toBeNull();
  });
});
