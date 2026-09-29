import { StatefulActor } from "@telnyx/edge-runtime";
import { ReservationStore, type ReservationStorage } from "../lib/reservation_store";
import type { Reservation, ReserveResult, AvailabilityResult } from "../lib/types";

class SqlReservationStorage implements ReservationStorage {
  private initialized = false;

  constructor(private sql: { exec: <T>(q: string, ...b: unknown[]) => { toArray: <T2>() => T2[] } }) {}

  private ensureSchema(): void {
    if (this.initialized) return;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS reservations (
        booking_id  TEXT PRIMARY KEY,
        start_date   TEXT NOT NULL,
        end_date     TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'confirmed',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_res_dates ON reservations(start_date, end_date)`);
    this.initialized = true;
  }

  getById(bookingId: string): Reservation | undefined {
    this.ensureSchema();
    const rows = this.sql.exec<Reservation>(
      `SELECT booking_id, start_date, end_date, status, created_at FROM reservations WHERE booking_id = ?`,
      bookingId,
    ).toArray<Reservation>();
    return rows[0];
  }

  countOverlapping(startDate: string, endDate: string): number {
    this.ensureSchema();
    const rows = this.sql.exec<{ c: number }>(
      `SELECT COUNT(*) AS c FROM reservations
       WHERE start_date < ? AND end_date > ? AND status = 'confirmed'`,
      endDate,
      startDate,
    ).toArray<{ c: number }>();
    return rows[0]?.c ?? 0;
  }

  insert(r: Reservation): void {
    this.ensureSchema();
    this.sql.exec(
      `INSERT INTO reservations (booking_id, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?)`,
      r.booking_id,
      r.start_date,
      r.end_date,
      r.status,
      r.created_at,
    );
  }

  delete(bookingId: string): void {
    this.ensureSchema();
    this.sql.exec(`DELETE FROM reservations WHERE booking_id = ?`, bookingId);
  }
}

export class FleetInventory extends StatefulActor {
  private store: ReservationStore;

  constructor(ctx: ConstructorParameters<typeof StatefulActor>[0], env: ConstructorParameters<typeof StatefulActor>[1]) {
    super(ctx, env);
    this.store = new ReservationStore(
      new SqlReservationStorage(this.ctx.storage.sql as unknown as { exec: <T>(q: string, ...b: unknown[]) => { toArray: <T2>() => T2[] } }),
    );
  }

  async reserve(
    bookingId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<ReserveResult> {
    return this.store.reserve(bookingId, startDate, endDate, totalUnits);
  }

  async release(bookingId: string): Promise<{ ok: boolean }> {
    return this.store.release(bookingId);
  }

  async checkAvailability(
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<AvailabilityResult> {
    return this.store.checkAvailability(startDate, endDate, totalUnits);
  }
}
