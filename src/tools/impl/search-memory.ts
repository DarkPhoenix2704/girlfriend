import { searchMemories, listMemories } from "../../sessions.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  concurrent: true,
  schema: {
    name: "SearchMemory",
    description: `Search structured long-term memory facts. Use this to recall what you know about the user, their preferences, finances, contacts, etc.

Provide a query for full-text search, or leave it empty to list facts filtered by category/namespace.`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (full-text). Leave empty to list by category/namespace." },
        category: { type: "string", description: "Filter by category (e.g. 'finance', 'preference', 'stocks')" },
        namespace: { type: "string", description: "Filter by namespace (e.g. 'finance-agent')" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: [],
    },
  },

  execute(input, ctx) {
    const query = (input.query as string | undefined) ?? "";
    const options = {
      category: input.category as string | undefined,
      // Explicit namespace in input takes precedence; otherwise default to the caller's user namespace
      namespace: (input.namespace as string | undefined) ?? ctx.namespace,
      limit: input.limit as number | undefined,
    };

    const facts = query.trim()
      ? searchMemories(query, options)
      : listMemories(options);

    if (facts.length === 0) return { content: "No matching memories found." };

    const lines = facts.map((f) => {
      const meta = [f.category, f.namespace, f.confidence < 1 ? `confidence:${f.confidence.toFixed(2)}` : null]
        .filter(Boolean).join(" | ");
      return `[${f.key}] ${f.value}${meta ? `  (${meta})` : ""}  — ${f.updated_at}`;
    });

    return { content: lines.join("\n") };
  },
};
