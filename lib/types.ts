// ── Webhook types (existing) ──

export interface WebhookPayload {
  data: {
    record_type: "event";
    id: string;
    event_type: string;
    occurred_at: string;
    payload: {
      telnyx_conversation_id?: string;
      call_control_id?: string;
      telnyx_end_user_target?: string;
      telnyx_end_user_target_verified?: boolean;
      telnyx_agent_target?: string;
      telnyx_conversation_channel?: string;
      assistant_id?: string;
    };
  };
}

export interface DynamicVariables {
  session_id: string;
  customer_name: string;
  caller_role: string;
  rental_found: boolean;
  verified: boolean;
  rental_status: string;
  bookings_enabled: boolean;
}

export interface DynamicVariablesResponse {
  dynamic_variables: DynamicVariables;
}

export interface ErrorResponse {
  error: string;
}

export type WebhookResult = {
  status: number;
  body?: DynamicVariablesResponse | ErrorResponse;
};

export interface LogEntry {
  event: string;
  telnyx_conversation_id?: string;
  call_control_id?: string;
  node: string;
  latency_ms: number;
  outcome: string;
  [key: string]: unknown;
}

export type VerifyFn = (
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
) => WebhookPayload;

// ── SQL business data ──

export interface VehicleCategory {
  id: string;
  name: string;
  total_units: number;
  description: string | null;
}

export interface Pricing {
  category_id: string;
  daily_rate_cents: number;
  currency: string;
}

export interface RentalRule {
  rule_key: string;
  rule_value: string;
  description: string | null;
}

export interface DocumentRequirement {
  id: string;
  name: string;
  required_for: string;
  description: string | null;
}

export interface BookingRecord {
  booking_id: string;
  customer_name: string;
  customer_phone: string | null;
  category_id: string;
  start_date: string;
  end_date: string;
  duration_days: number;
  daily_rate_cents: number;
  total_cents: number;
  currency: string;
  delivery_area: string | null;
  status: string;
  created_at: string;
}

// ── Actor / reservation types ──

export interface Reservation {
  booking_id: string;
  start_date: string;
  end_date: string;
  status: string;
  created_at: string;
}

export interface ReserveResult {
  ok: boolean;
  idempotent?: boolean;
  reason?: string;
}

export interface AvailabilityResult {
  available: boolean;
  units_available: number;
}

// ── Dependency interfaces (for testability) ──

export interface ActorClient {
  reserve(
    categoryId: string,
    bookingId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<ReserveResult>;
  release(categoryId: string, bookingId: string): Promise<{ ok: boolean }>;
  checkAvailability(
    categoryId: string,
    startDate: string,
    endDate: string,
    totalUnits: number,
  ): Promise<AvailabilityResult>;
}

export interface SqlClient {
  getCategory(categoryId: string): Promise<VehicleCategory | null>;
  getPricing(categoryId: string): Promise<Pricing | null>;
  insertBooking(booking: BookingRecord): Promise<{ created: boolean }>;
  lookupBooking(bookingId: string): Promise<BookingRecord | null>;
  lookupBookingsByPhone(phone: string): Promise<BookingRecord[]>;
  getDocumentRequirements(visitorType?: string): Promise<DocumentRequirement[]>;
  getRentalRules(): Promise<RentalRule[]>;
}

// ── MCP tool argument / result types ──

export interface CheckAvailabilityArgs {
  category_id: string;
  start_date: string;
  duration_days: number;
}

export interface CheckAvailabilityResult {
  category_id: string;
  category_name: string;
  start_date: string;
  end_date: string;
  available: boolean;
  units_available: number;
}

export interface GetQuoteArgs {
  category_id: string;
  duration_days: number;
}

export interface GetQuoteResult {
  category_id: string;
  daily_rate_cents: number;
  duration_days: number;
  total_cents: number;
  currency: string;
}

export interface CreateBookingArgs {
  category_id: string;
  start_date: string;
  duration_days: number;
  customer_name: string;
  customer_phone: string | null;
  delivery_area: string | null;
  booking_id?: string;
}

export interface CreateBookingResult {
  ok: boolean;
  booking_id?: string;
  total_cents?: number;
  currency?: string;
  reason?: string;
  idempotent?: boolean;
}

export interface GetDocumentRequirementsArgs {
  visitor_type?: string;
}

export interface LookupBookingArgs {
  booking_id?: string;
  customer_phone?: string;
}

export type LookupBookingResult = BookingRecord | BookingRecord[] | { error: string };
