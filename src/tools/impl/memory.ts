import { memorySet, memoryGet, memoryList, memoryDelete } from "../../sessions.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "Memory",
    description: `Persistent key-value memory that survives across sessions. Use this to remember user preferences, project context, decisions, or any facts worth recalling later.

Operations:
- set: Store a value under a key (upserts — overwrites if key exists)
- get: Retrieve a single value by key
- list: List all stored memories (no params needed)
- delete: Remove a memory by key`,
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["set", "get", "list", "delete"],
          description: "The memory operation to perform",
        },
        key: { type: "string", description: "The memory key (required for set, get, delete)" },
        value: { type: "string", description: "The value to store (required for set)" },
      },
      required: ["operation"],
    },
  },

  execute(input) {
    const op = input.operation as string;
    const key = input.key as string | undefined;
    const value = input.value as string | undefined;

    switch (op) {
      case "set": {
        if (!key) return { content: "<tool_use_error>key is required for set</tool_use_error>", is_error: true };
        if (!value) return { content: "<tool_use_error>value is required for set</tool_use_error>", is_error: true };
        memorySet(key, value);
        return { content: `Stored memory: ${key}` };
      }
      case "get": {
        if (!key) return { content: "<tool_use_error>key is required for get</tool_use_error>", is_error: true };
        const val = memoryGet(key);
        return val === null ? { content: `No memory found for key: ${key}` } : { content: val };
      }
      case "list": {
        const entries = memoryList();
        return entries.length === 0
          ? { content: "No memories stored." }
          : { content: entries.map((e) => `[${e.key}] ${e.value} (${e.updated_at})`).join("\n") };
      }
      case "delete": {
        if (!key) return { content: "<tool_use_error>key is required for delete</tool_use_error>", is_error: true };
        const deleted = memoryDelete(key);
        return { content: deleted ? `Deleted memory: ${key}` : `No memory found for key: ${key}` };
      }
      default:
        return { content: `<tool_use_error>Unknown operation: ${op}. Use set, get, list, or delete.</tool_use_error>`, is_error: true };
    }
  },
};
