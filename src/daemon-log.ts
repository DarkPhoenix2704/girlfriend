// Structured JSON logger for daemon mode.
// Writes to ~/.girlfriend/daemon.log (JSON lines) and stderr.

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const LOG_DIR = join(process.env.HOME ?? ".", ".girlfriend");
const LOG_PATH = join(LOG_DIR, "daemon.log");

let _enabled = false;

export function enableDaemonLog(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  _enabled = true;
}

export function log(
  level: "info" | "warn" | "error",
  msg: string,
  data: Record<string, unknown> = {}
): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  const line = JSON.stringify(entry);
  if (_enabled) {
    // Daemon mode — write to file only, keep terminal clean
    try { appendFileSync(LOG_PATH, line + "\n"); } catch { /* disk full etc */ }
  } else {
    // Foreground mode — write to stderr so the user can see output
    process.stderr.write(line + "\n");
  }
}
