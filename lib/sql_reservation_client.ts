import type { ActorClient, ReserveResult, AvailabilityResult } from "./types";

// Outcome of one atomic reserve attempt, as decided inside the database.
export interface AtomicReserveOutcome {
  inserted: boolean; // this call created the reservation
  existing: boolean; // a reservation with this booking_id already existed (idempotent replay)
}

// Storage seam for the Postgres fallback. The implementation must make
// reserveAtomic a single atomic decision (lock + conditional insert in one
// transaction) — the client adds no concurrency control of its own.
export interface AtomicReservationDb {
  reserveAtomic(
    categoryId: string,
    bookingId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<AtomicReserveOutcome>;
  release(categoryId: string, bookingId: string): Promise<{ found: boolean }>;
  countOverlapping(categoryId: string, startDate: string, endDate: string): Promise<number>;
}

// Fallback ActorClient used when the FleetInventory actor binding is absent
// (see ADR-0002). Serialization per category is delegated to Postgres.
export class SqlReservationClient implements ActorClient {
  constructor(private db: AtomicReservationDb) {}

  async reserve(
    categoryId: string,
    bookingId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<ReserveResult> {
    const outcome = await this.db.reserveAtomic(categoryId, bookingId, startDate, endDate, totalUnits);
    if (outcome.inserted) return { ok: true };
    if (outcome.existing) return { ok: true, idempotent: true };
    return { ok: false, reason: "unavailable" };
  }

  async release(categoryId: string, bookingId: string): Promise<{ ok: boolean }> {
    const { found } = await this.db.release(categoryId, bookingId);
    return { ok: found };
  }

  async checkAvailability(
    categoryId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<AvailabilityResult> {
    const overlapping = await this.db.countOverlapping(categoryId, startDate, endDate);
    const units = Math.max(0, totalUnits - overlapping);
    return { available: units > 0, units_available: units };
  }
}

// Minimal structural view of @neondatabase/serverless's http client: a tagged
// template that yields queries, and transaction() running them atomically.
export interface NeonLikeSql {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  transaction(queries: unknown[]): Promise<Record<string, unknown>[][]>;
}

// Postgres implementation. Atomicity: one transaction takes a per-category
// advisory lock (the SQL analogue of the actor's single-threaded execution),
// then a conditional INSERT decides availability inside the database.
export class NeonReservationDb implements AtomicReservationDb {
  constructor(private sql: NeonLikeSql) {}

  async reserveAtomic(
    categoryId: string,
    bookingId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<AtomicReserveOutcome> {
    const [, insertRows, existingRows] = await this.sql.transaction([
      this.sql`SELECT pg_advisory_xact_lock(hashtext(${categoryId}))`,
      this.sql`
        INSERT INTO sql_reservations (booking_id, category_id, start_date, end_date, status)
        SELECT ${bookingId}, ${categoryId}, ${startDate}::date, ${endDate}::date, 'confirmed'
        WHERE NOT EXISTS (SELECT 1 FROM sql_reservations WHERE booking_id = ${bookingId})
          AND (SELECT count(*)::int FROM sql_reservations
               WHERE category_id = ${categoryId}
                 AND status = 'confirmed'
                 AND start_date < ${endDate}::date
                 AND end_date > ${startDate}::date) < ${totalUnits}
        RETURNING booking_id`,
      this.sql`SELECT booking_id FROM sql_reservations WHERE booking_id = ${bookingId}`,
    ]);
    const inserted = insertRows.length > 0;
    return { inserted, existing: !inserted && existingRows.length > 0 };
  }

  async release(categoryId: string, bookingId: string): Promise<{ found: boolean }> {
    const rows = await this.sql`
      DELETE FROM sql_reservations
      WHERE booking_id = ${bookingId} AND category_id = ${categoryId}
      RETURNING booking_id`;
    return { found: rows.length > 0 };
  }

  async countOverlapping(categoryId: string, startDate: string, endDate: string): Promise<number> {
    const rows = await this.sql`
      SELECT count(*)::int AS c FROM sql_reservations
      WHERE category_id = ${categoryId}
        AND status = 'confirmed'
        AND start_date < ${endDate}::date
        AND end_date > ${startDate}::date`;
    return (rows[0]?.c as number) ?? 0;
  }
}
