import { describe, it, expect, beforeEach } from "vitest";
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
      expect(result).toEqual({ error: "category not found" });
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
      expect(result).toEqual({ error: "pricing not found for category" });
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
          customer_phone: null,
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
});
