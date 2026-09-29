import { describe, it, expect } from "vitest";
import { applyReserve, applyRelease, countAvailable, type StoredReservation } from "../lib/reservation_logic";

const r = (id: string, start: string, end: string): StoredReservation => ({
  booking_id: id, start_date: start, end_date: end, status: "confirmed", created_at: "2026-09-29T00:00:00Z",
});

describe("reservation_logic (pure functions behind the get/put actor)", () => {
  it("reserves when units remain", () => {
    const out = applyReserve([], "b1", "2026-10-01", "2026-10-05", 2);
    expect(out.result.ok).toBe(true);
    expect(out.reservations).toHaveLength(1);
  });

  it("refuses when all units overlap", () => {
    const list = [r("b1", "2026-10-01", "2026-10-05")];
    const out = applyReserve(list, "b2", "2026-10-03", "2026-10-07", 1);
    expect(out.result).toEqual({ ok: false, reason: "unavailable" });
    expect(out.reservations).toHaveLength(1);
  });

  it("is idempotent for a repeated booking_id", () => {
    const list = [r("b1", "2026-10-01", "2026-10-05")];
    const out = applyReserve(list, "b1", "2026-10-01", "2026-10-05", 1);
    expect(out.result).toEqual({ ok: true, idempotent: true });
    expect(out.reservations).toHaveLength(1);
  });

  it("treats end date as exclusive (back-to-back ok)", () => {
    const list = [r("b1", "2026-10-01", "2026-10-05")];
    const out = applyReserve(list, "b2", "2026-10-05", "2026-10-08", 1);
    expect(out.result.ok).toBe(true);
  });

  it("release removes the reservation and reports found", () => {
    const list = [r("b1", "2026-10-01", "2026-10-05")];
    const out = applyRelease(list, "b1");
    expect(out.found).toBe(true);
    expect(out.reservations).toHaveLength(0);
    expect(applyRelease([], "nope").found).toBe(false);
  });

  it("counts available units for a range, never negative", () => {
    const list = [r("b1", "2026-10-01", "2026-10-05"), r("b2", "2026-10-01", "2026-10-05")];
    expect(countAvailable(list, "2026-10-02", "2026-10-04", 3)).toEqual({ available: true, units_available: 1 });
    expect(countAvailable(list, "2026-10-02", "2026-10-04", 1)).toEqual({ available: false, units_available: 0 });
  });
});
