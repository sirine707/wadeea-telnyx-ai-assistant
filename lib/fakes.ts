import { ReservationStore, type ReservationStorage } from "./reservation_store";
import type {
  ActorClient,
  SqlClient,
  VehicleCategory,
  Pricing,
  RentalRule,
  DocumentRequirement,
  BookingRecord,
  Reservation,
  ReserveResult,
  AvailabilityResult,
} from "./types";

export class InMemoryReservationStorage implements ReservationStorage {
  private map = new Map<string, Reservation>();

  getById(bookingId: string): Reservation | undefined {
    return this.map.get(bookingId);
  }

  countOverlapping(startDate: string, endDate: string): number {
    let count = 0;
    for (const r of this.map.values()) {
      if (r.status === "confirmed" && r.start_date < endDate && startDate < r.end_date) {
        count++;
      }
    }
    return count;
  }

  insert(r: Reservation): void {
    this.map.set(r.booking_id, r);
  }

  delete(bookingId: string): void {
    this.map.delete(bookingId);
  }
}

export class FakeFleetActor implements ActorClient {
  private stores = new Map<string, ReservationStore>();

  private getStore(categoryId: string): ReservationStore {
    let s = this.stores.get(categoryId);
    if (!s) {
      s = new ReservationStore(new InMemoryReservationStorage());
      this.stores.set(categoryId, s);
    }
    return s;
  }

  async reserve(
    categoryId: string,
    bookingId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<ReserveResult> {
    return this.getStore(categoryId).reserve(bookingId, startDate, endDate, totalUnits);
  }

  async release(categoryId: string, bookingId: string): Promise<{ ok: boolean }> {
    return this.getStore(categoryId).release(bookingId);
  }

  async checkAvailability(
    categoryId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<AvailabilityResult> {
    return this.getStore(categoryId).checkAvailability(startDate, endDate, totalUnits);
  }
}

export class FakeSqlClient implements SqlClient {
  categories = new Map<string, VehicleCategory>();
  pricing = new Map<string, Pricing>();
  rules: RentalRule[] = [];
  documents: DocumentRequirement[] = [];
  bookings = new Map<string, BookingRecord>();

  insertShouldFail = false;

  async getCategory(categoryId: string): Promise<VehicleCategory | null> {
    return this.categories.get(categoryId) ?? null;
  }

  async listCategoryIds(): Promise<string[]> {
    return [...this.categories.keys()];
  }

  async getPricing(categoryId: string): Promise<Pricing | null> {
    return this.pricing.get(categoryId) ?? null;
  }

  async insertBooking(booking: BookingRecord): Promise<{ created: boolean }> {
    if (this.insertShouldFail) throw new Error("simulated SQL failure");
    if (this.bookings.has(booking.booking_id)) return { created: false };
    this.bookings.set(booking.booking_id, booking);
    return { created: true };
  }

  async lookupBooking(bookingId: string): Promise<BookingRecord | null> {
    return this.bookings.get(bookingId) ?? null;
  }

  async lookupBookingsByPhone(phone: string): Promise<BookingRecord[]> {
    return [...this.bookings.values()].filter((b) => b.customer_phone === phone);
  }

  async getDocumentRequirements(visitorType?: string): Promise<DocumentRequirement[]> {
    if (!visitorType) return this.documents;
    return this.documents.filter(
      (d) => d.required_for === "all" || d.required_for === visitorType,
    );
  }

  async getRentalRules(): Promise<RentalRule[]> {
    return this.rules;
  }
}

export function seedFakeSql(sql: FakeSqlClient): void {
  sql.categories.set("suv", {
    id: "suv",
    name: "SUV",
    total_units: 3,
    description: "Spacious SUV for families",
  });
  sql.categories.set("sedan", {
    id: "sedan",
    name: "Sedan",
    total_units: 5,
    description: "Comfortable sedan",
  });
  sql.categories.set("luxury", {
    id: "luxury",
    name: "Luxury",
    total_units: 2,
    description: "Premium luxury vehicle",
  });
  sql.categories.set("economy", {
    id: "economy",
    name: "Economy",
    total_units: 4,
    description: "Budget-friendly economy car",
  });

  sql.pricing.set("suv", { category_id: "suv", daily_rate_cents: 25000, currency: "AED" });
  sql.pricing.set("sedan", { category_id: "sedan", daily_rate_cents: 15000, currency: "AED" });
  sql.pricing.set("luxury", { category_id: "luxury", daily_rate_cents: 50000, currency: "AED" });
  sql.pricing.set("economy", { category_id: "economy", daily_rate_cents: 12000, currency: "AED" });

  sql.rules = [
    { rule_key: "min_age", rule_value: "21", description: "Minimum driver age" },
    { rule_key: "min_duration_days", rule_value: "1", description: "Minimum rental duration" },
    { rule_key: "license_required", rule_value: "yes", description: "Valid driving license required" },
    { rule_key: "security_deposit_cents", rule_value: "150000", description: "Security deposit (1500 AED)" },
  ];

  sql.documents = [
    { id: "uae_license", name: "UAE Driving License", required_for: "residents", description: "Valid UAE driving license" },
    { id: "intl_license", name: "International Driving Permit", required_for: "tourists", description: "Valid IDP with passport" },
    { id: "passport", name: "Passport", required_for: "tourists", description: "Original passport" },
    { id: "emirates_id", name: "Emirates ID", required_for: "residents", description: "Emirates ID card" },
    { id: "credit_card", name: "Credit Card", required_for: "all", description: "Credit card for security deposit" },
  ];
}

// ── Fake for the Postgres reservation fallback (ADR-0002) ──

import type { AtomicReservationDb, AtomicReserveOutcome } from "./sql_reservation_client";

interface FakeSqlReservation {
  booking_id: string;
  category_id: string;
  start_date: string;
  end_date: string;
  status: string;
}

export class InMemoryAtomicReservationDb implements AtomicReservationDb {
  private rows = new Map<string, FakeSqlReservation>();

  // Atomic by construction: no awaits between check and insert, so each call
  // runs to completion before the next — mirroring the real impl's transaction.
  async reserveAtomic(
    categoryId: string,
    bookingId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<AtomicReserveOutcome> {
    if (this.rows.has(bookingId)) return { inserted: false, existing: true };
    const overlapping = this.count(categoryId, startDate, endDate);
    if (overlapping >= totalUnits) return { inserted: false, existing: false };
    this.rows.set(bookingId, {
      booking_id: bookingId,
      category_id: categoryId,
      start_date: startDate,
      end_date: endDate,
      status: "confirmed",
    });
    return { inserted: true, existing: false };
  }

  async release(categoryId: string, bookingId: string): Promise<{ found: boolean }> {
    const row = this.rows.get(bookingId);
    if (!row || row.category_id !== categoryId) return { found: false };
    this.rows.delete(bookingId);
    return { found: true };
  }

  async countOverlapping(categoryId: string, startDate: string, endDate: string): Promise<number> {
    return this.count(categoryId, startDate, endDate);
  }

  private count(categoryId: string, startDate: string, endDate: string): number {
    let n = 0;
    for (const r of this.rows.values()) {
      if (
        r.category_id === categoryId &&
        r.status === "confirmed" &&
        r.start_date < endDate &&
        startDate < r.end_date
      ) {
        n++;
      }
    }
    return n;
  }
}
