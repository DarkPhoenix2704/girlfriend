// PID file management — shared by daemon.ts (write) and tui/index.ts (read).
// Kept separate so tui doesn't pull in grammy/baileys via daemon.ts imports.

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.env.HOME ?? ".", ".girlfriend");
export const PID_FILE = join(DATA_DIR, "daemon.pid");

export function writePid(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
}

export function clearPid(): void {
  try { unlinkSync(PID_FILE); } catch { /* already gone */ }
}

export function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  return isNaN(pid) ? null : pid;
}

export function isDaemonRunning(): boolean {
  const pid = readPid();
  if (pid == null) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
