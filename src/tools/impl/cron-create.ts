import { createCronJob, getCronJob } from "../../sessions.ts";
import { computeNextRun } from "../../scheduler.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "CronCreate",
    description: `Schedule a recurring task. The agent will run your prompt on the given cron schedule, independently and without user interaction.

Examples:
- "0 9 * * *"   → every day at 9am
- "0 9 * * 1"   → every Monday at 9am
- "*/30 * * * *" → every 30 minutes
- "0 8 1 * *"   → first of every month at 8am

The prompt should be self-contained — it will run without chat context.`,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique name for this job (e.g. 'morning-briefing', 'stock-check')" },
        cron_expr: { type: "string", description: "Cron expression (5 fields: min hour day month weekday)" },
        prompt: { type: "string", description: "The prompt the agent will run each time the job fires" },
      },
      required: ["name", "cron_expr", "prompt"],
    },
  },

  execute(input) {
    const name = input.name as string;
    const cronExpr = input.cron_expr as string;
    const prompt = input.prompt as string;

    if (getCronJob(name)) {
      return { content: `Error: a cron job named "${name}" already exists. Use CronUpdate to modify it.`, is_error: true };
    }

    const nextRun = computeNextRun(cronExpr);
    if (!nextRun) {
      return { content: `Error: invalid cron expression: "${cronExpr}"`, is_error: true };
    }

    createCronJob(name, cronExpr, prompt, nextRun);
    return { content: `Scheduled "${name}"  [${cronExpr}]  next run: ${nextRun}` };
  },
};
