// STEP 1 of the pipeline: read_logs → parse_logs → compute_metrics → serve_dashboard.
// Gets raw log lines by shelling out to `telnyx-edge logs` (read-only — nothing
// here writes to the platform). Backfill reads a window of history; tail streams
// live lines and restarts itself if the CLI exits.

import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WatchedFunc {
  name: string; // telnyx-edge function name
  label: string; // short display label used as event.func
}

export async function backfillLines(func: WatchedFunc, type: "runtime" | "invocations"): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "telnyx-edge",
      ["logs", func.name, "--type", type, "--json", "--since", "1h", "-n", "250"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
    // Plain --json emits one envelope object (pretty-printed) — hand it over whole.
    return [stdout];
  } catch (err) {
    console.error(`[observe] backfill ${func.name}/${type} failed: ${(err as Error).message}`);
    return [];
  }
}

export interface TailHandle {
  stop(): void;
}

export function tail(func: WatchedFunc, onLine: (line: string) => void, restartDelayMs = 5_000): TailHandle {
  let stopped = false;
  let current: ReturnType<typeof spawn> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const start = () => {
    if (stopped) return;
    const child = spawn("telnyx-edge", ["logs", func.name, "--tail", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    current = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.trim()) onLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf8").trim();
      if (msg) console.error(`[observe] tail ${func.name}: ${msg}`);
    });
    child.on("exit", (code) => {
      current = null;
      if (stopped) return;
      console.error(`[observe] tail ${func.name} exited (${code}); restarting in ${restartDelayMs}ms`);
      timer = setTimeout(start, restartDelayMs);
    });
  };
  start();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      current?.kill();
    },
  };
}
