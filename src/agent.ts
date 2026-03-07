// Main agent loop — streams API calls, executes tools, handles compaction, terminates when no tool_use.

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./prompts.ts";
import { TOOL_SCHEMAS, executeTool, CONCURRENT_SAFE_TOOLS } from "./tools.ts";
import type { SubagentCallbacks } from "./tools/types.ts";
import { maybeCompact, compact } from "./compaction.ts";
import { withRetry } from "./retry.ts";
import { logEvent } from "./sessions.ts";

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
  /** Serialised memory facts to inject into the system prompt */
  memories?: string;
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
  onToolUse?: (name: string, input: unknown, id: string) => void;
  /** Called with each tool result */
  onToolResult?: (name: string, result: string, id: string) => void;
  /** Called when compaction occurs */
  onCompact?: (summary: string) => void;
  /** Called after each API response with current rate-limit headers */
  onRateLimit?: (info: RateLimitInfo) => void;
  /** Abort signal — abort() cancels the current stream and throws */
  signal?: AbortSignal;
  /** Session ID for event logging */
  sessionId?: number | null;
  /** AskUser callback — wires up the AskUserQuestion tool for interactive sessions. */
  askUser?: (question: string, options?: string[]) => Promise<string>;
}

export interface RateLimitInfo {
  // Standard API key limits (per-minute)
  requestsRemaining: number | null;
  inputTokensRemaining: number | null;
  outputTokensRemaining: number | null;
  // OAuth unified limits (utilization 0–1, reset = unix timestamp)
  unified5hUtilization: number | null;
  unified5hReset: number | null;
  unified7dUtilization: number | null;
  unifiedStatus: string | null;
  unifiedFallback: string | null;
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



/**
 * Main agent loop.
 *
 * 1. Maybe compact messages (if >50k tokens used)
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

  const sessionId = options.sessionId ?? null;
  const askUser = options.askUser;

  // Per-call context passed into executeTool — no module-level globals needed
  const subagentCallbacks: SubagentCallbacks = {
    onToolUse: options.onToolUse,
    onToolResult: options.onToolResult,
  };

  const toolNames = options.tools ?? TOOL_SCHEMAS.map((t) => t.name);
  const activeTools = TOOL_SCHEMAS.filter((t) => toolNames.includes(t.name));

  const systemPrompt = buildSystemPrompt({
    tools: toolNames,
    cwd,
    platform,
    shell,
    model,
    claudeMd: options.claudeMd,
    claudeMdPath: options.claudeMdPath,
    memories: options.memories,
  });

  const userContent = prompt;
  // Log incoming message to events
  logEvent("message_received", {
    sessionId: options.sessionId,
    name: "user",
    input: userContent.slice(0, 500),
  });
  // Start from prior history if provided (multi-turn chat)
  const messages: Anthropic.MessageParam[] = [
    ...(options.history ?? []),
    { role: "user", content: userContent },
  ];

  // Carry over read files from prior turns so Edit works across messages
  const readFiles = options.readFiles ?? new Set<string>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // lastContextSize tracks the actual context window usage (last turn's input_tokens),
  // NOT a cumulative sum — cumulative would grow O(n²) since every turn re-counts all history.
  let lastContextSize = 0;
  let turns = 0;
  let compacted = false;
  let finalText = "";

  while (true) {
    // Check turn limit
    if (maxTurns > 0 && turns >= maxTurns) {
      break;
    }

    // Compact when the actual context size approaches the limit
    const compactionResult = await maybeCompact(
      client,
      messages,
      systemPrompt,
      model,
      lastContextSize
    );
    if (compactionResult.compacted) {
      messages.length = 0;
      messages.push(...compactionResult.messages);
      compacted = true;
      lastContextSize = 0;
      options.onCompact?.(compactionResult.summary ?? "");
    }

    // Streaming API call with retry (400 "prompt too long" triggers forced compaction + retry)
    let forcedCompaction = false;
    const response = await withRetry(async () => {
      finalText = "";
      const cachedTools = activeTools.length > 0
        ? [
            ...activeTools.slice(0, -1),
            { ...activeTools[activeTools.length - 1]!, cache_control: { type: "ephemeral" as const } },
          ] as Anthropic.Tool[]
        : [] as Anthropic.Tool[];
      const stream = client.messages.stream({
        model,
        max_tokens: 8192,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        tools: cachedTools,
        messages,
      }, { signal: options.signal });

      stream.on("text", (delta) => {
        finalText += delta;
        options.onText?.(delta);
      });

      const msg = await stream.finalMessage();
      if (options.onRateLimit) {
        const h = stream.response?.headers;
        const num = (k: string) => h ? (parseInt(h.get(k) ?? "") || null) : null;
        const str = (k: string) => h?.get(k) ?? null;
        const flt = (k: string) => h ? (parseFloat(h.get(k) ?? "") || null) : null;
        options.onRateLimit({
          requestsRemaining:    num("anthropic-ratelimit-requests-remaining"),
          inputTokensRemaining: num("anthropic-ratelimit-input-tokens-remaining"),
          outputTokensRemaining:num("anthropic-ratelimit-output-tokens-remaining"),
          unified5hUtilization: flt("anthropic-ratelimit-unified-5h-utilization"),
          unified5hReset:       num("anthropic-ratelimit-unified-5h-reset"),
          unified7dUtilization: flt("anthropic-ratelimit-unified-7d-utilization"),
          unifiedStatus:        str("anthropic-ratelimit-unified-status"),
          unifiedFallback:      str("anthropic-ratelimit-unified-fallback"),
        });
      }
      return msg;
    }, {
      maxRetries: 10, maxMs: 32_000,
      isRetryable: (err) => {
        const status = (err as { status?: number }).status;
        if (status === 400) {
          const msg = String((err as { message?: string }).message ?? "");
          if (msg.includes("prompt is too long") && !forcedCompaction) {
            // Force compaction now and signal retry
            forcedCompaction = true;
            return true;
          }
        }
        return status === 429 || status === 529 || status === 500 || status === 503;
      },
      onBeforeRetry: async (err) => {
        const status = (err as { status?: number }).status;
        const msg = String((err as { message?: string }).message ?? "");
        if (status === 400 && msg.includes("prompt is too long")) {
          // Compact immediately regardless of token threshold
          const summary = await compact(client, messages, systemPrompt, model);
          messages.length = 0;
          messages.push({ role: "user", content: summary });
          compacted = true;
          totalInputTokens = 0;
          totalOutputTokens = 0;
          lastContextSize = 0;
          options.onCompact?.(summary);
        }
      },
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    // Track actual context size for compaction decisions (not cumulative)
    lastContextSize = response.usage.input_tokens + response.usage.output_tokens;
    turns++;

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    messages.push({ role: "assistant", content: response.content });

    if (toolUseBlocks.length === 0) {
      break;
    }

    // Execute tools — read-only tools run in parallel, mutating tools sequentially
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    const concurrent = toolUseBlocks.filter((b) => CONCURRENT_SAFE_TOOLS.includes(b.name));
    const sequential = toolUseBlocks.filter((b) => !CONCURRENT_SAFE_TOOLS.includes(b.name));

    const concurrentResults = await Promise.all(
      concurrent.map(async (block) => {
        options.onToolUse?.(block.name, block.input, block.id);
        const result = await executeTool(block.name, block.input, readFiles, cwd, subagentCallbacks, sessionId, askUser);
        options.onToolResult?.(block.name, result.content, block.id);
        // Accumulate subagent tokens (Task tool carries them in the result)
        totalInputTokens += result.inputTokens ?? 0;
        totalOutputTokens += result.outputTokens ?? 0;
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
      options.onToolUse?.(block.name, block.input, block.id);
      const result = await executeTool(block.name, block.input, readFiles, cwd, subagentCallbacks, sessionId, askUser);
      options.onToolResult?.(block.name, result.content, block.id);
      totalInputTokens += result.inputTokens ?? 0;
      totalOutputTokens += result.outputTokens ?? 0;
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
