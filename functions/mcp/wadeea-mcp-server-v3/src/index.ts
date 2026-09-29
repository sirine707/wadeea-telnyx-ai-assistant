import { env } from "@telnyx/edge-runtime";
import { neon } from "@neondatabase/serverless";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type {
  ActorClient,
  SqlClient,
  VehicleCategory,
  Pricing,
  BookingRecord,
  RentalRule,
  DocumentRequirement,
} from "./lib/types";
import * as tools from "./lib/mcp_tools";
import { SqlReservationClient, NeonReservationDb, type NeonLikeSql } from "./lib/sql_reservation_client";
import { CachedSqlClient } from "./lib/cached_sql_client";

// Re-export the actor class so the runtime resolves the [[actors]] type here;
// the exported class name must equal the type.
export { FleetInventoryV2 } from "./actors/fleet_inventory";

const sql = neon(process.env.DATABASE_URL!);

class RealActorClient implements ActorClient {
  async reserve(categoryId: string, bookingId: string, startDate: string, endDate: string, totalUnits: number) {
    return env.FLEET.idFromName(categoryId).reserve(bookingId, startDate, endDate, totalUnits);
  }
  async release(categoryId: string, bookingId: string) {
    return env.FLEET.idFromName(categoryId).release(bookingId);
  }
  async checkAvailability(categoryId: string, startDate: string, endDate: string, totalUnits: number) {
    return env.FLEET.idFromName(categoryId).checkAvailability(startDate, endDate, totalUnits);
  }
}

class RealSqlClient implements SqlClient {
  async getCategory(categoryId: string): Promise<VehicleCategory | null> {
    const rows = await sql`SELECT id, name, total_units, description FROM vehicle_categories WHERE id = ${categoryId}`;
    return (rows[0] as VehicleCategory) ?? null;
  }
  async listCategoryIds(): Promise<string[]> {
    const rows = await sql`SELECT id FROM vehicle_categories ORDER BY id`;
    return rows.map((r) => (r as { id: string }).id);
  }
  async getPricing(categoryId: string): Promise<Pricing | null> {
    const rows = await sql`SELECT category_id, daily_rate_cents, currency FROM pricing WHERE category_id = ${categoryId}`;
    return (rows[0] as Pricing) ?? null;
  }
  async insertBooking(booking: BookingRecord): Promise<{ created: boolean }> {
    const rows = await sql`
      INSERT INTO bookings (booking_id, customer_name, customer_phone, category_id, start_date, end_date,
        duration_days, daily_rate_cents, total_cents, currency, delivery_area, status, created_at)
      VALUES (${booking.booking_id}, ${booking.customer_name}, ${booking.customer_phone},
        ${booking.category_id}, ${booking.start_date}, ${booking.end_date},
        ${booking.duration_days}, ${booking.daily_rate_cents}, ${booking.total_cents},
        ${booking.currency}, ${booking.delivery_area}, ${booking.status}, ${booking.created_at})
      ON CONFLICT (booking_id) DO NOTHING
      RETURNING booking_id
    `;
    return { created: rows.length > 0 };
  }
  async lookupBooking(bookingId: string): Promise<BookingRecord | null> {
    const rows = await sql`SELECT * FROM bookings WHERE booking_id = ${bookingId}`;
    return (rows[0] as BookingRecord) ?? null;
  }
  async lookupBookingsByPhone(phone: string): Promise<BookingRecord[]> {
    const rows = await sql`SELECT * FROM bookings WHERE customer_phone = ${phone} ORDER BY created_at DESC`;
    return rows as BookingRecord[];
  }
  async getDocumentRequirements(visitorType?: string): Promise<DocumentRequirement[]> {
    if (!visitorType) {
      const rows = await sql`SELECT * FROM document_requirements`;
      return rows as DocumentRequirement[];
    }
    const rows = await sql`SELECT * FROM document_requirements WHERE required_for = 'all' OR required_for = ${visitorType}`;
    return rows as DocumentRequirement[];
  }
  async getRentalRules(): Promise<RentalRule[]> {
    const rows = await sql`SELECT * FROM rental_rules`;
    return rows as RentalRule[];
  }
}

// Reservation backend selection (ADR-0002): the FLEET actor binding exists only
// when telnyx.toml declares [[actors]]. Without it, atomic reservations fall
// back to Postgres (advisory-lock serialization per category).
const fleetBindingPresent = Boolean((env as unknown as Record<string, unknown>).FLEET);
const actorClient = fleetBindingPresent
  ? new RealActorClient()
  : new SqlReservationClient(new NeonReservationDb(sql as unknown as NeonLikeSql));

// Static reference data (rules, documents, categories, pricing) is cached with
// stale-while-revalidate; bookings/availability are never cached. Prefetch at
// instance start so the first caller finds a warm cache.
const sqlClient = new CachedSqlClient(new RealSqlClient());
void sqlClient.prefetch();

const deps = { actor: actorClient, sql: sqlClient };

// Stateless streamable-http: the transport (and the server bound to it) must be
// created per request — a module-scope singleton fails on the second request.
function buildMcpServer(): McpServer {
  const mcpServer = new McpServer({
    name: "wadeea",
    version: "0.1.0",
  });

mcpServer.tool("check_availability", "Check vehicle availability for a category and date range",
  { category_id: z.string(), start_date: z.string(), duration_days: z.number() },
  async (args) => {
    const result = await tools.checkAvailability(args as any, deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

mcpServer.tool("get_quote", "Get a price quote for a vehicle category",
  { category_id: z.string(), duration_days: z.number() },
  async (args) => {
    const result = await tools.getQuote(args as any, deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

mcpServer.tool("create_booking", "Create a booking (atomic reserve + shared record)",
  {
    category_id: z.string(),
    start_date: z.string(),
    duration_days: z.number(),
    customer_name: z.string(),
    customer_phone: z.string().optional(),
    delivery_area: z.string().optional(),
    booking_id: z.string().optional(),
  },
  async (args) => {
    const result = await tools.createBooking(args as any, deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

mcpServer.tool("get_document_requirements", "Get required documents for renting",
  { visitor_type: z.string().optional() },
  async (args) => {
    const result = await tools.getDocumentRequirements(args as any, deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

mcpServer.tool("get_rental_rules", "Get rental rules and policies", {},
  async () => {
    const result = await tools.getRentalRules(deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

mcpServer.tool("lookup_booking", "Look up an existing booking by booking ID or customer phone",
  { booking_id: z.string().optional(), customer_phone: z.string().optional() },
  async (args) => {
    const result = await tools.lookupBooking(args as any, deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

  return mcpServer;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/mcp") {
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await buildMcpServer().connect(transport);
      return transport.handleRequest(req);
    }

    return new Response("Not found", { status: 404 });
  },
};
