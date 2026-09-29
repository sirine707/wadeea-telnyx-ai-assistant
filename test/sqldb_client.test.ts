import { describe, it, expect } from "vitest";
import { SqldbClient, type SqlDatabaseLike, type SqlPreparedLike } from "../lib/sqldb_client";
import type { BookingRecord } from "../lib/types";

// Fake of the Telnyx SQLDB binding surface (prepare/bind/all/first/run).
class FakeDb implements SqlDatabaseLike {
  calls: { sql: string; params: unknown[] }[] = [];
  rows: Record<string, unknown>[] = [];
  prepare(sql: string) {
    const self = this;
    const make = (params: unknown[]) => ({
      bind: (...values: unknown[]) => make(values),
      all: async () => { self.calls.push({ sql, params }); return { results: self.rows, success: true, meta: {} as never }; },
      first: async () => { self.calls.push({ sql, params }); return self.rows[0] ?? null; },
      run: async () => { self.calls.push({ sql, params }); return { results: [], success: true, meta: { changes: self.rows.length } as never }; },
    });
    return make([]) as unknown as SqlPreparedLike;
  }
}

describe("SqldbClient (Telnyx SQLDB binding — replaces the Neon client)", () => {
  it("getCategory queries by id and maps the row", async () => {
    const db = new FakeDb();
    db.rows = [{ id: "suv", name: "SUV", total_units: 3, description: null }];
    const c = new SqldbClient(db);
    const cat = await c.getCategory("suv");
    expect(cat?.total_units).toBe(3);
    expect(db.calls[0].sql).toContain("vehicle_categories");
    expect(db.calls[0].params).toEqual(["suv"]);
  });

  it("getCategory returns null when absent", async () => {
    const c = new SqldbClient(new FakeDb());
    expect(await c.getCategory("nope")).toBeNull();
  });

  it("listCategoryIds returns ids in order", async () => {
    const db = new FakeDb();
    db.rows = [{ id: "economy" }, { id: "suv" }];
    expect(await new SqldbClient(db).listCategoryIds()).toEqual(["economy", "suv"]);
  });

  it("insertBooking reports created=true when a row was written", async () => {
    const db = new FakeDb();
    db.rows = [{}]; // meta.changes = 1
    const booking = { booking_id: "b1", customer_name: "X", customer_phone: null, category_id: "suv",
      start_date: "2026-10-01", end_date: "2026-10-03", duration_days: 2, daily_rate_cents: 100,
      total_cents: 200, currency: "AED", delivery_area: null, status: "confirmed", created_at: "t" } as BookingRecord;
    const r = await new SqldbClient(db).insertBooking(booking);
    expect(r.created).toBe(true);
    expect(db.calls[0].sql).toContain("INSERT");
    expect(db.calls[0].sql).toContain("ON CONFLICT");
  });

  it("insertBooking reports created=false on conflict (no changes)", async () => {
    const db = new FakeDb(); // rows empty → changes 0
    const r = await new SqldbClient(db).insertBooking({ booking_id: "b1" } as BookingRecord);
    expect(r.created).toBe(false);
  });

  it("getDocumentRequirements filters by visitor type including 'all'", async () => {
    const db = new FakeDb();
    await new SqldbClient(db).getDocumentRequirements("tourists");
    expect(db.calls[0].sql).toContain("required_for");
    expect(db.calls[0].params).toEqual(["tourists"]);
  });
});
