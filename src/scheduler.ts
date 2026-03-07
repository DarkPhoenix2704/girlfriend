// Cron scheduler — reads due jobs from DB, runs them as agent sessions.
// Called by daemon.ts on startup; also handles missed-job recovery.

import Anthropic from "@anthropic-ai/sdk";
import { Cron } from "croner";
import {
  getDueCronJobs, updateCronJob, createSession, appendMessages,
  addTokens, logEvent, getCronJob, createCronJob,
} from "./sessions.ts";
import type { CronJob } from "./sessions.ts";
import { runAgent } from "./agent.ts";
import { log } from "./daemon-log.ts";
import { consolidate } from "./consolidator.ts";
import { loadConfig } from "./config.ts";

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
  }
}

async function tick(): Promise<void> {
  const due = getDueCronJobs();
  if (due.length === 0) return;
  log("info", `scheduler: ${due.length} job(s) due`);
  // Run jobs sequentially to avoid overloading the API
  for (const job of due) {
    if (job.name === "_consolidate") {
      await runConsolidationJob(job);
    } else {
      await runCronJob(job);
    }
  }
}

/** Register the nightly memory consolidation cron job if enabled in config. */
function ensureConsolidationJob(client: Anthropic): void {
  const cfg = loadConfig();
  if (!cfg.memory.consolidation_enabled) return;

  const CONSOLIDATION_JOB = "_consolidate";
  const schedule = cfg.memory.consolidation_schedule; // default "0 3 * * *"

  // Create only if it doesn't exist yet
  if (getCronJob(CONSOLIDATION_JOB)) return;

  const nextRun = computeNextRun(schedule);
  createCronJob(CONSOLIDATION_JOB, schedule, "__consolidate__", nextRun ?? undefined);
  log("info", "consolidation job registered", { schedule, nextRun });

  // Override runCronJob behaviour for this special job name handled below in tick()
  void client; // client is passed through _client already
}

/** Run the consolidation pass — used by the _consolidate special job. */
async function runConsolidationJob(job: CronJob): Promise<void> {
  const now = new Date().toISOString();
  log("info", "memory consolidation starting");
  try {
    const result = await consolidate(_client ?? undefined);
    log("info", "memory consolidation done", result);
    logEvent("tool_call", { name: "consolidator", output: `${result.factsUpserted} facts upserted` });
  } catch (err) {
    log("error", "memory consolidation failed", { error: String(err) });
  } finally {
    const nextRun = computeNextRun(job.cron_expr);
    updateCronJob(job.name, { last_run: now, next_run: nextRun ?? undefined });
  }
}

/**
 * Start the scheduler. Immediately runs any missed/due jobs, then ticks every 60s.
 */
export function startScheduler(client: Anthropic): void {
  _client = client;
  ensureConsolidationJob(client);
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
