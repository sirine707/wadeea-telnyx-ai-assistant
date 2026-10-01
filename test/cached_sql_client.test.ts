import { describe, it, expect } from "vitest";
import { CachedSqlClient } from "../lib/cached_sql_client";
import type { SqlClient, VehicleCategory, Pricing, BookingRecord, RentalRule, DocumentRequirement } from "../lib/types";

// Counting fake: records how many times each method hits the "database".
class CountingSqlClient implements SqlClient {
  counts: Record<string, number> = {};
  rulesValue: RentalRule[] = [{ rule_key: "min_age", rule_value: "21", description: null }];

  private bump(k: string) { this.counts[k] = (this.counts[k] ?? 0) + 1; }

  async getCategory(categoryId: string): Promise<VehicleCategory | null> {
    this.bump("getCategory:" + categoryId);
    return { id: categoryId, name: categoryId.toUpperCase(), total_units: 3, description: null };
  }
  async listCategoryIds(): Promise<string[]> {
    this.bump("listCategoryIds");
    return ["suv", "sedan"];
  }
  async getPricing(categoryId: string): Promise<Pricing | null> {
    this.bump("getPricing:" + categoryId);
    return { category_id: categoryId, daily_rate_cents: 100, currency: "AED" };
  }
  async getRentalRules(): Promise<RentalRule[]> {
    this.bump("getRentalRules");
    return this.rulesValue;
  }
  async getDocumentRequirements(visitorType?: string): Promise<DocumentRequirement[]> {
    this.bump("getDocumentRequirements:" + (visitorType ?? "all"));
    return [{ id: "d1", name: "Doc", required_for: visitorType ?? "all", description: null }];
  }
  async insertBooking(_b: BookingRecord): Promise<{ created: boolean }> {
    this.bump("insertBooking");
    return { created: true };
  }
  async lookupBooking(_id: string): Promise<BookingRecord | null> {
    this.bump("lookupBooking");
    return null;
  }
  async deleteBooking(_id: string): Promise<{ deleted: boolean }> {
    this.bump("deleteBooking");
    return { deleted: false };
  }
  async lookupBookingsByPhone(_p: string): Promise<BookingRecord[]> {
    this.bump("lookupBookingsByPhone");
    return [];
  }
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function make(ttlMs = 1000) {
  const inner = new CountingSqlClient();
  let now = 0;
  const client = new CachedSqlClient(inner, { ttlMs, now: () => now });
  return { inner, client, advance: (ms: number) => { now += ms; } };
}

describe("CachedSqlClient (static reference data cache, ADR-0002 latency work)", () => {
  it("serves repeat reads from cache without hitting the db", async () => {
    const { inner, client } = make();
    await client.getRentalRules();
    const again = await client.getRentalRules();
    expect(inner.counts["getRentalRules"]).toBe(1);
    expect(again[0].rule_key).toBe("min_age");
  });

  it("caches per argument (tourists vs residents)", async () => {
    const { inner, client } = make();
    await client.getDocumentRequirements("tourists");
    await client.getDocumentRequirements("residents");
    await client.getDocumentRequirements("tourists");
    expect(inner.counts["getDocumentRequirements:tourists"]).toBe(1);
    expect(inner.counts["getDocumentRequirements:residents"]).toBe(1);
  });

  it("caches category and pricing lookups per id", async () => {
    const { inner, client } = make();
    await client.getCategory("suv");
    await client.getCategory("suv");
    await client.getPricing("suv");
    await client.getPricing("suv");
    expect(inner.counts["getCategory:suv"]).toBe(1);
    expect(inner.counts["getPricing:suv"]).toBe(1);
  });

  it("after TTL expiry: serves the stale value immediately and refreshes in the background", async () => {
    const { inner, client, advance } = make(1000);
    await client.getRentalRules();
    inner.rulesValue = [{ rule_key: "min_age", rule_value: "25", description: null }];
    advance(1500);
    const stale = await client.getRentalRules(); // must not block on the db
    expect(stale[0].rule_value).toBe("21");
    await tick(); // let the background refresh land
    const fresh = await client.getRentalRules();
    expect(fresh[0].rule_value).toBe("25");
    expect(inner.counts["getRentalRules"]).toBe(2);
  });

  it("never caches bookings or writes", async () => {
    const { inner, client } = make();
    await client.lookupBooking("b1");
    await client.lookupBooking("b1");
    await client.lookupBookingsByPhone("+971");
    await client.lookupBookingsByPhone("+971");
    await client.insertBooking({} as BookingRecord);
    await client.insertBooking({} as BookingRecord);
    expect(inner.counts["lookupBooking"]).toBe(2);
    expect(inner.counts["lookupBookingsByPhone"]).toBe(2);
    expect(inner.counts["insertBooking"]).toBe(2);
  });

  it("prefetch warms rules, documents, categories and pricing", async () => {
    const { inner, client } = make();
    await client.prefetch();
    inner.counts = {}; // reset: nothing below may hit the db
    await client.getRentalRules();
    await client.getDocumentRequirements("tourists");
    await client.getDocumentRequirements("residents");
    await client.getCategory("suv");
    await client.getPricing("sedan");
    await client.listCategoryIds();
    expect(inner.counts).toEqual({});
  });

  it("a failing background refresh keeps serving the stale value", async () => {
    const { inner, client, advance } = make(1000);
    await client.getRentalRules();
    inner.getRentalRules = async () => { throw new Error("db down"); };
    advance(1500);
    const v1 = await client.getRentalRules();
    await tick();
    const v2 = await client.getRentalRules();
    expect(v1[0].rule_value).toBe("21");
    expect(v2[0].rule_value).toBe("21");
  });
});
