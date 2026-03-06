// Main agent loop — streams API calls, executes tools, handles compaction, terminates when no tool_use.

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, wrapClaudeMd } from "./prompts.ts";
import { TOOL_SCHEMAS, executeTool, CONCURRENT_SAFE_TOOLS } from "./tools.ts";
import { maybeCompact } from "./compaction.ts";

export interface AgentOptions {
  /** Anthropic API client */
  client?: Anthropic;
  /** Model to use */
  model?: string;
  /** Working directory for tools */
  cwd?: string;
  /** Platform override */
  platform?: string;
  /** Shell override */
  shell?: string;
  /** CLAUDE.md content to inject before each user message */
  claudeMd?: string;
  /** CLAUDE.md file path (used in injection header) */
  claudeMdPath?: string;
  /** Tools to expose to the agent (subset of TOOL_SCHEMAS names) */
  tools?: string[];
  /** Max number of agent turns before stopping (0 = unlimited) */
  maxTurns?: number;
  /** Pre-existing conversation history (for multi-turn chat) */
  history?: Anthropic.MessageParam[];
  /** Files already read in a prior turn (for Edit tool continuity) */
  readFiles?: Set<string>;
  /** Called on each assistant message chunk (streaming) */
  onText?: (text: string) => void;
  /** Called when a tool is about to be executed */
  onToolUse?: (name: string, input: unknown) => void;
  /** Called with each tool result */
  onToolResult?: (name: string, result: string) => void;
  /** Called when compaction occurs */
  onCompact?: (summary: string) => void;
}

export interface AgentResult {
  /** Final assistant text response */
  text: string;
  /** Number of turns taken */
  turns: number;
  /** Total input tokens used */
  inputTokens: number;
  /** Total output tokens used */
  outputTokens: number;
  /** Whether compaction was triggered */
  compacted: boolean;
  /** Full conversation history after this turn (pass back in for multi-turn) */
  history: Anthropic.MessageParam[];
  /** Files read during this turn (pass back in for Edit tool continuity) */
  readFiles: Set<string>;
}

const MAX_RETRIES = 10;
const BASE_BACKOFF_MS = 500;    // doubles each attempt, capped at 32s
const MAX_BACKOFF_MS = 32_000;

function backoffMs(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return base * (1 + 0.25 * Math.random()); // +25% jitter
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Main agent loop.
 *
 * 1. Maybe compact messages (if >100k tokens used)
 * 2. Stream API call
 * 3. If any tool_use blocks → execute tools → append tool_results → continue
 * 4. If no tool_use → return final text
 */
export async function runAgent(
  prompt: string,
  options: AgentOptions = {}
): Promise<AgentResult> {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? "claude-sonnet-4-6";
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? (process.env.SHELL || "bash");
  const maxTurns = options.maxTurns ?? 0;

  const toolNames = options.tools ?? TOOL_SCHEMAS.map((t) => t.name);
  const activeTools = TOOL_SCHEMAS.filter((t) => toolNames.includes(t.name));

  const systemPrompt = buildSystemPrompt({
    tools: toolNames,
    cwd,
    platform,
    shell,
    model,
  });

  // Inject CLAUDE.md as <system-reminder> before the first user message only
  let userContent = prompt;
  if (options.claudeMd && !options.history?.length) {
    userContent =
      wrapClaudeMd(options.claudeMd, options.claudeMdPath ?? "CLAUDE.md") +
      "\n" +
      prompt;
  }

  // Start from prior history if provided (multi-turn chat)
  const messages: Anthropic.MessageParam[] = [
    ...(options.history ?? []),
    { role: "user", content: userContent },
  ];

  // Carry over read files from prior turns so Edit works across messages
  const readFiles = options.readFiles ?? new Set<string>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;
  let compacted = false;
  let finalText = "";

  while (true) {
    // Check turn limit
    if (maxTurns > 0 && turns >= maxTurns) {
      break;
    }

    // Maybe compact before API call
    const totalTokens = totalInputTokens + totalOutputTokens;
    const compactionResult = await maybeCompact(
      client,
      messages,
      systemPrompt,
      model,
      totalTokens
    );
    if (compactionResult.compacted) {
      messages.length = 0;
      messages.push(...compactionResult.messages);
      compacted = true;
      options.onCompact?.(compactionResult.summary ?? "");
    }

    // Streaming API call with retry
    let response!: Anthropic.Message;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: 8096,
          system: systemPrompt,
          tools: activeTools as Anthropic.Tool[],
          messages,
        });

        // Stream text deltas to caller in real time
        stream.on("text", (delta) => {
          finalText += delta;
          options.onText?.(delta);
        });

        response = await stream.finalMessage();
        break;
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        const isRetryable = status === 429 || status === 529 || status === 500 || status === 503;
        if (!isRetryable || attempt === MAX_RETRIES) throw err;
        await sleep(backoffMs(attempt));
      }
    }

    // Reset finalText — streaming already accumulated it above; don't double-count on retry
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    turns++;

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // Append assistant turn to messages
    messages.push({ role: "assistant", content: response.content });

    // Termination: no tool_use → done
    if (toolUseBlocks.length === 0) {
      break;
    }

    // Between turns, reset accumulated text so only the final turn text is returned
    finalText = "";

    // Execute tools — read-only tools run in parallel, mutating tools sequentially
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    const concurrent = toolUseBlocks.filter((b) => CONCURRENT_SAFE_TOOLS.includes(b.name));
    const sequential = toolUseBlocks.filter((b) => !CONCURRENT_SAFE_TOOLS.includes(b.name));

    const concurrentResults = await Promise.all(
      concurrent.map(async (block) => {
        options.onToolUse?.(block.name, block.input);
        const result = await executeTool(block.name, block.input, readFiles, cwd);
        options.onToolResult?.(block.name, result.content);
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: result.content,
          is_error: result.is_error,
        };
      })
    );
    toolResults.push(...concurrentResults);

    for (const block of sequential) {
      options.onToolUse?.(block.name, block.input);
      const result = await executeTool(block.name, block.input, readFiles, cwd);
      options.onToolResult?.(block.name, result.content);
      toolResults.push({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: result.content,
        is_error: result.is_error,
      });
    }

    // Append tool results as user turn
    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: finalText,
    turns,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    compacted,
    history: messages,
    readFiles,
  };
}
