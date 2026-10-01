import type {
  SqlClient,
  VehicleCategory,
  Pricing,
  BookingRecord,
  RentalRule,
  DocumentRequirement,
} from "../shared/types";

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  refreshing: boolean;
}

export interface CachedSqlClientOptions {
  ttlMs?: number;
  now?: () => number;
}

// Caches the operator-seeded, read-mostly lookups (rules, documents,
// categories, pricing) with a TTL and stale-while-revalidate: an expired entry
// is served immediately while a background refresh replaces it, so callers
// never wait on the database for static data. Bookings and availability are
// never cached — freshness is correctness there (see AGENTS.md).
export class CachedSqlClient implements SqlClient {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private now: () => number;

  constructor(private inner: SqlClient, opts: CachedSqlClientOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  private async cached<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const entry = this.cache.get(key);
    if (entry) {
      if (this.now() >= entry.expiresAt && !entry.refreshing) {
        entry.refreshing = true;
        void fetch()
          .then((value) => {
            this.cache.set(key, { value, expiresAt: this.now() + this.ttlMs, refreshing: false });
          })
          .catch(() => {
            // keep serving the stale value; retry on the next expiry check
            entry.refreshing = false;
          });
      }
      return entry.value as T;
    }
    const value = await fetch();
    this.cache.set(key, { value, expiresAt: this.now() + this.ttlMs, refreshing: false });
    return value;
  }

  // Fire at instance startup so the first caller finds a warm cache.
  async prefetch(): Promise<void> {
    try {
      const ids = await this.listCategoryIds();
      await Promise.all([
        this.getRentalRules(),
        this.getDocumentRequirements(),
        this.getDocumentRequirements("tourists"),
        this.getDocumentRequirements("residents"),
        ...ids.flatMap((id) => [this.getCategory(id), this.getPricing(id)]),
      ]);
    } catch {
      // best effort — a failed prefetch just means the first caller fetches
    }
  }

  // ── cached (static reference data) ──

  getCategory(categoryId: string): Promise<VehicleCategory | null> {
    return this.cached(`category:${categoryId}`, () => this.inner.getCategory(categoryId));
  }

  listCategoryIds(): Promise<string[]> {
    return this.cached("categoryIds", () => this.inner.listCategoryIds());
  }

  getPricing(categoryId: string): Promise<Pricing | null> {
    return this.cached(`pricing:${categoryId}`, () => this.inner.getPricing(categoryId));
  }

  getRentalRules(): Promise<RentalRule[]> {
    return this.cached("rules", () => this.inner.getRentalRules());
  }

  getDocumentRequirements(visitorType?: string): Promise<DocumentRequirement[]> {
    return this.cached(`documents:${visitorType ?? "all"}`, () =>
      this.inner.getDocumentRequirements(visitorType),
    );
  }

  // ── never cached (bookings: freshness is correctness) ──

  insertBooking(booking: BookingRecord): Promise<{ created: boolean }> {
    return this.inner.insertBooking(booking);
  }

  lookupBooking(bookingId: string): Promise<BookingRecord | null> {
    return this.inner.lookupBooking(bookingId);
  }

  lookupBookingsByPhone(phone: string): Promise<BookingRecord[]> {
    return this.inner.lookupBookingsByPhone(phone);
  }
}
