import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "AskUserQuestion",
    description: "Ask the user a clarifying question and wait for their response. Optionally provide a list of choices — the user can select one or write a custom message. Use when you genuinely need input before proceeding.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to present to the user",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of suggested answers the user can choose from. Always include a free-text fallback — the TUI adds 'Write custom message' automatically.",
        },
      },
      required: ["question"],
    },
  },
  async execute(input, ctx) {
    const question = input.question as string;
    const options = Array.isArray(input.options) ? (input.options as string[]) : undefined;
    if (!ctx.askUser) {
      // Non-interactive context — surface question as text so the caller can relay it
      const optionsStr = options?.length ? `\nOptions: ${options.join(", ")}` : "";
      return { content: `(question for user: ${question}${optionsStr})` };
    }
    const answer = await ctx.askUser(question, options);
    return { content: answer };
  },
};
