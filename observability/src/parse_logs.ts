// STEP 2 of the pipeline: read_logs → parse_logs → compute_metrics → serve_dashboard.
// Turns raw `telnyx-edge logs --json` output into typed events. Handles both
// shapes the CLI emits: a single record per line (--tail --json) and a
// { meta, data: [...] } envelope (plain --json backfill). Pure — no I/O.

export type RuntimeEvent = {
  kind: "runtime";
  func: string;
  ts: string;
  structured: Record<string, unknown> | null;
  raw: string;
};

export type InvocationEvent = {
  kind: "invocation";
  func: string;
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  region: string;
};

export type WadeeaEvent = RuntimeEvent | InvocationEvent;

function toEvent(func: string, rec: Record<string, unknown>): WadeeaEvent | null {
  if (rec.record_type === "compute_func_runtime_log") {
    const raw = typeof rec.message === "string" ? rec.message : "";
    let structured: Record<string, unknown> | null = null;
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) structured = parsed;
      } catch {
        structured = null;
      }
    }
    return { kind: "runtime", func, ts: String(rec.timestamp ?? ""), structured, raw };
  }
  if (rec.record_type === "compute_func_invocation_log") {
    return {
      kind: "invocation",
      func,
      ts: String(rec.timestamp ?? ""),
      method: String(rec.method ?? ""),
      path: String(rec.path ?? ""),
      status: Number(rec.status_code ?? 0),
      durationMs: Number(rec.duration_ms ?? 0),
      region: String(rec.region ?? ""),
    };
  }
  return null;
}

export function parseLogLine(func: string, line: string): WadeeaEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (obj === null || typeof obj !== "object") return [];
  const rec = obj as Record<string, unknown>;
  const records: Record<string, unknown>[] = Array.isArray(rec.data)
    ? (rec.data as Record<string, unknown>[])
    : [rec];
  const events: WadeeaEvent[] = [];
  for (const r of records) {
    const ev = toEvent(func, r);
    if (ev) events.push(ev);
  }
  return events;
}
