// Subagent support — recursive agent loops with restricted tools and a separate system prompt.
// Subagents cannot spawn their own subagents (depth check prevents infinite recursion).

import Anthropic from "@anthropic-ai/sdk";
import { SUBAGENT_SYSTEM_PROMPT, buildSubagentNotes } from "./prompts.ts";
import { TOOL_SCHEMAS, executeTool, CONCURRENT_SAFE_TOOLS } from "./tools.ts";
import { withRetry } from "./retry.ts";

export interface SubagentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: "sonnet" | "opus" | "haiku" | "inherit";
}

export interface SubagentRunOptions {
  client: Anthropic;
  parentModel: string;
  cwd: string;
  depth?: number; // recursion depth — subagents cannot spawn subagents (depth > 0 → no Task tool)
}

const MODEL_MAP: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

/**
 * Runs a subagent with a given task prompt and definition.
 *
 * Differences from the main agent:
 * - Uses a focused system prompt, not the full multi-section one
 * - Tool set is restricted to definition.tools
 * - depth > 0 prevents spawning nested subagents (no Task tool)
 */
export async function runSubagent(
  taskPrompt: string,
  definition: SubagentDefinition,
  options: SubagentRunOptions
): Promise<string> {
  const depth = options.depth ?? 0;
  const client = options.client;

  // Model resolution — "inherit" keeps parent model
  let model = options.parentModel;
  if (definition.model && definition.model !== "inherit") {
    model = MODEL_MAP[definition.model] ?? options.parentModel;
  }

  // Build restricted tool list (exclude Task at depth > 0 to prevent infinite recursion)
  const allowedToolNames = (definition.tools ?? TOOL_SCHEMAS.map((t) => t.name)).filter(
    (name) => depth === 0 || name !== "Task"
  );
  const activeTools = TOOL_SCHEMAS.filter((t) => allowedToolNames.includes(t.name));

  // Subagent system prompt
  const systemPrompt =
    SUBAGENT_SYSTEM_PROMPT + "\n" + buildSubagentNotes(options.cwd, model);

  // If a custom agent prompt is defined, inject it as a system-level instruction
  const fullPrompt = definition.prompt
    ? `<instructions>\n${definition.prompt}\n</instructions>\n\n${taskPrompt}`
    : taskPrompt;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: fullPrompt },
  ];

  const readFiles = new Set<string>();
  let result = "";

  for (let turn = 0; turn < 50; turn++) {
    const response = await withRetry(() =>
      client.messages.create({ model, max_tokens: 8192, system: systemPrompt, tools: activeTools as Anthropic.Tool[], messages })
    );

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    result = textBlocks.map((b) => b.text).join("");
    messages.push({ role: "assistant", content: response.content });

    if (toolUseBlocks.length === 0) break;

    // Execute tools (same concurrency split as main agent)
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    const concurrent = toolUseBlocks.filter((b) => CONCURRENT_SAFE_TOOLS.includes(b.name));
    const sequential = toolUseBlocks.filter((b) => !CONCURRENT_SAFE_TOOLS.includes(b.name));

    const concurrentResults = await Promise.all(
      concurrent.map(async (block) => {
        const res = await executeTool(block.name, block.input, readFiles, options.cwd);
        return { type: "tool_result" as const, tool_use_id: block.id, content: res.content, is_error: res.is_error };
      })
    );
    toolResults.push(...concurrentResults);

    for (const block of sequential) {
      const res = await executeTool(block.name, block.input, readFiles, options.cwd);
      toolResults.push({ type: "tool_result" as const, tool_use_id: block.id, content: res.content, is_error: res.is_error });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return result;
}

/**
 * Creates a Task tool executor bound to a set of subagent definitions.
 * Returns an executeTool-compatible function for the Task tool.
 */
export function createTaskExecutor(
  agents: Record<string, SubagentDefinition>,
  options: Omit<SubagentRunOptions, "depth">
) {
  return async (input: unknown): Promise<string> => {
    const { description, prompt, subagent_type } = input as {
      description: string;
      prompt: string;
      subagent_type?: string;
    };

    const key = subagent_type ?? "default";
    const definition = agents[key] ?? {
      description,
      prompt: "",
      tools: ["Read", "Glob", "Grep", "WebFetch"],
    };

    try {
      const result = await runSubagent(prompt, definition, { ...options, depth: 1 });
      return result || "(subagent completed with no output)";
    } catch (err) {
      return `Subagent error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}
