import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "Task",
    description: `Launch a subagent to complete a focused, self-contained task. Use for long-running, independent work that shouldn't clutter the main context. The subagent runs its own agent loop with restricted tools and returns a summary when done.`,
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short label for the task (shown in UI)" },
        prompt: { type: "string", description: "Full task description sent to the subagent" },
        subagent_type: { type: "string", description: "Named subagent definition to use. Use 'Explore' for codebase research." },
      },
      required: ["description", "prompt"],
    },
  },

  async execute(input, { cwd, taskExecutor }) {
    if (!taskExecutor) {
      return { content: "<tool_use_error>Task executor not configured — setTaskExecutor() must be called at startup before using the Task tool</tool_use_error>", is_error: true };
    }
    return taskExecutor(input, cwd);
  },
};
