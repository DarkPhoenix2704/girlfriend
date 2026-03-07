// Daemon entry point — runs openclaw 24/7 without TUI.
// Manages PID file, starts scheduler, handles graceful shutdown.
// Launched via: bun index.ts --daemon start

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { startScheduler, stopScheduler } from "./scheduler.ts";
import { setTaskExecutor } from "./tools.ts";
import { createTaskExecutor } from "./subagent.ts";
import { listCronJobs } from "./sessions.ts";
import { enableDaemonLog, log } from "./daemon-log.ts";

const DATA_DIR = join(process.env.HOME ?? ".", ".openclaw");
const PID_FILE = join(DATA_DIR, "daemon.pid");
const MODEL = process.env.OPENCLAW_MODEL ?? "claude-sonnet-4-6";

// ─── PID file management ──────────────────────────────────────────────────────

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
  try {
    process.kill(pid, 0); // signal 0 = check existence only
    return true;
  } catch {
    return false;
  }
}

// ─── Daemon start ─────────────────────────────────────────────────────────────

export async function startDaemon(): Promise<void> {
  if (isDaemonRunning()) {
    const pid = readPid();
    console.error(`daemon already running (pid ${pid})`);
    process.exit(1);
  }

  enableDaemonLog();
  writePid();

  log("info", "daemon starting", { pid: process.pid, model: MODEL });

  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const client = oauthToken
    ? new Anthropic({ authToken: oauthToken, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } })
    : new Anthropic();

  // Register task executor for subagents
  setTaskExecutor(async (input, cwd) => {
    const executor = createTaskExecutor(
      { Explore: { description: "Codebase exploration", prompt: "", tools: ["Read", "Glob", "Grep", "WebFetch"] } },
      { client, parentModel: MODEL, cwd }
    );
    const result = await executor(input);
    return { content: result };
  });

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, shutting down`);
    stopScheduler();
    clearPid();
    log("info", "daemon stopped");
    process.exit(0);
  }

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const jobs = listCronJobs();
  log("info", `daemon ready`, { cronJobs: jobs.length });

  // Start the cron scheduler (runs indefinitely)
  startScheduler(client);

  // Keep process alive
  await new Promise<void>(() => { /* never resolves — daemon runs until signal */ });
}

// ─── CLI subcommand handlers ──────────────────────────────────────────────────

export function daemonStatus(): void {
  if (isDaemonRunning()) {
    const pid = readPid();
    console.log(`daemon running  (pid ${pid})`);
  } else {
    console.log("daemon not running");
  }
}

export function stopDaemon(): void {
  const pid = readPid();
  if (pid == null || !isDaemonRunning()) {
    console.log("daemon not running");
    return;
  }
  process.kill(pid, "SIGTERM");
  console.log(`sent SIGTERM to pid ${pid}`);
}

export function printLaunchdPlist(): void {
  const bunPath = Bun.which("bun") ?? "/usr/local/bin/bun";
  const indexPath = join(process.cwd(), "index.ts");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${indexPath}</string>
    <string>--daemon</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTHROPIC_API_KEY</key>
    <string>${process.env.ANTHROPIC_API_KEY ?? "YOUR_KEY_HERE"}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${DATA_DIR}/launchd-stderr.log</string>
  <key>WorkingDirectory</key>
  <string>${process.cwd()}</string>
</dict>
</plist>`;
  console.log(plist);
}

export function printSystemdUnit(): void {
  const bunPath = Bun.which("bun") ?? "/usr/local/bin/bun";
  const indexPath = join(process.cwd(), "index.ts");
  const unit = `[Unit]
Description=openclaw daemon
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} ${indexPath} --daemon start
Restart=always
RestartSec=10
Environment=ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? "YOUR_KEY_HERE"}
WorkingDirectory=${process.cwd()}

[Install]
WantedBy=default.target`;
  console.log(unit);
}
