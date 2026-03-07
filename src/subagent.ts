// Subagent support — recursive agent loops with restricted tools and a separate system prompt.
// Subagents cannot spawn their own subagents (depth check prevents infinite recursion).

import Anthropic from "@anthropic-ai/sdk";
import { SUBAGENT_SYSTEM_PROMPT, buildSubagentNotes } from "./prompts.ts";
import { TOOL_SCHEMAS, executeTool, CONCURRENT_SAFE_TOOLS } from "./tools.ts";
import type { SubagentCallbacks } from "./tools/types.ts";
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
  callbacks?: SubagentCallbacks;
  sessionId?: number | null; // parent session — used for event logging, no separate subagent session
}

const MAX_SUBAGENT_DEPTH = 1;

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
export interface SubagentResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function runSubagent(
  taskPrompt: string,
  definition: SubagentDefinition,
  options: SubagentRunOptions
): Promise<SubagentResult> {
  const depth = options.depth ?? 0;
  if (depth > MAX_SUBAGENT_DEPTH) {
    return { text: "<tool_use_error>Maximum subagent nesting depth reached.</tool_use_error>", inputTokens: 0, outputTokens: 0 };
  }
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
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let turn = 0; turn < 50; turn++) {
    const cachedTools = activeTools.length > 0
      ? [
          ...activeTools.slice(0, -1),
          { ...activeTools[activeTools.length - 1]!, cache_control: { type: "ephemeral" as const } },
        ] as Anthropic.Tool[]
      : [] as Anthropic.Tool[];
    const response = await withRetry(() =>
      client.messages.create({
        model,
        max_tokens: 8192,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        tools: cachedTools,
        messages,
      })
    );

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    result = textBlocks.map((b) => b.text).join("");
    messages.push({ role: "assistant", content: response.content });

    if (toolUseBlocks.length === 0) break;

    // Emit subagent tool events so TUI can show live progress
    const cbs = options.callbacks;

    // Execute tools (same concurrency split as main agent)
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    const concurrent = toolUseBlocks.filter((b) => CONCURRENT_SAFE_TOOLS.includes(b.name));
    const sequential = toolUseBlocks.filter((b) => !CONCURRENT_SAFE_TOOLS.includes(b.name));

    const concurrentResults = await Promise.all(
      concurrent.map(async (block) => {
        cbs?.onToolUse?.(block.name, block.input, `sub:${block.id}`);
        const res = await executeTool(block.name, block.input, readFiles, options.cwd, undefined, options.sessionId);
        cbs?.onToolResult?.(block.name, res.content, `sub:${block.id}`);
        return { type: "tool_result" as const, tool_use_id: block.id, content: res.content, is_error: res.is_error };
      })
    );
    toolResults.push(...concurrentResults);

    for (const block of sequential) {
      cbs?.onToolUse?.(block.name, block.input, `sub:${block.id}`);
      const res = await executeTool(block.name, block.input, readFiles, options.cwd);
      cbs?.onToolResult?.(block.name, res.content, `sub:${block.id}`);
      toolResults.push({ type: "tool_result" as const, tool_use_id: block.id, content: res.content, is_error: res.is_error });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { text: result, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

/**
 * Creates a Task tool executor bound to a set of subagent definitions.
 * Returns an executeTool-compatible function for the Task tool.
 */
export function createTaskExecutor(
  agents: Record<string, SubagentDefinition>,
  options: Omit<SubagentRunOptions, "depth">,
  callbacks?: SubagentCallbacks,
) {
  return async (input: unknown): Promise<import("./tools/types.ts").ToolResult> => {
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
      model: "haiku" as const,
    };

    try {
      const r = await runSubagent(prompt, definition, { ...options, depth: 1, callbacks });
      return {
        content: r.text || "(subagent completed with no output)",
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      };
    } catch (err) {
      return { content: `Subagent error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  };
}
