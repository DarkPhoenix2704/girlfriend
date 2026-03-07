import { deleteCronJob, updateCronJob, getCronJob } from "../../sessions.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "CronDelete",
    description: "Delete or disable a scheduled cron job by name. Use disable=true to pause it without losing the schedule.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the cron job to delete or disable" },
        disable: { type: "boolean", description: "If true, disable the job instead of deleting it (default: false — permanently deletes)" },
      },
      required: ["name"],
    },
  },

  execute(input) {
    const name = input.name as string;
    const disable = (input.disable as boolean | undefined) ?? false;

    if (!getCronJob(name)) {
      return { content: `No cron job found with name "${name}"`, is_error: true };
    }

    if (disable) {
      updateCronJob(name, { enabled: 0 });
      return { content: `Disabled cron job "${name}". Use CronUpdate to re-enable it.` };
    }

    deleteCronJob(name);
    return { content: `Deleted cron job "${name}".` };
  },
};
