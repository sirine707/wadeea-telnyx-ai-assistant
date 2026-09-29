import { describe, it, expect } from "vitest";
import { SqlReservationClient } from "../lib/sql_reservation_client";
import { InMemoryAtomicReservationDb } from "../lib/fakes";

function makeClient(): { client: SqlReservationClient; db: InMemoryAtomicReservationDb } {
  const db = new InMemoryAtomicReservationDb();
  return { client: new SqlReservationClient(db), db };
}

describe("SqlReservationClient (Postgres fallback for FleetInventory actor)", () => {
  describe("reserve", () => {
    it("reserves when units are available", async () => {
      const { client } = makeClient();
      const r = await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 2);
      expect(r.ok).toBe(true);
      expect(r.idempotent).toBeUndefined();
    });

    it("returns unavailable when all units are taken for an overlapping range", async () => {
      const { client } = makeClient();
      await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 1);
      const r = await client.reserve("suv", "b2", "2026-10-03", "2026-10-07", 1);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("unavailable");
    });

    it("is idempotent for a repeated booking_id", async () => {
      const { client } = makeClient();
      await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 1);
      const r = await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 1);
      expect(r.ok).toBe(true);
      expect(r.idempotent).toBe(true);
    });

    it("scopes capacity per category", async () => {
      const { client } = makeClient();
      await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 1);
      const r = await client.reserve("sedan", "b2", "2026-10-01", "2026-10-05", 1);
      expect(r.ok).toBe(true);
    });

    it("allows back-to-back ranges (exclusive end date)", async () => {
      const { client } = makeClient();
      await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 1);
      const r = await client.reserve("suv", "b2", "2026-10-05", "2026-10-08", 1);
      expect(r.ok).toBe(true);
    });
  });

  describe("release", () => {
    it("releases an existing reservation and frees the unit", async () => {
      const { client } = makeClient();
      await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 1);
      const rel = await client.release("suv", "b1");
      expect(rel.ok).toBe(true);
      const r = await client.reserve("suv", "b2", "2026-10-01", "2026-10-05", 1);
      expect(r.ok).toBe(true);
    });

    it("returns ok=false for an unknown booking_id", async () => {
      const { client } = makeClient();
      const rel = await client.release("suv", "nope");
      expect(rel.ok).toBe(false);
    });
  });

  describe("checkAvailability", () => {
    it("reports remaining units for a range", async () => {
      const { client } = makeClient();
      await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 3);
      const a = await client.checkAvailability("suv", "2026-10-01", "2026-10-05", 3);
      expect(a.available).toBe(true);
      expect(a.units_available).toBe(2);
    });

    it("reports unavailable when fully booked", async () => {
      const { client } = makeClient();
      await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 1);
      const a = await client.checkAvailability("suv", "2026-10-02", "2026-10-04", 1);
      expect(a.available).toBe(false);
      expect(a.units_available).toBe(0);
    });

    it("never reports negative units", async () => {
      const { client } = makeClient();
      await client.reserve("suv", "b1", "2026-10-01", "2026-10-05", 2);
      await client.reserve("suv", "b2", "2026-10-01", "2026-10-05", 2);
      const a = await client.checkAvailability("suv", "2026-10-01", "2026-10-05", 1);
      expect(a.available).toBe(false);
      expect(a.units_available).toBe(0);
    });
  });

  describe("concurrency (atomicity delegated to the db's reserveAtomic)", () => {
    it("grants exactly totalUnits reservations under concurrent load", async () => {
      const { client } = makeClient();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          client.reserve("suv", `b${i}`, "2026-10-01", "2026-10-05", 3),
        ),
      );
      const granted = results.filter((r) => r.ok).length;
      expect(granted).toBe(3);
    });
  });
});
