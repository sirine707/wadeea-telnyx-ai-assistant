import { env } from "@telnyx/edge-runtime";
import { verifyTelnyxSignature } from "./shared/verify";
import { isUaeNumber } from "./shared/phone";
import { log } from "./shared/logging";
import type { RecordCallResult } from "./actors/session_logic";

// Re-export the actor class so the runtime registers the [[actors]] type.
export { CallSession } from "./actors/call_session";

const ASSISTANT_INITIALIZATION = "assistant.initialization";
const NODE = "dynamic-variables";
const BOOKINGS_ENABLED_KEY = "flag/bookings_enabled";
const ACTOR_TIMEOUT_MS = 1200; // webhook budget is 3000ms — never let the actor eat it

interface SessionStub {
  recordCall(intent?: string): Promise<RecordCallResult>;
}

function sessions(callerId: string): SessionStub {
  return (env as unknown as { SESSIONS: { idFromName(n: string): unknown } }).SESSIONS.idFromName(callerId) as SessionStub;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("actor timeout")), ms)),
  ]);
}

async function readBookingsFlag(): Promise<boolean> {
  try {
    // KvNamespace binding API: get(key) -> string | null (kv-namespace.d.ts)
    const kv = (env as unknown as { WADEEA_CONFIG?: { get(k: string): Promise<string | null> } }).WADEEA_CONFIG;
    const val = await kv?.get(BOOKINGS_ENABLED_KEY);
    return val === null || val === undefined ? true : val === "true";
  } catch {
    return true;
  }
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname.startsWith("/health/")) {
      return Response.json({ ok: true });
    }
    if (req.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }

    const started = Date.now();
    const rawBody = await req.text();

    // ── Signature verification (Ed25519 via node:crypto) ──
    const signature = req.headers.get("telnyx-signature-ed25519") ?? "";
    const timestamp = req.headers.get("telnyx-timestamp") ?? "";
    const publicKey = process.env.TELNYX_PUBLIC_KEY ?? "";
    if (!publicKey || !verifyTelnyxSignature(rawBody, signature, timestamp, publicKey)) {
      log({ event: ASSISTANT_INITIALIZATION, node: NODE, latency_ms: Date.now() - started, outcome: "signature_invalid" });
      return Response.json({ error: "signature verification failed" }, { status: 400 });
    }

    let event: { data?: { event_type?: string; payload?: Record<string, unknown> } };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    if (event?.data?.event_type !== ASSISTANT_INITIALIZATION) {
      log({ event: ASSISTANT_INITIALIZATION, node: NODE, latency_ms: Date.now() - started, outcome: "unexpected_event_type" });
      return Response.json({ error: "unexpected event_type" }, { status: 400 });
    }

    const payload = event.data?.payload ?? {};
    const conversationId = payload.telnyx_conversation_id as string | undefined;
    const caller = (payload.telnyx_end_user_target as string | undefined) ?? "";
    const verified = (payload.telnyx_end_user_target_verified as boolean | undefined) ?? false;

    // ── CallSession actor: per-caller state (graceful when actor layer down) ──
    let session: RecordCallResult = { call_count: 0, last_intent: null, returning_caller: false };
    let sessionOutcome = "no_caller_id";
    let session_ms = 0;
    if (caller) {
      const sessionStart = Date.now();
      try {
        session = await withTimeout(sessions(caller).recordCall(), ACTOR_TIMEOUT_MS);
        session_ms = Date.now() - sessionStart;
        sessionOutcome = "ok";
      } catch {
        session_ms = Date.now() - sessionStart;
        sessionOutcome = "actor_unavailable";
      }
    }

    const kvStart = Date.now();
    const bookings_enabled = await readBookingsFlag();
    const kv_ms = Date.now() - kvStart;

    // String "true"/"false" so workflow expression edges compare reliably.
    const is_uae_caller = isUaeNumber(caller) ? "true" : "false";

    const dynamic_variables = {
      session_id: conversationId ?? "",
      customer_name: "Demo Caller",
      caller_role: session.returning_caller ? "returning_caller" : "new_caller",
      rental_found: false,
      verified,
      rental_status: "none",
      // Boolean: the portal encodes expression edges on this as bool_literal.
      bookings_enabled,
      call_count: session.call_count,
      returning_caller: session.returning_caller,
      last_intent: session.last_intent ?? "",
      is_uae_caller,
      // For "shall I register the number you're calling from?" — dynamic
      // variable only, deliberately never logged (no PII in logs).
      caller_number: is_uae_caller === "true" ? caller : "",
    };

    log({
      event: ASSISTANT_INITIALIZATION,
      telnyx_conversation_id: conversationId,
      node: NODE,
      latency_ms: Date.now() - started,
      outcome: "ok",
      session_outcome: sessionOutcome,
      call_count: session.call_count,
      session_ms,
      kv_ms,
      bookings_enabled,
      returning_caller: session.returning_caller,
      is_uae_caller,
    });

    return Response.json({ dynamic_variables });
  },
};
