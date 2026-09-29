import type { Reservation, ReserveResult, AvailabilityResult } from "./types";

export interface ReservationStorage {
  getById(bookingId: string): Reservation | undefined;
  countOverlapping(startDate: string, endDate: string): number;
  insert(r: Reservation): void;
  delete(bookingId: string): void;
}

export class ReservationStore {
  constructor(private storage: ReservationStorage) {}

  reserve(
    bookingId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): ReserveResult {
    const existing = this.storage.getById(bookingId);
    if (existing) return { ok: true, idempotent: true };

    const overlapping = this.storage.countOverlapping(startDate, endDate);
    if (overlapping >= totalUnits) return { ok: false, reason: "unavailable" };

    this.storage.insert({
      booking_id: bookingId,
      start_date: startDate,
      end_date: endDate,
      status: "confirmed",
      created_at: new Date().toISOString(),
    });
    return { ok: true };
  }

  release(bookingId: string): { ok: boolean } {
    this.storage.delete(bookingId);
    return { ok: true };
  }

  checkAvailability(
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): AvailabilityResult {
    const count = this.storage.countOverlapping(startDate, endDate);
    const units = totalUnits - count;
    return { available: units > 0, units_available: units };
  }
}
