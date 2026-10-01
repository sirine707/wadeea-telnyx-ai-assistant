const ARG_KEYS = ["category_id", "start_date", "duration_days", "visitor_type", "booking_id"] as const;
const RESULT_KEYS = ["available", "units_available", "total_cents", "currency", "booking_id", "status", "idempotent", "reason", "error"] as const;

export function summarizeToolIO(args: unknown, resultText: string | null): { args?: Record<string, unknown>; result?: Record<string, unknown> } {
  const out: { args?: Record<string, unknown>; result?: Record<string, unknown> } = {};

  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const src = args as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const k of ARG_KEYS) {
      if (k in src) filtered[k] = src[k];
    }
    if (Object.keys(filtered).length > 0) out.args = filtered;
  }

  if (resultText && resultText.length > 0) {
    try {
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      if (Array.isArray(parsed)) {
        // List results (documents, rules): the useful summary is how many.
        out.result = { count: parsed.length };
        return out;
      }
      const filtered: Record<string, unknown> = {};
      for (const k of RESULT_KEYS) {
        if (k in parsed) filtered[k] = parsed[k];
      }
      if (Object.keys(filtered).length > 0) out.result = filtered;
    } catch {
      out.result = { error: resultText.slice(0, 120) };
    }
  }

  return out;
}
