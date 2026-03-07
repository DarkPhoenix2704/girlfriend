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

export type { SubagentCallbacks } from "./types.ts";

// Active gateway router — set at daemon/TUI startup for the notify tool
import type { GatewayRouter } from "../gateway/router.ts";
let _activeRouter: GatewayRouter | null = null;
export function setActiveRouter(router: GatewayRouter | null) { _activeRouter = router; }
export function getActiveRouter(): GatewayRouter | null { return _activeRouter; }

// Tools that write to the filesystem — path must stay within cwd
const WRITE_TOOLS = new Set(["Write", "Edit"]);

/** Returns true if the resolved path is within the allowed directory. */
function isWithinCwd(resolvedPath: string, cwd: string): boolean {
  const base = cwd.endsWith("/") ? cwd : cwd + "/";
  return resolvedPath === cwd || resolvedPath.startsWith(base);
}

export async function executeTool(
  name: string,
  input: unknown,
  readFiles: Set<string>,
  cwd: string = process.cwd(),
  subagentCallbacks?: import("./types.ts").SubagentCallbacks,
  sessionId?: number | null,
  askUser?: ToolContext["askUser"],
) {
  const tool = registry.get(name);
  if (!tool) return { content: `<tool_use_error>Unknown tool: ${name}</tool_use_error>`, is_error: true };

  const typedInput = (input ?? {}) as Record<string, unknown>;
  // Resolve relative paths against cwd
  if (typeof typedInput.file_path === "string" && !typedInput.file_path.startsWith("/"))
    typedInput.file_path = resolve(cwd, typedInput.file_path);
  if (typeof typedInput.path === "string" && !typedInput.path.startsWith("/"))
    typedInput.path = resolve(cwd, typedInput.path);

  // Path sandbox: Write/Edit must not escape the working directory
  if (WRITE_TOOLS.has(name) && typeof typedInput.file_path === "string") {
    if (!isWithinCwd(typedInput.file_path, cwd)) {
      return {
        content: `<tool_use_error>Path not allowed: "${typedInput.file_path}" is outside the working directory "${cwd}". Use an absolute path within the project.</tool_use_error>`,
        is_error: true,
      };
    }
  }

  const ctx: ToolContext = {
    readFiles,
    cwd,
    sessionId,
    taskExecutor: _taskExecutor ?? undefined,
    askUser,
    subagentCallbacks,
  };

  try {
    const result = await tool.execute(typedInput, ctx);
    logEvent("tool_call", {
      sessionId: sessionId ?? null,
      name,
      input: typedInput,
      output: result.content.slice(0, 500),
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("tool_call", { sessionId: sessionId ?? null, name, input: typedInput, output: `ERROR: ${msg}` });
    return { content: `<tool_use_error>Error calling tool (${name}): ${msg}</tool_use_error>`, is_error: true };
  }
}
