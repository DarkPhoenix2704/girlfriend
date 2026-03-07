// Auto-builds TOOL_SCHEMAS, CONCURRENT_SAFE_TOOLS, and executeTool from the tool registry.
// Never edit this file when adding tools — edit impl/index.ts instead.

import { resolve } from "path";
import * as impls from "./impl/index.ts";
import type { ToolDefinition, ToolContext } from "./types.ts";
import { logEvent } from "../sessions.ts";

export type { ToolInput, ToolResult, ToolContext, ToolDefinition } from "./types.ts";

const allDefs = Object.values(impls);
const registry = new Map<string, ToolDefinition>(allDefs.map((d) => [d.schema.name, d]));
if (registry.size !== allDefs.length) {
  const names = allDefs.map((d) => d.schema.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  throw new Error(`Duplicate tool names in registry: ${dupes.join(", ")}`);
}

export const TOOL_SCHEMAS = [...registry.values()].map((d) => d.schema);

export const CONCURRENT_SAFE_TOOLS = [...registry.values()]
  .filter((d) => d.concurrent)
  .map((d) => d.schema.name);

// Task executor injected at startup by tui/index.ts
let _taskExecutor: ToolContext["taskExecutor"] | null = null;
export function setTaskExecutor(fn: NonNullable<ToolContext["taskExecutor"]>) {
  _taskExecutor = fn;
}

// Active session for event logging — set per-agent-run
let _activeSessionId: number | null = null;
export function setActiveSession(id: number | null) { _activeSessionId = id; }

// Active gateway router — set at daemon/TUI startup for the notify tool
import type { GatewayRouter } from "../gateway/router.ts";
let _activeRouter: GatewayRouter | null = null;
export function setActiveRouter(router: GatewayRouter | null) { _activeRouter = router; }
export function getActiveRouter(): GatewayRouter | null { return _activeRouter; }

export async function executeTool(
  name: string,
  input: unknown,
  readFiles: Set<string>,
  cwd: string = process.cwd(),
) {
  const tool = registry.get(name);
  if (!tool) return { content: `<tool_use_error>Unknown tool: ${name}</tool_use_error>`, is_error: true };

  const typedInput = (input ?? {}) as Record<string, unknown>;
  // Resolve relative paths against cwd
  if (typeof typedInput.file_path === "string" && !typedInput.file_path.startsWith("/"))
    typedInput.file_path = resolve(cwd, typedInput.file_path);
  if (typeof typedInput.path === "string" && !typedInput.path.startsWith("/"))
    typedInput.path = resolve(cwd, typedInput.path);

  const ctx: ToolContext = { readFiles, cwd, taskExecutor: _taskExecutor ?? undefined };

  try {
    const result = await tool.execute(typedInput, ctx);
    logEvent("tool_call", {
      sessionId: _activeSessionId,
      name,
      input: typedInput,
      output: result.content.slice(0, 500), // cap to avoid bloating events table
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("tool_call", { sessionId: _activeSessionId, name, input: typedInput, output: `ERROR: ${msg}` });
    return { content: `<tool_use_error>Error calling tool (${name}): ${msg}</tool_use_error>`, is_error: true };
  }
}
