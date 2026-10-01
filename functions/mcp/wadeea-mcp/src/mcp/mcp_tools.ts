import { randomUUID } from "node:crypto";
import { addDays } from "../shared/date_utils";
import { normalizeUae } from "../shared/phone";
import type {
  ActorClient,
  SqlClient,
  CheckAvailabilityArgs,
  CheckAvailabilityResult,
  GetQuoteArgs,
  GetQuoteResult,
  CreateBookingArgs,
  CreateBookingResult,
  GetDocumentRequirementsArgs,
  DocumentRequirement,
  RentalRule,
  LookupBookingArgs,
  LookupBookingResult,
} from "../shared/types";

export interface ToolDeps {
  actor: ActorClient;
  sql: SqlClient;
}


// Voice models routinely send "SUV" or " Suv " for db id "suv" — never
// hard-fail on case/whitespace, and on a real miss return the valid ids so
// the model can self-correct instead of escalating (still real data, no
// fabrication).
function normalizeCategoryId(raw: string): string {
  return raw.trim().toLowerCase();
}

async function categoryNotFound(deps: ToolDeps): Promise<string> {
  const ids = await deps.sql.listCategoryIds();
  return `category not found; valid categories: ${ids.join(", ")}`;
}

export async function checkAvailability(
  args: CheckAvailabilityArgs,
  deps: ToolDeps,
): Promise<CheckAvailabilityResult | { error: string }> {
  const categoryId = normalizeCategoryId(args.category_id);
  const category = await deps.sql.getCategory(categoryId);
  if (!category) return { error: await categoryNotFound(deps) };

  const end_date = addDays(args.start_date, args.duration_days);
  const avail = await deps.actor.checkAvailability(
    categoryId,
    args.start_date,
    end_date,
    category.total_units,
  );

  return {
    category_id: categoryId,
    category_name: category.name,
    start_date: args.start_date,
    end_date,
    available: avail.available,
    units_available: avail.units_available,
  };
}

export async function getQuote(
  args: GetQuoteArgs,
  deps: ToolDeps,
): Promise<GetQuoteResult | { error: string }> {
  const categoryId = normalizeCategoryId(args.category_id);
  const pricing = await deps.sql.getPricing(categoryId);
  if (!pricing) return { error: await categoryNotFound(deps) };

  return {
    category_id: categoryId,
    daily_rate_cents: pricing.daily_rate_cents,
    duration_days: args.duration_days,
    total_cents: pricing.daily_rate_cents * args.duration_days,
    currency: pricing.currency,
  };
}

export async function createBooking(
  args: CreateBookingArgs,
  deps: ToolDeps,
): Promise<CreateBookingResult> {
  const t0 = Date.now();

  // Bookings require a UAE contact number — enforced and normalized here,
  // deterministically, so the model never has to know phone formats.
  const customerPhone = args.customer_phone ? normalizeUae(args.customer_phone) : null;
  if (!customerPhone) {
    return { ok: false, reason: "invalid_phone" };
  }

  const categoryId = normalizeCategoryId(args.category_id);
  const category = await deps.sql.getCategory(categoryId);
  if (!category) return { ok: false, reason: "category not found" };

  const pricing = await deps.sql.getPricing(categoryId);
  if (!pricing) return { ok: false, reason: "pricing not found" };

  const booking_id = args.booking_id ?? randomUUID();
  const end_date = addDays(args.start_date, args.duration_days);
  const total_cents = pricing.daily_rate_cents * args.duration_days;

  const reserveStart = Date.now();
  const reserveResult = await deps.actor.reserve(
    categoryId,
    booking_id,
    args.start_date,
    end_date,
    category.total_units,
  );
  const actor_ms = Date.now() - reserveStart;

  if (!reserveResult.ok) {
    const total_ms = Date.now() - t0;
    console.log(JSON.stringify({ event: "booking_pipeline", booking_id, category_id: categoryId, reserve: "unavailable", actor_ms, sqldb_ms: 0, total_ms, outcome: "unavailable" }));
    return { ok: false, reason: "unavailable" };
  }

  let sqldb_ms = 0;
  try {
    const sqlStart = Date.now();
    const insertResult = await deps.sql.insertBooking({
      booking_id,
      customer_name: args.customer_name,
      customer_phone: customerPhone,
      category_id: categoryId,
      start_date: args.start_date,
      end_date,
      duration_days: args.duration_days,
      daily_rate_cents: pricing.daily_rate_cents,
      total_cents,
      currency: pricing.currency,
      delivery_area: args.delivery_area ?? null,
      status: "confirmed",
      created_at: new Date().toISOString(),
    });
    sqldb_ms = Date.now() - sqlStart;

    const total_ms = Date.now() - t0;
    console.log(JSON.stringify({ event: "booking_pipeline", booking_id, category_id: categoryId, reserve: "ok", actor_ms, sqldb_ms, total_ms, outcome: "ok" }));
    return {
      ok: true,
      booking_id,
      total_cents,
      currency: pricing.currency,
      idempotent: reserveResult.idempotent || !insertResult.created,
    };
  } catch {
    await deps.actor.release(categoryId, booking_id);
    const total_ms = Date.now() - t0;
    console.log(JSON.stringify({ event: "booking_pipeline", booking_id, category_id: categoryId, reserve: "ok", actor_ms, sqldb_ms, total_ms, outcome: "booking_failed" }));
    return { ok: false, reason: "booking_failed" };
  }
}

// Cancels a booking: removes the record first, then frees the car in the
// actor. Record-first means a failure can leave a car held, but can never
// leave a car free while a booking still claims it (no double-booking).
export async function cancelBooking(
  args: { booking_id: string },
  deps: ToolDeps,
): Promise<{ ok: true; booking_id: string } | { ok: false; reason: string }> {
  const booking = await deps.sql.lookupBooking(args.booking_id);
  if (!booking) return { ok: false, reason: "booking not found" };
  await deps.sql.deleteBooking(args.booking_id);
  await deps.actor.release(booking.category_id, args.booking_id);
  return { ok: true, booking_id: args.booking_id };
}

export async function getDocumentRequirements(
  args: GetDocumentRequirementsArgs,
  deps: ToolDeps,
): Promise<DocumentRequirement[]> {
  return deps.sql.getDocumentRequirements(args?.visitor_type);
}

export async function getRentalRules(deps: ToolDeps): Promise<RentalRule[]> {
  return deps.sql.getRentalRules();
}

export async function lookupBooking(
  args: LookupBookingArgs,
  deps: ToolDeps,
): Promise<LookupBookingResult> {
  if (args.booking_id) {
    const booking = await deps.sql.lookupBooking(args.booking_id);
    if (!booking) return { error: "booking not found" };
    return booking;
  }

  if (args.customer_phone) {
    const bookings = await deps.sql.lookupBookingsByPhone(args.customer_phone);
    if (bookings.length === 0) return { error: "no bookings found for this number" };
    return bookings;
  }

  return { error: "must provide booking_id or customer_phone" };
}
