import { env } from "@telnyx/edge-runtime";
import { neon } from "@neondatabase/serverless";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as http from "node:http";
import { z } from "zod";
import type {
  ActorClient,
  SqlClient,
  VehicleCategory,
  Pricing,
  BookingRecord,
  RentalRule,
  DocumentRequirement,
} from "../../lib/types";
import * as tools from "../../lib/mcp_tools";

export { FleetInventory } from "../../actors/fleet_inventory";

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

const deps = { actor: new RealActorClient(), sql: new RealSqlClient() };

const server = new McpServer({
  name: "wadeea",
  version: "0.1.0",
});

server.tool("check_availability", "Check vehicle availability for a category and date range",
  { category_id: z.string(), start_date: z.string(), duration_days: z.number() },
  async (args) => {
    const result = await tools.checkAvailability(args as any, deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

server.tool("get_quote", "Get a price quote for a vehicle category",
  { category_id: z.string(), duration_days: z.number() },
  async (args) => {
    const result = await tools.getQuote(args as any, deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

server.tool("create_booking", "Create a booking (atomic reserve + shared record)",
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

server.tool("get_document_requirements", "Get required documents for renting",
  { visitor_type: z.string().optional() },
  async (args) => {
    const result = await tools.getDocumentRequirements(args as any, deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

server.tool("get_rental_rules", "Get rental rules and policies", {},
  async () => {
    const result = await tools.getRentalRules(deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

server.tool("lookup_booking", "Look up an existing booking by booking ID or customer phone",
  { booking_id: z.string().optional(), customer_phone: z.string().optional() },
  async (args) => {
    const result = await tools.lookupBooking(args as any, deps);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });

const httpServer = http.createServer(async (req, res) => {
  if (req.url === "/health" || req.url?.startsWith("/health/")) {
    res.writeHead(200);
    res.end();
    return;
  }

  const transport = new StreamableHTTPServerTransport(req, res);
  await server.connect(transport);
});

httpServer.listen(process.env.PORT || 8080, () => {
  console.log(`MCP server listening on port ${process.env.PORT || 8080}`);
});
