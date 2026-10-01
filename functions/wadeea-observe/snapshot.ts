// Assembles one dashboard payload, stateless, per request:
// Telnyx REST logs (runtime + invocations per function) + the MCP /stats
// endpoint → parsed events → aggregated metrics. Stateless on purpose: every
// replica computes the same answer from the same shared sources.

import { parseLogLine, type WadeeaEvent } from "./parse_logs.js";
import { MetricsAggregator } from "./compute_metrics.js";
import { buildNodePath } from "./node_path.js";

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
  const MAX_PAGES = 8; // the API returns oldest-first; monitor-poll noise can fill whole pages
  await Promise.all(
    opts.funcs.flatMap((fn) =>
      (["runtime", "invocations"] as const).map(async (type) => {
        let from = start;
        for (let page = 0; page < MAX_PAGES; page++) {
          try {
            const url = `${base}/compute/funcs/${fn.id}/logs?type=${type}&start_time=${encodeURIComponent(from)}&limit=250`;
            const res = await doFetch(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
            if (!res.ok) break;
            const text = await res.text();
            events.push(...parseLogLine(fn.label, text));
            const body = JSON.parse(text) as { meta?: { has_more?: boolean }; data?: { timestamp?: string }[] };
            const last = body.data?.[body.data.length - 1]?.timestamp;
            if (!body.meta?.has_more || !last) break;
            from = new Date(new Date(last).getTime() + 1).toISOString();
          } catch {
            break; // one dead source must not take down the snapshot
          }
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

  // Node-execution trace per conversation, from the conversations API
  // (metadata.flow_node_id per message). Polling, not streaming — see
  // before_submission.md finding #2 for why.
  const flows: Record<string, string> = {};
  const auth = { headers: { Authorization: `Bearer ${opts.apiKey}` } };
  try {
    const cr = await doFetch(`${base}/ai/conversations?limit=4`, auth);
    if (cr.ok) {
      const convs = ((await cr.json()) as { data?: { id?: string }[] }).data ?? [];
      await Promise.all(
        convs.slice(0, 4).map(async (c) => {
          if (!c.id) return;
          try {
            const mr = await doFetch(`${base}/ai/conversations/${c.id}/messages`, auth);
            if (!mr.ok) return;
            const msgs = ((await mr.json()) as { data?: unknown[] }).data ?? [];
            const path = buildNodePath(msgs as never);
            if (path) flows[c.id] = path;
          } catch {
            // one conversation failing must not hide the rest
          }
        }),
      );
    }
  } catch {
    // conversations API unreachable — traces render without node paths
  }

  return { ...metrics.snapshot(), recent: real.slice(-300), stats, flows };
}
