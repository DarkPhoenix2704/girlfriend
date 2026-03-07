import { deleteMemory } from "../../sessions.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "ForgetFact",
    description: "Remove a fact from long-term memory by its key (and optional namespace).",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The key of the fact to delete" },
        namespace: { type: "string", description: "Namespace of the fact (if it was stored with one)" },
      },
      required: ["key"],
    },
  },

  execute(input, ctx) {
    // Explicit namespace in input takes precedence; otherwise default to the caller's user namespace
    const namespace = (input.namespace as string | undefined) ?? ctx.namespace;
    const deleted = deleteMemory(input.key as string, namespace);
    return {
      content: deleted
        ? `Forgot: ${input.key}${namespace ? ` (namespace: ${namespace})` : ""}`
        : `No fact found for key: ${input.key}`,
    };
  },
};
