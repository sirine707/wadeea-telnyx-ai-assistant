// Self-contained types for the dynamic-variables Edge Function.
// The shipping archive contains only this directory, so nothing here may
// import from ../../lib (see ADR 0002 — builder fails on external paths).

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

export interface KvReader {
  getJson<T = unknown>(key: string): Promise<T | null>;
  getText(key: string): Promise<string | null>;
}
