import { updateCronJob, getCronJob } from "../../sessions.ts";
import { computeNextRun } from "../../scheduler.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "CronUpdate",
    description: "Update an existing cron job — change its schedule, prompt, or enable/disable it.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the cron job to update" },
        cron_expr: { type: "string", description: "New cron expression (e.g. '0 10 * * *')" },
        prompt: { type: "string", description: "New prompt text" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
      },
      required: ["name"],
    },
  },

  execute(input) {
    const name = input.name as string;
    const job = getCronJob(name);
    if (!job) {
      return { content: `No cron job found with name "${name}"`, is_error: true };
    }

    const updates: Parameters<typeof updateCronJob>[1] = {};

    if (input.cron_expr != null) {
      const cronExpr = input.cron_expr as string;
      const nextRun = computeNextRun(cronExpr);
      if (!nextRun) {
        return { content: `Error: invalid cron expression: "${cronExpr}"`, is_error: true };
      }
      updates.cron_expr = cronExpr;
      updates.next_run = nextRun;
    }

    if (input.prompt != null) updates.prompt = input.prompt as string;
    if (input.enabled != null) updates.enabled = (input.enabled as boolean) ? 1 : 0;

    if (Object.keys(updates).length === 0) {
      return { content: "Nothing to update — provide cron_expr, prompt, or enabled." };
    }

    updateCronJob(name, updates);
    const updated = getCronJob(name)!;
    return { content: `Updated "${name}"  [${updated.cron_expr}]  next: ${updated.next_run ?? "never"}  enabled: ${!!updated.enabled}` };
  },
};
