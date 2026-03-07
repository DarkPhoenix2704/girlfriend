import Anthropic from "@anthropic-ai/sdk";
import { runApp } from "./src/tui.ts";
import { createSession, listSessions, getSession, deleteSession, formatAge, listCronJobs, listMemories } from "./src/sessions.ts";
import {
  startDaemon, stopDaemon, daemonStatus,
  printLaunchdPlist, printSystemdUnit,
} from "./src/daemon.ts";
import { isDaemonRunning, readPid } from "./src/pid.ts";

// ─── Auth ──────────────────────────────────────────────────────────────────────
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const client = oauthToken
  ? new Anthropic({ authToken: oauthToken, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } })
  : new Anthropic();

const MODEL = "claude-sonnet-4-6";
const cwd = process.cwd();

const dim  = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red  = (s: string) => `\x1b[31m${s}\x1b[0m`;


// ─── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

// ─── Status ────────────────────────────────────────────────────────────────────
if (args.includes("--status")) {
  const running = isDaemonRunning();
  const pid = readPid();
  const sessions = listSessions(9999);
  const crons = listCronJobs();
  const memories = listMemories({});

  console.log(bold("\n  girlfriend status\n"));
  console.log(`  daemon      ${running ? `running  (pid ${pid})` : dim("not running")}`);
  console.log(`  sessions    ${sessions.length}`);
  console.log(`  cron jobs   ${crons.length} (${crons.filter(j => j.enabled).length} enabled)`);
  console.log(`  memories    ${memories.length} facts`);

  if (crons.length > 0) {
    console.log(bold("\n  scheduled jobs\n"));
    for (const j of crons) {
      const status = j.enabled ? "" : dim(" [disabled]");
      const next = j.next_run ? `  next ${dim(j.next_run.slice(0, 16))}` : "";
      console.log(`  ${bold(j.name.padEnd(20))} ${j.cron_expr.padEnd(15)}${next}${status}`);
    }
  }

  if (sessions.length > 0) {
    console.log(bold("\n  recent sessions\n"));
    for (const s of sessions.slice(0, 5)) {
      console.log(`  ${bold(String(s.id).padStart(3))}  ${s.name.padEnd(32)}${dim(`${formatAge(s.updated_at).padEnd(12)} ${s.message_count} msgs`)}`);
    }
  }
  console.log();
  process.exit(0);
}

// ─── Daemon subcommands ────────────────────────────────────────────────────────
const daemonIdx = args.indexOf("--daemon");
if (daemonIdx !== -1) {
  const sub = args[daemonIdx + 1];
  switch (sub) {
    case "start":   await startDaemon(); break;
    case "stop":    stopDaemon(); break;
    case "status":  daemonStatus(); break;
    case "restart": stopDaemon(); await startDaemon(); break;
    case "plist":   printLaunchdPlist(); break;
    case "systemd": printSystemdUnit(); break;
    default:
      console.error("usage: --daemon start|stop|status|restart|plist|systemd");
      process.exit(1);
  }
  process.exit(0);
}

if (args.includes("--list")) {
  const sessions = listSessions(50);
  console.log(bold("\n  sessions\n"));
  for (const s of sessions) {
    console.log(`  ${bold(String(s.id).padStart(3))}  ${s.name.padEnd(32)}${dim(`${formatAge(s.updated_at).padEnd(12)} ${s.message_count} msgs`)}`);
  }
  console.log();
  process.exit(0);
}

const deleteIdx = args.indexOf("--delete");
if (deleteIdx !== -1) {
  const id = parseInt(args[deleteIdx + 1] ?? "");
  if (isNaN(id)) { console.error("usage: --delete <id>"); process.exit(1); }
  const s = getSession(id);
  if (!s) { console.error(`session ${id} not found`); process.exit(1); }
  deleteSession(id);
  console.log(red(`deleted session ${id}`));
  process.exit(0);
}

let initialSessionId: number | undefined;

const resumeIdx = args.indexOf("--resume");
if (resumeIdx !== -1) {
  const id = parseInt(args[resumeIdx + 1] ?? "");
  if (isNaN(id) || !getSession(id)) { console.error(`session ${id} not found`); process.exit(1); }
  initialSessionId = id;
}

const newIdx = args.indexOf("--new");
if (newIdx !== -1) {
  const nextArg = args[newIdx + 1];
  const name = nextArg && !nextArg.startsWith("--")
    ? nextArg
    : `session-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  initialSessionId = createSession(name, MODEL);
}

await runApp({ client, model: MODEL, cwd, initialSessionId });
process.exit(0);
