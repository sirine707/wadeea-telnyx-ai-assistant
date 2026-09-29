import { describe, it, expect } from "vitest";
import { ReservationStore, type ReservationStorage } from "../lib/reservation_store";
import { InMemoryReservationStorage } from "../lib/fakes";

function makeStore(): { store: ReservationStore; storage: InMemoryReservationStorage } {
  const storage = new InMemoryReservationStorage();
  return { store: new ReservationStore(storage), storage };
}

describe("ReservationStore", () => {
  describe("date-range overlap", () => {
    it("rejects identical date range when unit is already booked", () => {
      const { store } = makeStore();
      const r1 = store.reserve("b1", "2026-09-26", "2026-09-30", 1);
      const r2 = store.reserve("b2", "2026-09-26", "2026-09-30", 1);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(false);
      expect(r2.reason).toBe("unavailable");
    });

    it("rejects partial overlap (start inside existing range)", () => {
      const { store } = makeStore();
      store.reserve("b1", "2026-09-26", "2026-09-30", 1);
      const r = store.reserve("b2", "2026-09-28", "2026-10-02", 1);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("unavailable");
    });

    it("rejects partial overlap (end inside existing range)", () => {
      const { store } = makeStore();
      store.reserve("b1", "2026-09-26", "2026-09-30", 1);
      const r = store.reserve("b2", "2026-09-24", "2026-09-28", 1);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("unavailable");
    });

    it("rejects contained range (new inside existing)", () => {
      const { store } = makeStore();
      store.reserve("b1", "2026-09-26", "2026-09-30", 1);
      const r = store.reserve("b2", "2026-09-27", "2026-09-29", 1);
      expect(r.ok).toBe(false);
    });

    it("rejects containing range (new wraps existing)", () => {
      const { store } = makeStore();
      store.reserve("b1", "2026-09-27", "2026-09-29", 1);
      const r = store.reserve("b2", "2026-09-26", "2026-09-30", 1);
      expect(r.ok).toBe(false);
    });
  });

  describe("adjacent dates (no overlap)", () => {
    it("allows booking that starts on the day the previous ends (exclusive end)", () => {
      const { store } = makeStore();
      store.reserve("b1", "2026-09-26", "2026-09-30", 1);
      const r = store.reserve("b2", "2026-09-30", "2026-10-03", 1);
      expect(r.ok).toBe(true);
    });

    it("allows booking that ends on the day the next starts (exclusive end)", () => {
      const { store } = makeStore();
      store.reserve("b1", "2026-09-30", "2026-10-03", 1);
      const r = store.reserve("b2", "2026-09-27", "2026-09-30", 1);
      expect(r.ok).toBe(true);
    });
  });

  describe("concurrent booking of last unit", () => {
    it("exactly N successes when booking N+1 times for N total units", () => {
      const { store } = makeStore();
      const results = [
        store.reserve("b1", "2026-09-26", "2026-09-28", 2),
        store.reserve("b2", "2026-09-26", "2026-09-28", 2),
        store.reserve("b3", "2026-09-26", "2026-09-28", 2),
      ];
      const successes = results.filter((r) => r.ok);
      expect(successes).toHaveLength(2);
      expect(results[2]!.ok).toBe(false);
      expect(results[2]!.reason).toBe("unavailable");
    });

    it("allows non-overlapping bookings beyond the limit", () => {
      const { store } = makeStore();
      store.reserve("b1", "2026-09-26", "2026-09-28", 1);
      const r = store.reserve("b2", "2026-09-28", "2026-09-30", 1);
      expect(r.ok).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("returns ok with idempotent=true when booking_id already exists", () => {
      const { store } = makeStore();
      const r1 = store.reserve("b1", "2026-09-26", "2026-09-28", 1);
      const r2 = store.reserve("b1", "2026-09-26", "2026-09-28", 1);
      expect(r1.ok).toBe(true);
      expect(r1.idempotent).toBeUndefined();
      expect(r2.ok).toBe(true);
      expect(r2.idempotent).toBe(true);
    });

    it("does not create a second reservation on retry", () => {
      const { store, storage } = makeStore();
      store.reserve("b1", "2026-09-26", "2026-09-28", 1);
      store.reserve("b1", "2026-09-26", "2026-09-28", 1);
      expect(storage.getById("b1")).toBeDefined();
      const overlapping = storage.countOverlapping("2026-09-26", "2026-09-28");
      expect(overlapping).toBe(1);
    });
  });

  describe("release", () => {
    it("frees the unit for a subsequent booking", () => {
      const { store } = makeStore();
      store.reserve("b1", "2026-09-26", "2026-09-28", 1);
      const before = store.reserve("b2", "2026-09-26", "2026-09-28", 1);
      expect(before.ok).toBe(false);

      store.release("b1");
      const after = store.reserve("b2", "2026-09-26", "2026-09-28", 1);
      expect(after.ok).toBe(true);
    });

    it("is idempotent (releasing a non-existent booking does not error)", () => {
      const { store } = makeStore();
      const r = store.release("nonexistent");
      expect(r.ok).toBe(true);
    });
  });

  describe("checkAvailability", () => {
    it("returns correct units_available", () => {
      const { store } = makeStore();
      const avail0 = store.checkAvailability("2026-09-26", "2026-09-28", 3);
      expect(avail0).toEqual({ available: true, units_available: 3 });

      store.reserve("b1", "2026-09-26", "2026-09-28", 3);
      const avail1 = store.checkAvailability("2026-09-26", "2026-09-28", 3);
      expect(avail1).toEqual({ available: true, units_available: 2 });

      store.reserve("b2", "2026-09-26", "2026-09-28", 3);
      store.reserve("b3", "2026-09-26", "2026-09-28", 3);
      const avail3 = store.checkAvailability("2026-09-26", "2026-09-28", 3);
      expect(avail3).toEqual({ available: false, units_available: 0 });
    });

    it("ignores non-overlapping reservations", () => {
      const { store } = makeStore();
      store.reserve("b1", "2026-09-26", "2026-09-28", 1);
      const avail = store.checkAvailability("2026-09-28", "2026-09-30", 1);
      expect(avail).toEqual({ available: true, units_available: 1 });
    });
  });
});
