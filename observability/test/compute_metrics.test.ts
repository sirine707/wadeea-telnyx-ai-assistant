import { describe, it, expect } from "vitest";
import { MetricsAggregator } from "../src/compute_metrics";
import type { WadeeaEvent } from "../src/parse_logs";

const inv = (over: Partial<Extract<WadeeaEvent, { kind: "invocation" }>> = {}): WadeeaEvent => ({
  kind: "invocation",
  func: "mcp",
  ts: "2026-09-29T15:35:13.318Z",
  method: "POST",
  path: "/mcp",
  status: 200,
  durationMs: 2,
  region: "us-east-2",
  ...over,
});

const run = (structured: Record<string, unknown> | null, over: Partial<Extract<WadeeaEvent, { kind: "runtime" }>> = {}): WadeeaEvent => ({
  kind: "runtime",
  func: "webhook",
  ts: "2026-09-29T15:35:12.269Z",
  structured,
  raw: structured ? JSON.stringify(structured) : "boot line",
  ...over,
});

const okInit = {
  event: "assistant.initialization",
  telnyx_conversation_id: "conv-1",
  node: "dynamic-variables",
  latency_ms: 87,
  outcome: "ok",
  session_outcome: "ok",
  call_count: 3,
};

describe("MetricsAggregator", () => {
  it("counts requests and errors per function with an error rate", () => {
    const m = new MetricsAggregator();
    m.add(inv());
    m.add(inv());
    m.add(inv({ status: 500 }));
    const f = m.snapshot().funcs["mcp"];
    expect(f.requests).toBe(3);
    expect(f.errors).toBe(1);
    expect(f.errorRate).toBeCloseTo(1 / 3);
  });

  it("computes p50/p95 over invocation durations", () => {
    const m = new MetricsAggregator();
    for (const d of [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) m.add(inv({ durationMs: d }));
    const f = m.snapshot().funcs["mcp"];
    expect(f.p50).toBeGreaterThanOrEqual(5);
    expect(f.p50).toBeLessThanOrEqual(6);
    expect(f.p95).toBeGreaterThanOrEqual(9);
  });

  it("tracks application latency_ms from structured runtime lines separately", () => {
    const m = new MetricsAggregator();
    m.add(run(okInit));
    m.add(run({ ...okInit, latency_ms: 153 }));
    const f = m.snapshot().funcs["webhook"];
    expect(f.appP50).toBeGreaterThanOrEqual(87);
    expect(f.appP50).toBeLessThanOrEqual(153);
  });

  it("raises an alert for non-2xx invocations", () => {
    const m = new MetricsAggregator();
    const alerts = m.add(inv({ status: 500 }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("non_2xx");
    expect(alerts[0].func).toBe("mcp");
  });

  it("raises an alert with a hint for signature_invalid", () => {
    const m = new MetricsAggregator();
    const alerts = m.add(run({ ...okInit, outcome: "signature_invalid" }));
    expect(alerts[0].type).toBe("bad_outcome");
    expect(alerts[0].hint).toContain("TELNYX_PUBLIC_KEY");
  });

  it("raises an alert when webhook latency nears the 3000ms budget", () => {
    const m = new MetricsAggregator();
    const alerts = m.add(run({ ...okInit, latency_ms: 1600 }));
    expect(alerts[0].type).toBe("slow_webhook");
  });

  it("emits no alerts for healthy events", () => {
    const m = new MetricsAggregator();
    expect(m.add(run(okInit))).toEqual([]);
    expect(m.add(inv())).toEqual([]);
    expect(m.add(run(null))).toEqual([]);
  });

  it("groups structured events into per-conversation traces", () => {
    const m = new MetricsAggregator();
    m.add(run(okInit));
    m.add(run({ ...okInit, event: "second.event" }, { ts: "2026-09-29T15:35:20.000Z" }));
    m.add(run({ ...okInit, telnyx_conversation_id: "conv-2" }));
    const traces = m.snapshot().conversations;
    expect(traces).toHaveLength(2);
    const c1 = traces.find((t) => t.conversationId === "conv-1");
    expect(c1?.steps).toHaveLength(2);
  });
});
