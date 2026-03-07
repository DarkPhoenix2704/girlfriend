import { queryEvents } from "../../sessions.ts";
import type { EventType } from "../../sessions.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  concurrent: true,
  schema: {
    name: "GetEvents",
    description: `Query the audit event log — a chronological record of everything the agent has done.
Covers tool calls, cron job fires, incoming messages, subagent runs, and compactions.

Use this to answer questions like:
- "What did you do yesterday?"
- "When did the stocks cron last run?"
- "What tools did you use in session 42?"`,
    input_schema: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "Filter by session ID" },
        type: {
          type: "string",
          enum: ["tool_call", "cron_fired", "message_received", "subagent_run", "compaction"],
          description: "Filter by event type",
        },
        name: { type: "string", description: "Filter by event name (tool name, cron name, etc.) — partial match" },
        since: { type: "string", description: "ISO datetime — only events after this (e.g. '2025-03-01')" },
        until: { type: "string", description: "ISO datetime — only events before this" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: [],
    },
  },

  execute(input) {
    const events = queryEvents({
      sessionId: input.session_id as number | undefined,
      type: input.type as EventType | undefined,
      name: input.name as string | undefined,
      since: input.since as string | undefined,
      until: input.until as string | undefined,
      limit: input.limit as number | undefined,
    });

    if (events.length === 0) return { content: "No events found matching those filters." };

    const lines = events.map((e) => {
      const parts = [`[${e.created_at}] ${e.type}${e.name ? `: ${e.name}` : ""}`];
      if (e.session_id) parts.push(`session:${e.session_id}`);
      if (e.tokens_used) parts.push(`${e.tokens_used} tokens`);
      if (e.output) parts.push(`→ ${e.output.slice(0, 120)}`);
      return parts.join("  ");
    });

    return { content: lines.join("\n") };
  },
};
