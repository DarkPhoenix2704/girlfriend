// Daemon entry point — runs girlfriend 24/7 without TUI.
// Manages PID file, starts scheduler, handles graceful shutdown.
// Launched via: bun index.ts --daemon start

import Anthropic from "@anthropic-ai/sdk";
import { join } from "path";
import { startScheduler, stopScheduler } from "./scheduler.ts";
import { setTaskExecutor, setActiveRouter } from "./tools.ts";
import { createTaskExecutor } from "./subagent.ts";
import { listCronJobs } from "./sessions.ts";
import { enableDaemonLog, log } from "./daemon-log.ts";
import { GatewayRouter } from "./gateway/router.ts";
import { TelegramGateway } from "./gateway/telegram.ts";
import { WhatsAppGateway } from "./gateway/whatsapp.ts";
import { HttpServer } from "./gateway/http.ts";
import { initConfig, config, watchConfig } from "./config.ts";
import { writePid, clearPid, readPid, isDaemonRunning } from "./pid.ts";

export { readPid, isDaemonRunning } from "./pid.ts";

const DATA_DIR = join(process.env.HOME ?? ".", ".girlfriend");

// ─── Daemon start ─────────────────────────────────────────────────────────────

export async function startDaemon(): Promise<void> {
  if (isDaemonRunning()) {
    const pid = readPid();
    console.error(`daemon already running (pid ${pid})`);
    process.exit(1);
  }

  enableDaemonLog();
  initConfig();
  writePid();

  const MODEL = process.env.OPENCLAW_MODEL ?? config().model.default;
  log("info", "daemon starting", { pid: process.pid, model: MODEL });

  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const client = oauthToken
    ? new Anthropic({ authToken: oauthToken, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } })
    : new Anthropic();

  // Register task executor for subagents
  setTaskExecutor(async (input, cwd, callbacks, sessionId, namespace) => {
    const executor = createTaskExecutor(
      { Explore: { description: "Codebase exploration", prompt: "", tools: ["Read", "Glob", "Grep", "WebFetch"] } },
      { client, parentModel: MODEL, cwd, sessionId, namespace },
      callbacks,
    );
    return executor(input);
  });

  // Start gateways (env var takes precedence over config)
  const cfg = config();
  const router = new GatewayRouter(client);
  if (process.env.TELEGRAM_BOT_TOKEN && cfg.telegram.enabled) router.register(new TelegramGateway());
  if (cfg.whatsapp.enabled || process.env.WHATSAPP_ENABLED === "1") router.register(new WhatsAppGateway());
  await router.start();
  setActiveRouter(router);

  // Start HTTP server so TUI can connect to the daemon
  const httpToken = process.env.GIRLFRIEND_HTTP_TOKEN ?? null;
  const httpServer = cfg.http.enabled
    ? new HttpServer(router, cfg.http.port, httpToken)
    : null;
  httpServer?.start();

  // Hot-reload config.toml — currently logs the reload; future: re-register gateways
  const stopConfigWatch = watchConfig((newCfg) => {
    log("info", "config.toml reloaded", { model: newCfg.model.default });
  });

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, shutting down`);
    stopConfigWatch();
    stopScheduler();
    httpServer?.stop();
    await router.stop();
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
  <string>com.girlfriend.daemon</string>
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
    <string>YOUR_ANTHROPIC_API_KEY_HERE</string>
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
Description=girlfriend daemon
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} ${indexPath} --daemon start
Restart=always
RestartSec=10
Environment=ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY_HERE
WorkingDirectory=${process.cwd()}

[Install]
WantedBy=default.target`;
  console.log(unit);
}
