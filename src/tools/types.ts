import type { Tool } from "@anthropic-ai/sdk/resources/messages";

export type ToolInput = Record<string, unknown>;
export type ToolResult = {
  content: string;
  is_error?: boolean;
  /** Tokens consumed by a subagent task — bubbles up so the session total is accurate. */
  inputTokens?: number;
  outputTokens?: number;
};

/** Callbacks forwarded from the main agent into subagents so the TUI sees their tool calls. */
export interface SubagentCallbacks {
  onToolUse?: (name: string, input: unknown, id: string) => void;
  onToolResult?: (name: string, result: string, id: string) => void;
}

export interface ToolContext {
  readFiles: Set<string>;
  cwd: string;
  /** Session ID for event logging — threaded per-call to avoid module-level global collisions. */
  sessionId?: number | null;
  /** Caller's namespace for scoping memories (e.g. "telegram:12345"). Undefined for local/cron. */
  namespace?: string;
  /** Task executor — receives per-call callbacks so subagent events reach the right stream. */
  taskExecutor?: (input: ToolInput, cwd: string, callbacks?: SubagentCallbacks, sessionId?: number | null, namespace?: string) => Promise<ToolResult>;
  /** Ask the user a question (with optional choices) and await their reply (TUI only). */
  askUser?: (question: string, options?: string[]) => Promise<string>;
  /** Streaming callbacks from the parent agent — passed through to subagents. */
  subagentCallbacks?: SubagentCallbacks;
}

export interface ToolDefinition {
  schema: Tool;
  /** If true, safe to run concurrently alongside other concurrent tools */
  concurrent?: boolean;
  execute: (input: ToolInput, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
