import * as http from "node:http";
import Telnyx from "telnyx";
import { log } from "../../lib/logging";
import type {
  WebhookPayload,
  DynamicVariables,
  DynamicVariablesResponse,
  ErrorResponse,
  WebhookResult,
  VerifyFn,
} from "../../lib/types";

const ASSISTANT_INITIALIZATION = "assistant.initialization";
const NODE = "dynamic-variables";

function getVerifyFn(): VerifyFn {
  return (rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookPayload => {
    const publicKeyEnv = process.env.TELNYX_PUBLIC_KEY;
    if (!publicKeyEnv) {
      throw new Error("TELNYX_PUBLIC_KEY environment variable not set");
    }

    const signatureHeader = headers["telnyx-signature-ed25519"];
    const timestampHeader = headers["telnyx-timestamp"] as string | undefined;

    if (!signatureHeader) {
      throw new Error("missing telnyx-signature-ed25519 header");
    }

    const sig = Array.isArray(signatureHeader)
      ? Buffer.from(signatureHeader[0], "base64")
      : Buffer.from(signatureHeader, "base64");
    const pubKey = Buffer.from(publicKeyEnv, "base64");

    const event = Telnyx.webhooks.constructEvent(
      rawBody,
      sig,
      timestampHeader,
      pubKey,
    );

    return event as unknown as WebhookPayload;
  };
}

export function createWebhookHandler(verifyFn: VerifyFn = getVerifyFn()) {
  return function handleWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookResult {
    const startTime = Date.now();

    if (!rawBody || rawBody.trim().length === 0) {
      const latency_ms = Date.now() - startTime;
      log({ event: ASSISTANT_INITIALIZATION, node: NODE, latency_ms, outcome: "empty_body" });
      return { status: 400, body: { error: "empty request body" } };
    }

    let event: WebhookPayload;
    try {
      event = verifyFn(rawBody, headers);
    } catch {
      const latency_ms = Date.now() - startTime;
      log({ event: ASSISTANT_INITIALIZATION, node: NODE, latency_ms, outcome: "signature_invalid" });
      return { status: 400, body: { error: "signature verification failed" } };
    }

    if (!event?.data || event.data.event_type !== ASSISTANT_INITIALIZATION) {
      const latency_ms = Date.now() - startTime;
      log({ event: ASSISTANT_INITIALIZATION, node: NODE, latency_ms, outcome: "unexpected_event_type" });
      return { status: 400, body: { error: "unexpected event_type" } };
    }

    const payload = event.data.payload ?? {};
    const conversationId = payload.telnyx_conversation_id;
    const callControlId = payload.call_control_id;
    const verified = payload.telnyx_end_user_target_verified ?? false;

    const dynamic_variables: DynamicVariables = {
      session_id: conversationId ?? "",
      customer_name: "Demo Caller",
      caller_role: "new_caller",
      rental_found: false,
      verified,
      rental_status: "none",
      bookings_enabled: true,
    };

    const latency_ms = Date.now() - startTime;
    log({
      event: ASSISTANT_INITIALIZATION,
      telnyx_conversation_id: conversationId,
      call_control_id: callControlId,
      node: NODE,
      latency_ms,
      outcome: "ok",
    });

    const body: DynamicVariablesResponse = { dynamic_variables };
    return { status: 200, body };
  };
}

export function createServer(handler = createWebhookHandler()): http.Server {
  return http.createServer(async (req, res) => {
    if (req.url === "/health" || req.url?.startsWith("/health/")) {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" } as ErrorResponse));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");

    const result = handler(rawBody, req.headers);

    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(result.body ? JSON.stringify(result.body) : undefined);
  });
}

if (!process.env.VITEST) {
  const port = process.env.PORT || 8080;
  const server = createServer();
  server.listen(port, () => {
    console.log(`Dynamic variables webhook listening on port ${port}`);
  });
}
