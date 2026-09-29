import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VerifyFn, WebhookPayload } from "../../../lib/types";
import { createWebhookHandler } from "../index";

function makePayload(overrides: Partial<WebhookPayload["data"]["payload"]> = {}): WebhookPayload {
  return {
    data: {
      record_type: "event",
      id: "event_123",
      event_type: "assistant.initialization",
      occurred_at: "2026-09-25T10:00:00Z",
      payload: {
        telnyx_conversation_id: "conv_abc123",
        call_control_id: "v3:call_control_id",
        telnyx_end_user_target: "+971500000000",
        telnyx_end_user_target_verified: false,
        telnyx_agent_target: "+971400000000",
        telnyx_conversation_channel: "phone_call",
        assistant_id: "assistant_123",
        ...overrides,
      },
    },
  };
}

function makeVerifyFn(payload: WebhookPayload): VerifyFn {
  return () => payload;
}

function makeFailingVerifyFn(error: Error): VerifyFn {
  return () => {
    throw error;
  };
}

describe("createWebhookHandler", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe("happy path", () => {
    it("returns 200 with 7 dynamic variables on valid assistant.initialization", () => {
      const payload = makePayload();
      const handler = createWebhookHandler(makeVerifyFn(payload));
      const result = handler(JSON.stringify(payload), {});

      expect(result.status).toBe(200);
      expect(result.body).toBeDefined();
      const body = (result.body as unknown) as { dynamic_variables: Record<string, unknown> };
      const dv = body.dynamic_variables;

      expect(Object.keys(dv)).toHaveLength(7);
      expect(dv.session_id).toBe("conv_abc123");
      expect(dv.customer_name).toBe("Demo Caller");
      expect(dv.caller_role).toBe("new_caller");
      expect(dv.rental_found).toBe(false);
      expect(dv.verified).toBe(false);
      expect(dv.rental_status).toBe("none");
      expect(dv.bookings_enabled).toBe(true);
    });

    it("passes through telnyx_end_user_target_verified as verified", () => {
      const payload = makePayload({ telnyx_end_user_target_verified: true });
      const handler = createWebhookHandler(makeVerifyFn(payload));
      const result = handler(JSON.stringify(payload), {});
      const body = result.body as { dynamic_variables: { verified: boolean } };

      expect(result.status).toBe(200);
      expect(body.dynamic_variables.verified).toBe(true);
    });

    it("defaults verified to false when telnyx_end_user_target_verified is absent", () => {
      const payload = makePayload({ telnyx_end_user_target_verified: undefined });
      const handler = createWebhookHandler(makeVerifyFn(payload));
      const result = handler(JSON.stringify(payload), {});
      const body = result.body as { dynamic_variables: { verified: boolean } };

      expect(result.status).toBe(200);
      expect(body.dynamic_variables.verified).toBe(false);
    });

    it("sets session_id to telnyx_conversation_id", () => {
      const payload = makePayload({ telnyx_conversation_id: "conv_xyz" });
      const handler = createWebhookHandler(makeVerifyFn(payload));
      const result = handler(JSON.stringify(payload), {});
      const body = result.body as { dynamic_variables: { session_id: string } };

      expect(body.dynamic_variables.session_id).toBe("conv_xyz");
    });

    it("sets session_id to empty string when telnyx_conversation_id is absent (no fabrication)", () => {
      const payload = makePayload({ telnyx_conversation_id: undefined });
      const handler = createWebhookHandler(makeVerifyFn(payload));
      const result = handler(JSON.stringify(payload), {});
      const body = result.body as { dynamic_variables: { session_id: string } };

      expect(body.dynamic_variables.session_id).toBe("");
    });
  });

  describe("signature verification", () => {
    it("returns 400 when signature verification throws", () => {
      const handler = createWebhookHandler(makeFailingVerifyFn(new Error("bad signature")));
      const result = handler('{"data":{}}', {});

      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toBe("signature verification failed");
    });

    it("returns 400 for empty body", () => {
      const handler = createWebhookHandler(makeVerifyFn(makePayload()));
      const result = handler("", {});

      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toBe("empty request body");
    });

    it("returns 400 for whitespace-only body", () => {
      const handler = createWebhookHandler(makeVerifyFn(makePayload()));
      const result = handler("   \n  ", {});

      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toBe("empty request body");
    });
  });

  describe("event type validation", () => {
    it("returns 400 when event_type is not assistant.initialization", () => {
      const payload = makePayload();
      payload.data.event_type = "message.finalized";
      const handler = createWebhookHandler(makeVerifyFn(payload));
      const result = handler(JSON.stringify(payload), {});

      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toBe("unexpected event_type");
    });

    it("returns 400 when data is nullish", () => {
      const verifyFn = (() => ({ data: null })) as unknown as VerifyFn;
      const handler = createWebhookHandler(verifyFn);
      const result = handler("{}", {});

      expect(result.status).toBe(400);
    });
  });

  describe("logging", () => {
    it("logs a structured JSON entry with required fields on success", () => {
      const payload = makePayload();
      const handler = createWebhookHandler(makeVerifyFn(payload));
      handler(JSON.stringify(payload), {});

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.event).toBe("assistant.initialization");
      expect(logged.telnyx_conversation_id).toBe("conv_abc123");
      expect(logged.call_control_id).toBe("v3:call_control_id");
      expect(logged.node).toBe("dynamic-variables");
      expect(logged.outcome).toBe("ok");
      expect(typeof logged.latency_ms).toBe("number");
      expect(logged.latency_ms).toBeGreaterThanOrEqual(0);
    });

    it("logs outcome=signature_invalid on failed verification", () => {
      const handler = createWebhookHandler(makeFailingVerifyFn(new Error("bad")));
      handler('{"data":{}}', {});

      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.outcome).toBe("signature_invalid");
      expect(logged.node).toBe("dynamic-variables");
    });

    it("logs outcome=empty_body for empty request", () => {
      const handler = createWebhookHandler(makeVerifyFn(makePayload()));
      handler("", {});

      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.outcome).toBe("empty_body");
    });

    it("logs outcome=unexpected_event_type for wrong event_type", () => {
      const payload = makePayload();
      payload.data.event_type = "other";
      const handler = createWebhookHandler(makeVerifyFn(payload));
      handler(JSON.stringify(payload), {});

      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(logged.outcome).toBe("unexpected_event_type");
    });

    it("latency_ms is a non-negative number in every log entry", () => {
      const handler = createWebhookHandler(makeVerifyFn(makePayload()));
      handler(JSON.stringify(makePayload()), {});

      const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(typeof logged.latency_ms).toBe("number");
      expect(logged.latency_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe("bookings_enabled as feature flag", () => {
    it("bookings_enabled is a boolean", () => {
      const payload = makePayload();
      const handler = createWebhookHandler(makeVerifyFn(payload));
      const result = handler(JSON.stringify(payload), {});
      const body = result.body as { dynamic_variables: { bookings_enabled: unknown } };

      expect(typeof body.dynamic_variables.bookings_enabled).toBe("boolean");
    });
  });
});
