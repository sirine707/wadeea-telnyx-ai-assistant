import { describe, it, expect } from "vitest";
import { summarizeToolIO } from "../lib/tool_io";

describe("summarizeToolIO (whitelisted tool args/result for the tool_call log line)", () => {
  it("keeps whitelisted args and drops PII fields", () => {
    const io = summarizeToolIO(
      {
        category_id: "suv",
        start_date: "2026-10-05",
        duration_days: 3,
        customer_name: "Ali",
        customer_phone: "+9715000",
        delivery_area: "Marina",
      },
      null,
    );
    expect(io.args).toEqual({ category_id: "suv", start_date: "2026-10-05", duration_days: 3 });
    expect(JSON.stringify(io)).not.toContain("Ali");
    expect(JSON.stringify(io)).not.toContain("+9715000");
    expect(JSON.stringify(io)).not.toContain("Marina");
  });

  it("keeps whitelisted result fields from the tool's JSON text", () => {
    const io = summarizeToolIO(
      { category_id: "suv" },
      JSON.stringify({
        category_id: "suv",
        available: true,
        units_available: 2,
        total_cents: 135000,
        currency: "AED",
        booking_id: "WAD-1",
        idempotent: true,
        customer_name: "Ali",
      }),
    );
    expect(io.result).toEqual({
      available: true,
      units_available: 2,
      total_cents: 135000,
      currency: "AED",
      booking_id: "WAD-1",
      idempotent: true,
    });
    expect(JSON.stringify(io)).not.toContain("Ali");
  });

  it("summarizes a non-JSON result (error text) as a truncated error", () => {
    const io = summarizeToolIO({}, "Error: db down " + "x".repeat(300));
    expect(io.result?.error).toBeDefined();
    expect(String(io.result?.error).length).toBeLessThanOrEqual(120);
  });

  it("omits empty sections and survives garbage input", () => {
    expect(summarizeToolIO(null, null)).toEqual({});
    expect(summarizeToolIO("weird", "")).toEqual({});
  });
});
