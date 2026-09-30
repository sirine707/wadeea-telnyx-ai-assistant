// Assembles one dashboard payload, stateless, per request:
// Telnyx REST logs (runtime + invocations per function) + the MCP /stats
// endpoint → parsed events → aggregated metrics. Stateless on purpose: every
// replica computes the same answer from the same shared sources.

import { parseLogLine, type WadeeaEvent } from "./parse_logs.js";
import { MetricsAggregator } from "./compute_metrics.js";

export interface WatchedFunc {
  id: string; // Telnyx function id
  label: string; // display label used as event.func
}

export interface SnapshotOptions {
  funcs: WatchedFunc[];
  statsUrl: string;
  apiKey: string;
  apiBase?: string; // default https://api.telnyx.com/v2
  sinceMs?: number; // default: last hour
  fetchImpl?: typeof fetch; // test seam
}

export async function buildSnapshot(opts: SnapshotOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? "https://api.telnyx.com/v2";
  const start = new Date(Date.now() - (opts.sinceMs ?? 3_600_000)).toISOString();

  const events: WadeeaEvent[] = [];
  await Promise.all(
    opts.funcs.flatMap((fn) =>
      (["runtime", "invocations"] as const).map(async (type) => {
        try {
          const url = `${base}/compute/funcs/${fn.id}/logs?type=${type}&start_time=${encodeURIComponent(start)}&limit=250`;
          const res = await doFetch(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
          if (res.ok) events.push(...parseLogLine(fn.label, await res.text()));
        } catch {
          // one dead source must not take down the snapshot
        }
      }),
    ),
  );
  // Monitoring self-traffic (our own /stats polling, platform health probes)
  // would otherwise drown out real tool traffic in every panel.
  const MONITOR_PATHS = new Set(["/health", "/stats"]);
  const real = events.filter((ev) => ev.kind !== "invocation" || !MONITOR_PATHS.has(ev.path));
  real.sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const metrics = new MetricsAggregator();
  for (const ev of real) metrics.add(ev);

  let stats: unknown = null;
  try {
    const res = await doFetch(opts.statsUrl, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) stats = await res.json();
  } catch {
    // /stats unreachable — dashboard simply hides the panel
  }

  return { ...metrics.snapshot(), recent: real.slice(-300), stats };
}
