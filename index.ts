// agent-claw: Interactive streaming agent REPL with persistent sessions
//
// Usage:
//   bun index.ts                     → interactive session picker
//   bun index.ts --new [name]        → start a named new session
//   bun index.ts --session <id>      → resume session
//   bun index.ts --list              → print sessions and exit
//   bun index.ts --delete <id>       → delete session and exit
//
// Auth:
//   ANTHROPIC_API_KEY=sk-ant-...
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

import Anthropic from "@anthropic-ai/sdk";
import { select, input, confirm } from "@inquirer/prompts";
import { runAgent } from "./src/agent.ts";
import {
  createSession, listSessions, getSession, deleteSession, renameSession,
  saveReadFiles, loadReadFiles, appendMessages, loadMessages, addTokens, formatAge,
} from "./src/sessions.ts";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ─── Auth ──────────────────────────────────────────────────────────────────────
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const client = oauthToken
  ? new Anthropic({ authToken: oauthToken, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } })
  : new Anthropic();

const MODEL = "claude-sonnet-4-6";
const cwd = process.cwd();

// ─── CLAUDE.md ────────────────────────────────────────────────────────────────
function loadClaudeMd(dir: string) {
  for (const p of [join(dir, "CLAUDE.md"), join(dir, ".claude", "CLAUDE.md")]) {
    if (existsSync(p)) return { content: readFileSync(p, "utf-8"), path: p };
  }
  return null;
}
const claudeMdFile = loadClaudeMd(cwd);

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const dim    = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold   = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan   = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red    = (s: string) => `\x1b[31m${s}\x1b[0m`;

// ─── Session picker ───────────────────────────────────────────────────────────
async function pickSession(): Promise<number> {
  const sessions = listSessions(20);

  const NEW_SESSION = "__new__";

  const choices = [
    { name: dim("+ new session"), value: NEW_SESSION, short: "new" },
    ...sessions.map((s) => ({
      name: `${bold(String(s.id).padStart(3))}  ${s.name.padEnd(32)}${dim(`${formatAge(s.updated_at).padEnd(10)}  ${s.message_count} msgs`)}`,
      value: String(s.id),
      short: s.name,
    })),
  ];

  const choice = await select({
    message: "session",
    choices,
    pageSize: 15,
  });

  if (choice === NEW_SESSION) {
    const name = await input({
      message: "session name",
      default: `session-${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    });
    return createSession(name, MODEL);
  }

  return parseInt(choice);
}

// ─── CLI args ──────────────────────────────────────────────────────────────────
async function resolveSessionId(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    const sessions = listSessions(50);
    console.log(bold("\n  sessions\n"));
    for (const s of sessions) {
      console.log(`  ${bold(String(s.id).padStart(3))}  ${s.name.padEnd(32)}${dim(`${formatAge(s.updated_at).padEnd(12)} ${s.message_count} msgs  ${s.total_input_tokens}↑${s.total_output_tokens}↓`)}`);
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
    const ok = await confirm({ message: `delete "${s.name}" (#${id})?` });
    if (ok) { deleteSession(id); console.log(red(`deleted session ${id}`)); }
    process.exit(0);
  }

  const sessionIdx = args.indexOf("--session");
  if (sessionIdx !== -1) {
    const id = parseInt(args[sessionIdx + 1] ?? "");
    if (isNaN(id) || !getSession(id)) { console.error(`session ${id} not found`); process.exit(1); }
    return id;
  }

  const newIdx = args.indexOf("--new");
  if (newIdx !== -1) {
    const nextArg = args[newIdx + 1];
    const name = nextArg && !nextArg.startsWith("--")
      ? nextArg
      : `session-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    return createSession(name, MODEL);
  }

  return await pickSession();
}

// ─── Main REPL ────────────────────────────────────────────────────────────────
const sessionId = await resolveSessionId();
const session = getSession(sessionId)!;

let history = loadMessages(sessionId);
let readFiles = loadReadFiles(sessionId);

console.log(`\n${bold("agent-claw")} ${dim(`· #${sessionId} · ${session.name} · ${history.length} messages`)}`);
if (claudeMdFile) console.log(dim(`CLAUDE.md: ${claudeMdFile.path}`));
console.log(dim('type "exit" to quit · /sessions /new /rename /reset\n'));

// ─── REPL loop ────────────────────────────────────────────────────────────────
while (true) {
  let userInput: string;
  try {
    userInput = await input({ message: "you" });
  } catch {
    // Ctrl+C / Ctrl+D
    break;
  }

  const trimmed = userInput.trim();
  if (!trimmed) continue;
  if (trimmed === "exit" || trimmed === "quit") break;

  // ── in-session commands ──
  if (trimmed === "/sessions") {
    const all = listSessions(20);
    console.log();
    for (const s of all) {
      const marker = s.id === sessionId ? green("▶") : " ";
      console.log(` ${marker} ${bold(String(s.id).padStart(3))}  ${s.name.padEnd(32)}${dim(`${formatAge(s.updated_at).padEnd(10)} ${s.message_count} msgs`)}`);
    }
    console.log();
    continue;
  }

  if (trimmed.startsWith("/new")) {
    const name = trimmed.slice(4).trim() ||
      `session-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const newId = createSession(name, MODEL);
    console.log(green(`created #${newId} "${name}" — resume: bun index.ts --session ${newId}\n`));
    continue;
  }

  if (trimmed.startsWith("/rename")) {
    const name = trimmed.slice(7).trim();
    if (name) { renameSession(sessionId, name); console.log(green(`renamed to "${name}"\n`)); }
    continue;
  }

  if (trimmed === "/reset") {
    history = [];
    readFiles = new Set();
    console.log(dim("in-memory history cleared\n"));
    continue;
  }

  // ── agent turn ──
  const historyLenBefore = history.length;
  process.stdout.write("\n" + cyan("agent ") + dim("·") + " ");

  try {
    const result = await runAgent(trimmed, {
      client,
      model: MODEL,
      cwd,
      platform: process.platform,
      shell: process.env.SHELL || "bash",
      claudeMd: claudeMdFile?.content,
      claudeMdPath: claudeMdFile?.path,
      history,
      readFiles,
      onText: (text) => process.stdout.write(text),
      onToolUse: (name, inp) => {
        const preview = JSON.stringify(inp).slice(0, 72);
        process.stdout.write(`\n${yellow(`  [${name}]`)} ${dim(preview)}\n${cyan("agent ")}${dim("·")} `);
      },
      onToolResult: (_name, res) => {
        const preview = res.slice(0, 120).replace(/\n/g, " ");
        process.stdout.write(`\n${dim(`  → ${preview}${res.length > 120 ? "…" : ""}`)}\n${cyan("agent ")}${dim("·")} `);
      },
      onCompact: () => {
        process.stdout.write(dim("\n  [context compacted]\n") + cyan("agent ") + dim("· "));
      },
    });

    // Persist to DB
    appendMessages(sessionId, result.history, historyLenBefore);
    saveReadFiles(sessionId, result.readFiles);
    addTokens(sessionId, result.inputTokens, result.outputTokens);

    history = result.history;
    readFiles = result.readFiles;

    process.stdout.write(`\n\n${dim(`turns:${result.turns}  ${result.inputTokens}↑${result.outputTokens}↓`)}\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\n${red(`error: ${msg}`)}\n\n`);
  }
}

saveReadFiles(sessionId, readFiles);
console.log(dim(`\nsession #${sessionId} saved.\n`));
process.exit(0);
