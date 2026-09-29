import { env } from "@telnyx/edge-runtime";
import * as tools from "./mcp_tools";
import { handleMcpRequest, toSse, type McpToolDef } from "./mcp_protocol";
import { SqldbClient, type SqlDatabaseLike } from "./sqldb_client";
import { CachedSqlClient } from "./cached_sql_client";
import type { ActorClient, SqlClient, ReserveResult, AvailabilityResult } from "./types";

// Actor class ships with this bundle; the runtime registers the type.
export { FleetInventory } from "./fleet_inventory";

// ── Everything below is constructed lazily: module scope must stay inert
//    because the actor container loads this same bundle (ADR 0002). ──

interface FleetStub {
  reserve(bookingId: string, startDate: string, endDate: string, totalUnits: number): Promise<ReserveResult>;
  release(bookingId: string): Promise<{ ok: boolean }>;
  checkAvailability(startDate: string, endDate: string, totalUnits: number): Promise<AvailabilityResult>;
}

class FleetActorClient implements ActorClient {
  private fleet(categoryId: string): FleetStub {
    return (env as unknown as { FLEET: { idFromName(n: string): unknown } }).FLEET.idFromName(categoryId) as FleetStub;
  }
  reserve(c: string, b: string, s: string, e: string, t: number) { return this.fleet(c).reserve(b, s, e, t); }
  release(c: string, b: string) { return this.fleet(c).release(b); }
  checkAvailability(c: string, s: string, e: string, t: number) { return this.fleet(c).checkAvailability(s, e, t); }
}

let _deps: { actor: ActorClient; sql: SqlClient } | null = null;
function deps() {
  if (!_deps) {
    const db = (env as unknown as { DB: SqlDatabaseLike }).DB;
    const sql = new CachedSqlClient(new SqldbClient(db));
    void sql.prefetch();
    _deps = { actor: new FleetActorClient(), sql };
  }
  return _deps;
}

// ── Tool registry: names, descriptions and JSON Schemas (formerly zod). ──
const str = { type: "string" } as const;
const num = { type: "number" } as const;
const TOOLS: McpToolDef[] = [
  {
    name: "check_availability",
    description: "Check vehicle availability for a category and date range",
    inputSchema: { type: "object", properties: { category_id: str, start_date: str, duration_days: num }, required: ["category_id", "start_date", "duration_days"] },
    handler: (a) => tools.checkAvailability(a as never, deps()),
  },
  {
    name: "get_quote",
    description: "Get a price quote for a vehicle category",
    inputSchema: { type: "object", properties: { category_id: str, duration_days: num }, required: ["category_id", "duration_days"] },
    handler: (a) => tools.getQuote(a as never, deps()),
  },
  {
    name: "create_booking",
    description: "Create a booking (atomic reserve + booking record)",
    inputSchema: {
      type: "object",
      properties: { category_id: str, start_date: str, duration_days: num, customer_name: str, customer_phone: str, delivery_area: str, booking_id: str },
      required: ["category_id", "start_date", "duration_days", "customer_name"],
    },
    handler: (a) => tools.createBooking(a as never, deps()),
  },
  {
    name: "get_document_requirements",
    description: "Get required documents for renting",
    inputSchema: { type: "object", properties: { visitor_type: str }, required: [] },
    handler: (a) => tools.getDocumentRequirements(a as never, deps()),
  },
  {
    name: "get_rental_rules",
    description: "Get rental rules and policies",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => tools.getRentalRules(deps()),
  },
  {
    name: "lookup_booking",
    description: "Look up an existing booking by booking ID or customer phone",
    inputSchema: { type: "object", properties: { booking_id: str, customer_phone: str }, required: [] },
    handler: (a) => tools.lookupBooking(a as never, deps()),
  },
];

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }
      const accept = req.headers.get("accept") ?? "";
      if (!accept.includes("text/event-stream")) {
        return Response.json(
          { jsonrpc: "2.0", error: { code: -32000, message: "Not Acceptable: Client must accept text/event-stream" }, id: null },
          { status: 406 },
        );
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const outcome = await handleMcpRequest(body, TOOLS);
      if (outcome.kind === "accepted") return new Response(null, { status: 202 });
      if (outcome.kind === "bad_request") return Response.json({ error: outcome.message }, { status: 400 });
      return new Response(toSse(outcome.body), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
