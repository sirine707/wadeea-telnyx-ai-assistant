import type { LogEntry } from "./types";

export function log(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}
