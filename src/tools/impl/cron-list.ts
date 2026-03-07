import { listCronJobs } from "../../sessions.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  concurrent: true,
  schema: {
    name: "CronList",
    description: "List all scheduled cron jobs with their expressions, next run time, and enabled status.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  execute() {
    const jobs = listCronJobs();
    if (jobs.length === 0) return { content: "No cron jobs scheduled." };

    const lines = jobs.map((j) => {
      const status = j.enabled ? "enabled" : "disabled";
      const next = j.next_run ?? "never";
      const last = j.last_run ?? "never";
      return `${j.enabled ? "●" : "○"}  ${j.name.padEnd(24)} [${j.cron_expr}]  next: ${next}  last: ${last}  (${status})`;
    });

    return { content: `Cron jobs (${jobs.length}):\n\n${lines.join("\n")}` };
  },
};
