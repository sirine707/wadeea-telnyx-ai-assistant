// In-memory per-instance tool-call stats behind GET /stats: the instant
// observability signal (a data-plane read, no log-ingestion delay). Counters
// reset when the instance restarts — by design; durable records live in SQLDB.
// Never stores tool arguments: no PII.

export interface ToolCallRecord {
  ts: string;
  tool: string;
  ok: boolean;
  latency_ms: number;
  conversation_id?: string;
}

export interface StatsSnapshot {
  instance_id: string;
  started_at: string;
  tool_calls: Record<string, number>;
  tool_errors: Record<string, number>;
  recent: ToolCallRecord[];
}

const MAX_RECENT = 50;

export class StatsRecorder {
  private readonly instanceId = Math.random().toString(36).slice(2, 10);
  private readonly startedAt = new Date().toISOString();
  private calls: Record<string, number> = {};
  private errors: Record<string, number> = {};
  private recent: ToolCallRecord[] = [];

  record(tool: string, ok: boolean, latencyMs: number, conversationId?: string): void {
    this.calls[tool] = (this.calls[tool] ?? 0) + 1;
    if (!ok) this.errors[tool] = (this.errors[tool] ?? 0) + 1;
    this.recent.push({
      ts: new Date().toISOString(),
      tool,
      ok,
      latency_ms: latencyMs,
      conversation_id: conversationId,
    });
    if (this.recent.length > MAX_RECENT) this.recent.shift();
  }

  snapshot(): StatsSnapshot {
    return {
      instance_id: this.instanceId,
      started_at: this.startedAt,
      tool_calls: { ...this.calls },
      tool_errors: { ...this.errors },
      recent: [...this.recent],
    };
  }
}

// Reads the tool name and Telnyx-injected conversation id off a tools/call
// request body. Returns null for anything that is not a tool call.
export function getToolCallInfo(body: unknown): { tool: string; conversationId: string | undefined } | null {
  if (body === null || typeof body !== "object") return null;
  const req = body as { method?: unknown; params?: { name?: unknown; _meta?: { telnyx_conversation_id?: unknown } } };
  if (req.method !== "tools/call" || typeof req.params?.name !== "string") return null;
  const convId = req.params._meta?.telnyx_conversation_id;
  return { tool: req.params.name, conversationId: typeof convId === "string" ? convId : undefined };
}
