import { searchMessages } from "../../sessions.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  concurrent: true,
  schema: {
    name: "SearchHistory",
    description: `Full-text search over all past conversation messages across all sessions.
Use this to recall what was discussed previously — past tasks, decisions, context, user instructions.

Returns matching messages with session name, role, timestamp, and a content snippet.`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text search query" },
        session_id: { type: "number", description: "Restrict search to a specific session ID" },
        role: { type: "string", enum: ["user", "assistant"], description: "Filter by message role" },
        since: { type: "string", description: "ISO date string — only return messages after this date (e.g. '2025-01-01')" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },

  execute(input) {
    const results = searchMessages(input.query as string, {
      sessionId: input.session_id as number | undefined,
      role: input.role as string | undefined,
      since: input.since as string | undefined,
      limit: input.limit as number | undefined,
    });

    if (results.length === 0) return { content: "No matching messages found." };

    const lines = results.map((r) => {
      // Content is stored as JSON (array of blocks or string) — extract readable text
      let text = r.content;
      try {
        const parsed = JSON.parse(r.content);
        if (typeof parsed === "string") {
          text = parsed;
        } else if (Array.isArray(parsed)) {
          text = parsed
            .filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
            .map((b: { text: string }) => b.text)
            .join(" ");
        }
      } catch { /* leave as-is */ }

      const preview = text.slice(0, 200).replace(/\n+/g, " ");
      return `[session:${r.session_id} "${r.session_name}" | ${r.role} | ${r.created_at}]\n  ${preview}`;
    });

    return { content: lines.join("\n\n") };
  },
};
