// Pure reservation logic for the FleetInventory actor (assignment-pattern
// shape: the actor keeps one reservations array in ctx.storage via get/put and
// delegates all decisions here; its single-threaded execution makes each
// read-modify-write atomic). Dates are ISO YYYY-MM-DD; end date is exclusive.

export interface StoredReservation {
  booking_id: string;
  start_date: string;
  end_date: string;
  status: string;
  created_at: string;
}

export interface ReserveOutcome {
  reservations: StoredReservation[];
  result: { ok: boolean; idempotent?: boolean; reason?: string };
}

function overlapping(list: StoredReservation[], startDate: string, endDate: string): number {
  return list.filter(
    (r) => r.status === "confirmed" && r.start_date < endDate && startDate < r.end_date,
  ).length;
}

export function applyReserve(
  list: StoredReservation[],
  bookingId: string,
  startDate: string,
  endDate: string,
  totalUnits: number,
): ReserveOutcome {
  if (list.some((r) => r.booking_id === bookingId)) {
    return { reservations: list, result: { ok: true, idempotent: true } };
  }
  if (overlapping(list, startDate, endDate) >= totalUnits) {
    return { reservations: list, result: { ok: false, reason: "unavailable" } };
  }
  const reservation: StoredReservation = {
    booking_id: bookingId,
    start_date: startDate,
    end_date: endDate,
    status: "confirmed",
    created_at: new Date().toISOString(),
  };
  return { reservations: [...list, reservation], result: { ok: true } };
}

export function applyRelease(
  list: StoredReservation[],
  bookingId: string,
): { reservations: StoredReservation[]; found: boolean } {
  const next = list.filter((r) => r.booking_id !== bookingId);
  return { reservations: next, found: next.length !== list.length };
}

export function countAvailable(
  list: StoredReservation[],
  startDate: string,
  endDate: string,
  totalUnits: number,
): { available: boolean; units_available: number } {
  const units = Math.max(0, totalUnits - overlapping(list, startDate, endDate));
  return { available: units > 0, units_available: units };
}
