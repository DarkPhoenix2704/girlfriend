// Cron scheduler — reads due jobs from DB, runs them as agent sessions.
// Called by daemon.ts on startup; also handles missed-job recovery.

import Anthropic from "@anthropic-ai/sdk";
import { Cron } from "croner";
import {
  getDueCronJobs, updateCronJob, createSession, appendMessages,
  addTokens, logEvent,
} from "./sessions.ts";
import type { CronJob } from "./sessions.ts";
import { runAgent } from "./agent.ts";
import { setActiveSession } from "./tools.ts";
import { log } from "./daemon-log.ts";

const MODEL = process.env.OPENCLAW_MODEL ?? "claude-sonnet-4-6";
const TICK_MS = 60_000; // check every 60 seconds

let _client: Anthropic | null = null;
let _tickInterval: ReturnType<typeof setInterval> | null = null;

function computeNextRun(cronExpr: string, after: Date = new Date()): string | null {
  try {
    const cron = new Cron(cronExpr, { paused: true });
    return cron.nextRun(after)?.toISOString() ?? null;
  } catch {
    return null;
  }
}

async function runCronJob(job: CronJob): Promise<void> {
  const now = new Date().toISOString();
  const sessionId = createSession(`cron:${job.name}`, MODEL, "cron");

  log("info", `cron firing: ${job.name}`, { sessionId });
  logEvent("cron_fired", { sessionId, name: job.name, input: job.prompt });

  try {
    setActiveSession(sessionId);
    const result = await runAgent(job.prompt, {
      client: _client!,
      model: MODEL,
      sessionId,
    });

    appendMessages(sessionId, result.history, 0);
    addTokens(sessionId, result.inputTokens, result.outputTokens);

    logEvent("cron_fired", {
      sessionId,
      name: job.name,
      output: result.text.slice(0, 500),
      tokensUsed: result.inputTokens + result.outputTokens,
    });

    log("info", `cron done: ${job.name}`, {
      sessionId,
      turns: result.turns,
      tokens: result.inputTokens + result.outputTokens,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("cron_fired", { sessionId, name: job.name, output: `ERROR: ${msg}` });
    log("error", `cron failed: ${job.name}`, { error: msg });
  } finally {
    const nextRun = computeNextRun(job.cron_expr);
    updateCronJob(job.name, { last_run: now, next_run: nextRun ?? undefined });
    setActiveSession(null);
  }
}

async function tick(): Promise<void> {
  const due = getDueCronJobs();
  if (due.length === 0) return;
  log("info", `scheduler: ${due.length} job(s) due`);
  // Run jobs sequentially to avoid overloading the API
  for (const job of due) {
    await runCronJob(job);
  }
}

/**
 * Start the scheduler. Immediately runs any missed/due jobs, then ticks every 60s.
 */
export function startScheduler(client: Anthropic): void {
  _client = client;
  // Immediate tick catches missed jobs from while daemon was offline
  tick().catch((err) => log("error", "scheduler tick error", { error: String(err) }));
  _tickInterval = setInterval(() => {
    tick().catch((err) => log("error", "scheduler tick error", { error: String(err) }));
  }, TICK_MS);
  log("info", "scheduler started", { tickMs: TICK_MS });
}

export function stopScheduler(): void {
  if (_tickInterval) {
    clearInterval(_tickInterval);
    _tickInterval = null;
    log("info", "scheduler stopped");
  }
}

/** Compute next_run for a new cron job expression. */
export { computeNextRun };
