import { upsertMemory } from "../../sessions.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "RememberFact",
    description: `Store a structured fact into long-term memory. Facts persist across sessions and are searchable.
Use this to remember things about the user, their preferences, finances, habits, or any domain-specific knowledge.

Categories: 'preference', 'finance', 'stocks', 'calendar', 'contact', 'health', 'fact', 'reminder', or any custom label.
Namespace: optional scope (e.g. 'finance-agent', 'stocks-agent') for subagent-specific memory.
Confidence: 0.0–1.0, default 1.0. Use lower values for inferred/uncertain facts.`,
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Unique key for this fact within its namespace (e.g. 'user.risk_tolerance')" },
        value: { type: "string", description: "The fact to store" },
        category: { type: "string", description: "Category label for filtering (e.g. 'finance', 'preference')" },
        namespace: { type: "string", description: "Optional subagent namespace to scope this fact" },
        confidence: { type: "number", description: "Confidence 0.0–1.0 (default 1.0)" },
      },
      required: ["key", "value"],
    },
  },

  execute(input) {
    const key = input.key as string;
    const value = input.value as string;
    upsertMemory(key, value, {
      category: input.category as string | undefined,
      namespace: input.namespace as string | undefined,
      confidence: input.confidence as number | undefined,
    });
    return { content: `Remembered: [${key}] ${value}` };
  },
};
