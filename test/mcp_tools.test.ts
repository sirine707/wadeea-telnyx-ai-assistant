import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as tools from "../lib/mcp_tools";
import { FakeFleetActor, FakeSqlClient, seedFakeSql } from "../lib/fakes";
import type { ToolDeps } from "../lib/mcp_tools";

function makeDeps(): { actor: FakeFleetActor; sql: FakeSqlClient } {
  const actor = new FakeFleetActor();
  const sql = new FakeSqlClient();
  seedFakeSql(sql);
  return { actor, sql };
}

type TestDeps = { actor: FakeFleetActor; sql: FakeSqlClient };

describe("MCP tools", () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("check_availability", () => {
    it("returns available when units exist", async () => {
      const result = await tools.checkAvailability(
        { category_id: "suv", start_date: "2026-09-26", duration_days: 4 },
        deps,
      );
      expect("error" in result).toBe(false);
      expect(result).toMatchObject({
        category_id: "suv",
        available: true,
        units_available: 3,
      });
    });

    it("returns unavailable when fully booked", async () => {
      await deps.actor.reserve("suv", "b1", "2026-09-26", "2026-09-28", 3);
      await deps.actor.reserve("suv", "b2", "2026-09-26", "2026-09-28", 3);
      await deps.actor.reserve("suv", "b3", "2026-09-26", "2026-09-28", 3);

      const result = await tools.checkAvailability(
        { category_id: "suv", start_date: "2026-09-26", duration_days: 2 },
        deps,
      );
      expect(result).toMatchObject({ available: false, units_available: 0 });
    });

    it("returns error for unknown category", async () => {
      const result = await tools.checkAvailability(
        { category_id: "truck", start_date: "2026-09-26", duration_days: 1 },
        deps,
      );
      expect((result as { error: string }).error).toContain("category not found");
    });
  });

  describe("get_quote", () => {
    it("returns correct total for SUV 4 days", async () => {
      const result = await tools.getQuote(
        { category_id: "suv", duration_days: 4 },
        deps,
      );
      expect(result).toMatchObject({
        daily_rate_cents: 25000,
        total_cents: 100000,
        currency: "AED",
      });
    });

    it("returns error for unknown category pricing", async () => {
      const result = await tools.getQuote(
        { category_id: "truck", duration_days: 1 },
        deps,
      );
      expect((result as { error: string }).error).toContain("valid categories");
    });
  });

  describe("create_booking", () => {
    it("succeeds: actor reserves + SQL inserts", async () => {
      const result = await tools.createBooking(
        {
          category_id: "suv",
          start_date: "2026-09-26",
          duration_days: 4,
          customer_name: "Ahmed",
          customer_phone: "+971500000001",
          delivery_area: "Downtown Dubai",
        },
        deps,
      );
      expect(result.ok).toBe(true);
      expect(result.booking_id).toBeDefined();
      expect(result.total_cents).toBe(100000);
      expect(result.currency).toBe("AED");
      expect(result.idempotent).toBe(false);
    });

    it("unavailable → no SQL booking created", async () => {
      await deps.actor.reserve("suv", "x1", "2026-09-26", "2026-09-28", 3);
      await deps.actor.reserve("suv", "x2", "2026-09-26", "2026-09-28", 3);
      await deps.actor.reserve("suv", "x3", "2026-09-26", "2026-09-28", 3);

      const result = await tools.createBooking(
        {
          category_id: "suv",
          start_date: "2026-09-26",
          duration_days: 2,
          customer_name: "Ahmed",
          customer_phone: "+971500000001",
          delivery_area: null,
        },
        deps,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("unavailable");
      expect(deps.sql.bookings.size).toBe(0);
    });

    it("SQL failure → compensating release on actor", async () => {
      deps.sql.insertShouldFail = true;
      const result = await tools.createBooking(
        {
          category_id: "suv",
          start_date: "2026-09-26",
          duration_days: 2,
          customer_name: "Ahmed",
          customer_phone: "+971500000001",
          delivery_area: null,
        },
        deps,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("booking_failed");

      const avail = await deps.actor.checkAvailability("suv", "2026-09-26", "2026-09-28", 3);
      expect(avail.units_available).toBe(3);
    });

    it("retry with same booking_id is idempotent (no double booking)", async () => {
      const args = {
        category_id: "suv",
        start_date: "2026-09-26",
        duration_days: 2,
        customer_name: "Ahmed",
        customer_phone: "+971500000001",
        delivery_area: null,
        booking_id: "fixed-booking-id",
      };

      const r1 = await tools.createBooking(args, deps);
      expect(r1.ok).toBe(true);
      expect(r1.idempotent).toBe(false);

      const r2 = await tools.createBooking(args, deps);
      expect(r2.ok).toBe(true);
      expect(r2.idempotent).toBe(true);

      expect(deps.sql.bookings.size).toBe(1);
      const avail = await deps.actor.checkAvailability("suv", "2026-09-26", "2026-09-28", 3);
      expect(avail.units_available).toBe(2);
    });

    it("returns error for unknown category", async () => {
      const result = await tools.createBooking(
        {
          category_id: "truck",
          start_date: "2026-09-26",
          duration_days: 1,
          customer_name: "Ahmed",
          customer_phone: "+971501234567",
          delivery_area: null,
        },
        deps,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("category not found");
    });
  });

  describe("get_document_requirements", () => {
    it("returns all documents when no visitor_type", async () => {
      const result = await tools.getDocumentRequirements({}, deps);
      expect(result).toHaveLength(5);
    });

    it("filters by visitor_type=tourists", async () => {
      const result = await tools.getDocumentRequirements(
        { visitor_type: "tourists" },
        deps,
      );
      expect(result).toHaveLength(3);
      expect(result.every((d) => d.required_for === "all" || d.required_for === "tourists")).toBe(true);
    });
  });

  describe("get_rental_rules", () => {
    it("returns all rules", async () => {
      const result = await tools.getRentalRules(deps);
      expect(result).toHaveLength(4);
      expect(result.find((r) => r.rule_key === "min_age")).toBeDefined();
    });
  });

  describe("lookup_booking", () => {
    it("finds booking by booking_id", async () => {
      await tools.createBooking(
        {
          category_id: "suv",
          start_date: "2026-09-26",
          duration_days: 2,
          customer_name: "Ahmed",
          customer_phone: "+971500000001",
          delivery_area: "Marina",
          booking_id: "bk-001",
        },
        deps,
      );

      const result = await tools.lookupBooking({ booking_id: "bk-001" }, deps);
      expect("error" in result).toBe(false);
      expect(result).toMatchObject({
        booking_id: "bk-001",
        customer_name: "Ahmed",
        category_id: "suv",
      });
    });

    it("finds bookings by customer_phone", async () => {
      await tools.createBooking(
        {
          category_id: "suv",
          start_date: "2026-09-26",
          duration_days: 2,
          customer_name: "Ahmed",
          customer_phone: "+971500000001",
          delivery_area: null,
          booking_id: "bk-001",
        },
        deps,
      );

      const result = await tools.lookupBooking(
        { customer_phone: "+971500000001" },
        deps,
      );
      expect(Array.isArray(result)).toBe(true);
      expect((result as unknown[]).length).toBe(1);
    });

    it("returns error when booking not found", async () => {
      const result = await tools.lookupBooking({ booking_id: "nonexistent" }, deps);
      expect(result).toEqual({ error: "booking not found" });
    });

    it("returns error when no args", async () => {
      const result = await tools.lookupBooking({}, deps);
      expect(result).toEqual({ error: "must provide booking_id or customer_phone" });
    });
  });

  describe("category id normalization (voice models send 'SUV', db stores 'suv')", () => {
    it("check_availability accepts uppercase category id", async () => {
      const result = await tools.checkAvailability(
        { category_id: "SUV", start_date: "2026-10-10", duration_days: 3 },
        deps,
      );
      expect("error" in result).toBe(false);
      expect((result as { category_id: string }).category_id).toBe("suv");
    });

    it("get_quote accepts mixed-case category id with whitespace", async () => {
      const result = await tools.getQuote({ category_id: " Suv ", duration_days: 3 }, deps);
      expect("error" in result).toBe(false);
      expect((result as { total_cents: number }).total_cents).toBe(75000);
    });

    it("create_booking accepts uppercase category id", async () => {
      const result = await tools.createBooking(
        {
          category_id: "LUXURY",
          start_date: "2026-10-10",
          duration_days: 2,
          customer_name: "Case Test",
          customer_phone: "+971501234567",
          delivery_area: null,
        },
        deps,
      );
      expect(result.ok).toBe(true);
    });

    it("unknown category error lists the valid category ids", async () => {
      const result = await tools.checkAvailability(
        { category_id: "spaceship", start_date: "2026-10-10", duration_days: 3 },
        deps,
      );
      expect("error" in result).toBe(true);
      const err = (result as { error: string }).error;
      expect(err).toContain("suv");
      expect(err).toContain("sedan");
    });
  });

  describe("booking_pipeline log line (per-hop latency evidence)", () => {
    it("logs actor_ms/sqldb_ms/total_ms and the reserve outcome on a successful booking, without PII", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      await tools.createBooking(
        { category_id: "suv", start_date: "2026-09-26", duration_days: 2, customer_name: "Ali", customer_phone: "+971501234567" },
        deps,
      );
      const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("booking_pipeline"));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line as string);
      expect(parsed.event).toBe("booking_pipeline");
      expect(parsed.category_id).toBe("suv");
      expect(parsed.reserve).toBe("ok");
      expect(typeof parsed.actor_ms).toBe("number");
      expect(typeof parsed.sqldb_ms).toBe("number");
      expect(typeof parsed.total_ms).toBe("number");
      expect(parsed.booking_id).toBeTruthy();
      expect(line).not.toContain("Ali");
      expect(line).not.toContain("+971501234567");
    });

    it("logs the refusal path (reserve=unavailable) too", async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      // fill capacity: suv has 3 units in the seeded fakes
      for (let i = 0; i < 3; i++) {
        await tools.createBooking(
          { category_id: "suv", start_date: "2026-09-26", duration_days: 2, customer_name: "X", customer_phone: "+971501234567" },
          deps,
        );
      }
      spy.mockClear();
      await tools.createBooking(
        { category_id: "suv", start_date: "2026-09-26", duration_days: 2, customer_name: "X", customer_phone: "+971501234567" },
        deps,
      );
      const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("booking_pipeline"));
      expect(line).toBeDefined();
      expect(JSON.parse(line as string).reserve).toBe("unavailable");
    });
  });

  describe("create_booking UAE phone enforcement (deterministic, tool-level)", () => {
    const base = { category_id: "suv", start_date: "2026-09-26", duration_days: 2, customer_name: "Ali" };

    it("refuses a non-UAE customer_phone with a structured invalid_phone reason", async () => {
      const r = await tools.createBooking({ ...base, customer_phone: "+14155552671" }, deps);
      expect(r).toEqual({ ok: false, reason: "invalid_phone" });
    });

    it("refuses a missing customer_phone", async () => {
      const r = await tools.createBooking({ ...base }, deps);
      expect(r).toEqual({ ok: false, reason: "invalid_phone" });
    });

    it("accepts a UAE customer_phone and books", async () => {
      const r = await tools.createBooking({ ...base, customer_phone: "00971501234567" }, deps);
      expect(r.ok).toBe(true);
    });

    it("does not reserve anything when the phone is refused", async () => {
      await tools.createBooking({ ...base, customer_phone: "+14155552671" }, deps);
      const avail = await tools.checkAvailability(
        { category_id: "suv", start_date: "2026-09-26", duration_days: 2 },
        deps,
      );
      expect((avail as { units_available: number }).units_available).toBe(3);
    });
  });

  describe("create_booking under concurrent load (no double-booking)", () => {
    it("grants exactly total_units bookings when many callers race for the same dates", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          tools.createBooking(
            { category_id: "suv", start_date: "2026-11-01", duration_days: 2, customer_name: `C${i}`, customer_phone: "+971501234567" },
            deps,
          ),
        ),
      );
      expect(results.filter((r) => r.ok).length).toBe(3); // suv has 3 units
      expect(results.filter((r) => !r.ok).every((r) => r.reason === "unavailable")).toBe(true);
    });
  });
});