import type { Tool } from "@anthropic-ai/sdk/resources/messages";

export type ToolInput = Record<string, unknown>;
export type ToolResult = { content: string; is_error?: boolean };

export interface ToolContext {
  readFiles: Set<string>;
  cwd: string;
  taskExecutor?: (input: ToolInput, cwd: string) => Promise<ToolResult>;
}

export interface ToolDefinition {
  schema: Tool;
  /** If true, safe to run concurrently alongside other concurrent tools */
  concurrent?: boolean;
  execute: (input: ToolInput, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
