import { applyReserve, applyRelease, countAvailable, type StoredReservation } from "./reservation_logic";
import type {
  ActorClient,
  SqlClient,
  VehicleCategory,
  Pricing,
  RentalRule,
  DocumentRequirement,
  BookingRecord,
  ReserveResult,
  AvailabilityResult,
} from "./types";

export class FakeFleetActor implements ActorClient {
  private byCategory = new Map<string, StoredReservation[]>();

  private list(categoryId: string): StoredReservation[] {
    return this.byCategory.get(categoryId) ?? [];
  }

  async reserve(categoryId: string, bookingId: string, startDate: string, endDate: string, totalUnits: number): Promise<ReserveResult> {
    const { reservations, result } = applyReserve(this.list(categoryId), bookingId, startDate, endDate, totalUnits);
    if (result.ok && !result.idempotent) this.byCategory.set(categoryId, reservations);
    return result;
  }

  async release(categoryId: string, bookingId: string): Promise<{ ok: boolean }> {
    const { reservations, found } = applyRelease(this.list(categoryId), bookingId);
    this.byCategory.set(categoryId, reservations);
    return { ok: found };
  }

  async checkAvailability(categoryId: string, startDate: string, endDate: string, totalUnits: number): Promise<AvailabilityResult> {
    return countAvailable(this.list(categoryId), startDate, endDate, totalUnits);
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

