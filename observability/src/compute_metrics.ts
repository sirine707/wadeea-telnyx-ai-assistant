// STEP 3 of the pipeline: read_logs → parse_logs → compute_metrics → serve_dashboard.
// Turns parsed log events into what the dashboard shows:
//   1. per-function counters + latency percentiles  (the metric cards)
//   2. alerts with a "what to check first" hint     (the alerts strip)
//   3. events grouped by telnyx_conversation_id     (the call-trace panel)

import type { WadeeaEvent, RuntimeEvent, InvocationEvent } from "./parse_logs";

export interface Alert {
  ts: string;
  func: string;
  type: "non_2xx" | "bad_outcome" | "slow_webhook";
  detail: string;
  hint: string;
}

export interface FuncMetrics {
  requests: number;
  errors: number;
  errorRate: number;
  p50: number | null; // invocation duration_ms (what the platform measured)
  p95: number | null;
  appP50: number | null; // structured latency_ms (what our code measured)
  appP95: number | null;
  lastTs: string | null;
}

export interface TraceStep {
  ts: string;
  func: string;
  event: string;
  detail: Record<string, unknown>;
}

export interface ConversationTrace {
  conversationId: string;
  firstTs: string;
  steps: TraceStep[];
}

// Keep memory bounded: oldest entries drop off first.
const MAX_SAMPLES = 500;
const MAX_ALERTS = 100;
const MAX_TRACES = 50;

const SLOW_WEBHOOK_MS = 1500; // half the 3000ms dynamic_variables_webhook_timeout_ms budget

const OUTCOME_HINTS: Record<string, string> = {
  signature_invalid:
    "Ed25519 verification failing — check the TELNYX_PUBLIC_KEY secret on the webhook function",
  unexpected_event_type: "Telnyx sent a non-initialization event — check assistant webhook config",
  timeout: "CallSession actor exceeded its 1200ms fence — check actor health / snapshot bucket",
  error: "webhook handler threw — read runtime logs for the stack",
};

function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function pushCapped<T>(arr: T[], value: T, max: number): void {
  arr.push(value);
  if (arr.length > max) arr.shift();
}

interface FuncState {
  requests: number;
  errors: number;
  durations: number[]; // invocation duration_ms samples
  appLatency: number[]; // structured latency_ms samples
  lastTs: string | null;
}

export class MetricsAggregator {
  private funcs = new Map<string, FuncState>();
  private traces = new Map<string, ConversationTrace>();
  private alerts: Alert[] = [];

  // Feed one event in; get back any alerts it triggered.
  add(ev: WadeeaEvent): Alert[] {
    const state = this.stateFor(ev.func);
    state.lastTs = ev.ts;
    const alerts =
      ev.kind === "invocation" ? this.addInvocation(ev, state) : this.addRuntime(ev, state);
    for (const a of alerts) pushCapped(this.alerts, a, MAX_ALERTS);
    return alerts;
  }

  // Invocation record = one HTTP request as the platform saw it.
  private addInvocation(ev: InvocationEvent, state: FuncState): Alert[] {
    state.requests += 1;
    pushCapped(state.durations, ev.durationMs, MAX_SAMPLES);
    if (ev.status < 400) return [];
    state.errors += 1;
    return [
      {
        ts: ev.ts,
        func: ev.func,
        type: "non_2xx",
        detail: `${ev.method} ${ev.path} → ${ev.status}`,
        hint: "replay the request with curl; if booking_failed, check the snapshot bucket / run the janitor",
      },
    ];
  }

  // Runtime line = our own console.log; only structured JSON lines carry signals.
  private addRuntime(ev: RuntimeEvent, state: FuncState): Alert[] {
    const st = ev.structured;
    if (!st) return [];
    const alerts: Alert[] = [];

    if (typeof st.latency_ms === "number") {
      pushCapped(state.appLatency, st.latency_ms, MAX_SAMPLES);
      if (st.latency_ms >= SLOW_WEBHOOK_MS) {
        alerts.push({
          ts: ev.ts,
          func: ev.func,
          type: "slow_webhook",
          detail: `latency_ms=${st.latency_ms} (budget 3000)`,
          hint: "approaching dynamic_variables_webhook_timeout_ms — check actor fence / SQLDB latency",
        });
      }
    }

    for (const key of ["outcome", "session_outcome"] as const) {
      const value = st[key];
      if (typeof value === "string" && value !== "ok") {
        alerts.push({
          ts: ev.ts,
          func: ev.func,
          type: "bad_outcome",
          detail: `${key}=${value}`,
          hint: OUTCOME_HINTS[value] ?? "read the surrounding runtime log lines",
        });
      }
    }

    const convId = st.telnyx_conversation_id;
    if (typeof convId === "string" && convId) {
      let trace = this.traces.get(convId);
      if (!trace) {
        trace = { conversationId: convId, firstTs: ev.ts, steps: [] };
        this.traces.set(convId, trace);
        // Map keeps insertion order, so the first key is the oldest trace.
        if (this.traces.size > MAX_TRACES) {
          this.traces.delete(this.traces.keys().next().value as string);
        }
      }
      trace.steps.push({
        ts: ev.ts,
        func: ev.func,
        event: typeof st.event === "string" ? st.event : "log",
        detail: st,
      });
    }

    return alerts;
  }

  private stateFor(func: string): FuncState {
    let s = this.funcs.get(func);
    if (!s) {
      s = { requests: 0, errors: 0, durations: [], appLatency: [], lastTs: null };
      this.funcs.set(func, s);
    }
    return s;
  }

  // Everything the browser needs to render, in one object.
  snapshot(): { funcs: Record<string, FuncMetrics>; conversations: ConversationTrace[]; alerts: Alert[] } {
    const funcs: Record<string, FuncMetrics> = {};
    for (const [name, s] of this.funcs) {
      funcs[name] = {
        requests: s.requests,
        errors: s.errors,
        errorRate: s.requests === 0 ? 0 : s.errors / s.requests,
        p50: percentile(s.durations, 50),
        p95: percentile(s.durations, 95),
        appP50: percentile(s.appLatency, 50),
        appP95: percentile(s.appLatency, 95),
        lastTs: s.lastTs,
      };
    }
    return {
      funcs,
      conversations: [...this.traces.values()].sort((a, b) => (a.firstTs < b.firstTs ? 1 : -1)),
      alerts: [...this.alerts],
    };
  }
}
