import type {
  SqlClient,
  VehicleCategory,
  Pricing,
  BookingRecord,
  RentalRule,
  DocumentRequirement,
} from "./types";

// Structural view of the Telnyx SQLDB binding (D1-style prepare/bind/all).
export interface SqlPreparedLike {
  bind(...values: unknown[]): SqlPreparedLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: { changes?: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: { changes?: number } }>;
}

export interface SqlDatabaseLike {
  prepare(query: string): SqlPreparedLike;
}

// SqlClient over the platform's SQLDB binding — replaces the Neon driver with
// zero dependencies (ADR 0003: bindings instead of libraries).
export class SqldbClient implements SqlClient {
  constructor(private db: SqlDatabaseLike) {}

  async getCategory(categoryId: string): Promise<VehicleCategory | null> {
    return this.db
      .prepare("SELECT id, name, total_units, description FROM vehicle_categories WHERE id = ?")
      .bind(categoryId)
      .first<VehicleCategory>();
  }

  async listCategoryIds(): Promise<string[]> {
    const { results } = await this.db.prepare("SELECT id FROM vehicle_categories ORDER BY id").all<{ id: string }>();
    return results.map((r) => r.id);
  }

  async getPricing(categoryId: string): Promise<Pricing | null> {
    return this.db
      .prepare("SELECT category_id, daily_rate_cents, currency FROM pricing WHERE category_id = ?")
      .bind(categoryId)
      .first<Pricing>();
  }

  async insertBooking(b: BookingRecord): Promise<{ created: boolean }> {
    const { meta } = await this.db
      .prepare(
        `INSERT INTO bookings (booking_id, customer_name, customer_phone, category_id, start_date, end_date,
           duration_days, daily_rate_cents, total_cents, currency, delivery_area, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (booking_id) DO NOTHING`,
      )
      .bind(
        b.booking_id, b.customer_name, b.customer_phone, b.category_id, b.start_date, b.end_date,
        b.duration_days, b.daily_rate_cents, b.total_cents, b.currency, b.delivery_area, b.status, b.created_at,
      )
      .run();
    return { created: (meta.changes ?? 0) > 0 };
  }

  async lookupBooking(bookingId: string): Promise<BookingRecord | null> {
    return this.db.prepare("SELECT * FROM bookings WHERE booking_id = ?").bind(bookingId).first<BookingRecord>();
  }

  async deleteBooking(bookingId: string): Promise<{ deleted: boolean }> {
    const { meta } = await this.db.prepare("DELETE FROM bookings WHERE booking_id = ?").bind(bookingId).run();
    return { deleted: (meta.changes ?? 0) > 0 };
  }

  async lookupBookingsByPhone(phone: string): Promise<BookingRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM bookings WHERE customer_phone = ? ORDER BY created_at DESC")
      .bind(phone)
      .all<BookingRecord>();
    return results;
  }

  async getDocumentRequirements(visitorType?: string): Promise<DocumentRequirement[]> {
    if (!visitorType) {
      const { results } = await this.db.prepare("SELECT * FROM document_requirements").all<DocumentRequirement>();
      return results;
    }
    const { results } = await this.db
      .prepare("SELECT * FROM document_requirements WHERE required_for = 'all' OR required_for = ?")
      .bind(visitorType)
      .all<DocumentRequirement>();
    return results;
  }

  async getRentalRules(): Promise<RentalRule[]> {
    const { results } = await this.db.prepare("SELECT * FROM rental_rules").all<RentalRule>();
    return results;
  }
}
