// STEP 1b of the pipeline (the instant path): polls the MCP function's
// GET /stats every 2 seconds. A data-plane read straight from the running
// instance — no log-ingestion delay. Fails silent: until /stats is shipped
// (or if it's unreachable) the dashboard simply doesn't show the panel.

export interface StatsPoller {
  stop(): void;
}

export function pollStats(url: string, onSnapshot: (snap: unknown) => void, intervalMs = 2_000): StatsPoller {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (res.ok) onSnapshot(await res.json());
    } catch {
      // endpoint absent, slow, or offline — nothing to show this tick
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
