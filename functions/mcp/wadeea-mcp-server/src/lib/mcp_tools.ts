import { randomUUID } from "node:crypto";
import { addDays } from "./date_utils";
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
} from "./types";

export interface ToolDeps {
  actor: ActorClient;
  sql: SqlClient;
}

export async function checkAvailability(
  args: CheckAvailabilityArgs,
  deps: ToolDeps,
): Promise<CheckAvailabilityResult | { error: string }> {
  const category = await deps.sql.getCategory(args.category_id);
  if (!category) return { error: "category not found" };

  const end_date = addDays(args.start_date, args.duration_days);
  const avail = await deps.actor.checkAvailability(
    args.category_id,
    args.start_date,
    end_date,
    category.total_units,
  );

  return {
    category_id: args.category_id,
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
  const pricing = await deps.sql.getPricing(args.category_id);
  if (!pricing) return { error: "pricing not found for category" };

  return {
    category_id: args.category_id,
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
  const category = await deps.sql.getCategory(args.category_id);
  if (!category) return { ok: false, reason: "category not found" };

  const pricing = await deps.sql.getPricing(args.category_id);
  if (!pricing) return { ok: false, reason: "pricing not found" };

  const booking_id = args.booking_id ?? randomUUID();
  const end_date = addDays(args.start_date, args.duration_days);
  const total_cents = pricing.daily_rate_cents * args.duration_days;

  const reserveResult = await deps.actor.reserve(
    args.category_id,
    booking_id,
    args.start_date,
    end_date,
    category.total_units,
  );

  if (!reserveResult.ok) {
    return { ok: false, reason: "unavailable" };
  }

  try {
    const insertResult = await deps.sql.insertBooking({
      booking_id,
      customer_name: args.customer_name,
      customer_phone: args.customer_phone,
      category_id: args.category_id,
      start_date: args.start_date,
      end_date,
      duration_days: args.duration_days,
      daily_rate_cents: pricing.daily_rate_cents,
      total_cents,
      currency: pricing.currency,
      delivery_area: args.delivery_area,
      status: "confirmed",
      created_at: new Date().toISOString(),
    });

    return {
      ok: true,
      booking_id,
      total_cents,
      currency: pricing.currency,
      idempotent: reserveResult.idempotent || !insertResult.created,
    };
  } catch {
    await deps.actor.release(args.category_id, booking_id);
    return { ok: false, reason: "booking_failed" };
  }
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
