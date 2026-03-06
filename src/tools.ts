// Tool implementations — Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task

import { readFile, writeFile, readdir } from "fs/promises";
import { existsSync, statSync } from "fs";
import { resolve, dirname, relative, join } from "path";
import { spawn } from "child_process";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

// ─── Tool name constants ───────────────────────────────────────────────────────
export const TOOL_READ = "Read";
export const TOOL_WRITE = "Write";
export const TOOL_EDIT = "Edit";
export const TOOL_BASH = "Bash";
export const TOOL_GLOB = "Glob";
export const TOOL_GREP = "Grep";
export const TOOL_WEB_FETCH = "WebFetch";
export const TOOL_TASK = "Task";
// ─── Anthropic tool schemas ────────────────────────────────────────────────────

export const TOOL_SCHEMAS: Tool[] = [
  {
    name: TOOL_READ,
    description: `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 250 lines starting from the beginning of the file
- Output is capped at 20,000 characters. For large files, use offset and limit to page through sections.
- If the response footer says "N more lines", use offset=<next_line> to continue reading from where you left off.
- Any lines longer than 500 characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.
- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`,
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to read" },
        offset: { type: "number", description: "The line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "The number of lines to read" },
      },
      required: ["file_path"],
    },
  },
  {
    name: TOOL_WRITE,
    description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- Prefer the Edit tool for modifying existing files — it only sends the diff.
- Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.`,
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to write" },
        content: { type: "string", description: "The content to write to the file" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: TOOL_EDIT,
    description: `Performs exact string replacements in files.

Usage:
- You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.
- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to modify" },
        old_string: { type: "string", description: "The text to replace" },
        new_string: { type: "string", description: "The text to replace it with" },
        replace_all: { type: "boolean", description: "Replace all occurrences (default false)", default: false },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: TOOL_BASH,
    description: `Executes a given bash command and returns its output.

Usage:
- AVOID using this tool to run find, grep, cat, head, tail, sed, awk or echo commands — use dedicated tools instead.
- Always quote file paths that contain spaces.
- Default timeout: 2 minutes.

# Committing changes with git
Only create commits when requested by the user. When the user asks you to create a new git commit:
1. Run git status to see all untracked files.
2. Run git diff to see staged and unstaged changes.
3. Run git log to see recent commit messages.
4. Stage relevant files and create a commit with a concise message.
5. Run git status after the commit to verify success.

NEVER run git commands with -i flag. NEVER use --no-verify unless user explicitly requests it.`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        timeout: { type: "number", description: "Timeout in milliseconds (max 120000)" },
      },
      required: ["command"],
    },
  },
  {
    name: TOOL_GLOB,
    description: `Fast file pattern matching tool that works with any codebase size.
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.`,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern to match files against" },
        path: { type: "string", description: "The directory to search in (defaults to cwd)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: TOOL_GREP,
    description: `A powerful search tool built on ripgrep.

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke grep or rg as a Bash command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts`,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regular expression pattern to search for" },
        path: { type: "string", description: "File or directory to search in (defaults to cwd)" },
        glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.js', '*.{ts,tsx}')" },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "Output mode (default: files_with_matches)",
        },
        case_insensitive: { type: "boolean", description: "Case insensitive search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: TOOL_WEB_FETCH,
    description: `Fetches content from a URL and returns it as text. Use this to read documentation, APIs, or any web content needed for the task.`,
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: TOOL_TASK,
    description: `Launch a subagent to complete a focused, self-contained task. Use for long-running, independent work that shouldn't clutter the main context. The subagent runs its own agent loop with restricted tools and returns a summary when done.`,
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short label for the task (shown in UI)" },
        prompt: { type: "string", description: "Full task description sent to the subagent" },
        subagent_type: { type: "string", description: "Named subagent definition to use. Use 'Explore' for codebase research." },
      },
      required: ["description", "prompt"],
    },
  },
];
// ─── Tool executor ─────────────────────────────────────────────────────────────

export type ToolInput = Record<string, unknown>;
export type ToolResult = { content: string; is_error?: boolean };

// Read-only tools safe to run concurrently; mutating tools run sequentially
export const CONCURRENT_SAFE_TOOLS = [TOOL_READ, TOOL_GLOB, TOOL_GREP, TOOL_WEB_FETCH];

export async function executeTool(
  name: string,
  input: unknown,
  readFiles: Set<string>,
  cwd: string = process.cwd(),
): Promise<ToolResult> {
  const typedInput = (input ?? {}) as ToolInput;
  // Resolve relative file_path / path fields against cwd
  if (typedInput.file_path && typeof typedInput.file_path === "string" && !resolve(typedInput.file_path).startsWith("/")) {
    typedInput.file_path = resolve(cwd, typedInput.file_path);
  }
  if (typedInput.path && typeof typedInput.path === "string" && !resolve(typedInput.path).startsWith("/")) {
    typedInput.path = resolve(cwd, typedInput.path);
  }
  try {
    switch (name) {
      case TOOL_READ:    return await toolRead(typedInput, readFiles);
      case TOOL_WRITE:   return await toolWrite(typedInput);
      case TOOL_EDIT:    return await toolEdit(typedInput, readFiles);
      case TOOL_BASH:    return await toolBash(typedInput, cwd);
      case TOOL_GLOB:    return await toolGlob(typedInput, cwd);
      case TOOL_GREP:    return await toolGrep(typedInput, cwd);
      case TOOL_WEB_FETCH: return await toolWebFetch(typedInput);
      default:
        return { content: `<tool_use_error>Unknown tool: ${name}</tool_use_error>`, is_error: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `<tool_use_error>Error calling tool (${name}): ${msg}</tool_use_error>`, is_error: true };
  }
}

// ─── Read ──────────────────────────────────────────────────────────────────────

// Hard cap: ~20k chars ≈ ~5k tokens — prevents single Read from blowing up the context
const READ_CHAR_LIMIT = 20_000;

async function toolRead(input: ToolInput, readFiles: Set<string>): Promise<ToolResult> {
  const filePath = input.file_path as string;
  const offset = (input.offset as number) ?? 1;
  const limit = (input.limit as number) ?? 250; // default 250 lines — use offset to page
  const maxLineLen = 500; // truncate very long lines

  if (!existsSync(filePath)) {
    return { content: `File not found: ${filePath}`, is_error: true };
  }

  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    return { content: `<tool_use_error>${filePath} is a directory. Use Bash with 'ls' to list contents.</tool_use_error>`, is_error: true };
  }

  readFiles.add(filePath);
  const raw = await readFile(filePath, "utf8");

  if (!raw) {
    return { content: `(file is empty)` };
  }

  const lines = raw.split("\n");
  const totalLines = lines.length;
  const startIdx = Math.max(0, offset - 1);
  const endIdx = Math.min(totalLines, startIdx + limit);
  const slice = lines.slice(startIdx, endIdx);

  const numbered: string[] = [];
  let chars = 0;

  for (let i = 0; i < slice.length; i++) {
    const lineNum = startIdx + i + 1;
    const line = (slice[i] ?? "").length > maxLineLen
      ? (slice[i] ?? "").slice(0, maxLineLen) + "…"
      : (slice[i] ?? "");
    const entry = `${String(lineNum).padStart(6)}\t${line}`;
    chars += entry.length + 1;
    if (chars > READ_CHAR_LIMIT) break;
    numbered.push(entry);
  }

  const linesShown = startIdx + numbered.length;
  const remaining = totalLines - linesShown;
  const footer = remaining > 0
    ? `\n\n[Showing lines ${offset}–${linesShown} of ${totalLines}. ${remaining} more lines — use offset=${linesShown + 1} to continue.]`
    : totalLines > limit
      ? `\n\n[End of requested range. File has ${totalLines} total lines.]`
      : "";

  return { content: numbered.join("\n") + footer };
}

// ─── Write ─────────────────────────────────────────────────────────────────────

async function toolWrite(input: ToolInput): Promise<ToolResult> {
  const filePath = input.file_path as string;
  const content = input.content as string;

  const dir = dirname(filePath);
  const { mkdirSync } = await import("fs");
  mkdirSync(dir, { recursive: true });
  await Bun.write(Bun.file(filePath), content);

  return { content: `File written successfully to ${filePath}` };
}
// ─── Edit (exact string replacement with uniqueness validation) ────────────────

async function toolEdit(input: ToolInput, readFiles: Set<string>): Promise<ToolResult> {
  const filePath = input.file_path as string;
  const oldString = input.old_string as string;
  const newString = input.new_string as string;
  const replaceAll = (input.replace_all as boolean) ?? false;

  if (!readFiles.has(filePath)) {
    return {
      content: `<tool_use_error>You must read the file before editing it. Use the Read tool first on ${filePath}.</tool_use_error>`,
      is_error: true,
    };
  }

  if (!existsSync(filePath)) {
    return { content: `<tool_use_error>File not found: ${filePath}</tool_use_error>`, is_error: true };
  }

  const original = await readFile(filePath, "utf8");

  if (!original.includes(oldString)) {
    // Try with trailing newline stripped
    const trimmed = oldString.replace(/\n+$/, "");
    if (!original.includes(trimmed)) {
      return {
        content: `<tool_use_error>old_string not found in file. Make sure it matches exactly (including whitespace and indentation).\n\nFile: ${filePath}\nSearched for:\n${oldString}</tool_use_error>`,
        is_error: true,
      };
    }
  }

  // Validate uniqueness
  if (!replaceAll) {
    const count = original.split(oldString).length - 1;
    if (count > 1) {
      return {
        content: `<tool_use_error>old_string is not unique in the file (found ${count} occurrences). Either provide a larger string with more surrounding context to make it unique, or use replace_all=true to change every instance.</tool_use_error>`,
        is_error: true,
      };
    }
  }

  // Apply replacement
  let updated: string;
  if (replaceAll) {
    updated = original.replaceAll(oldString, newString);
  } else {
    // Handle trailing newline edge case
    if (newString !== "" && !oldString.endsWith("\n") && original.includes(oldString + "\n")) {
      updated = original.replace(oldString + "\n", newString);
    } else {
      updated = original.replace(oldString, newString);
    }
  }

  await writeFile(filePath, updated, "utf8");
  readFiles.add(filePath); // mark as read so further edits are allowed

  const linesChanged = Math.abs(newString.split("\n").length - oldString.split("\n").length);
  return { content: `File edited successfully.\n${filePath}: replaced ${replaceAll ? "all occurrences of" : ""} the specified string${linesChanged > 0 ? ` (${linesChanged > 0 ? "+" : ""}${newString.split("\n").length - oldString.split("\n").length} lines)` : ""}` };
}

// ─── Bash ──────────────────────────────────────────────────────────────────────

async function toolBash(input: ToolInput, cwd: string = process.cwd()): Promise<ToolResult> {
  const command = input.command as string;
  const timeout = Math.min((input.timeout as number) ?? 120_000, 120_000);

  return new Promise((resolve) => {
    const shell = process.env.SHELL || "bash";
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(shell, ["-c", command], {
      env: { ...process.env },
      cwd,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ content: `<tool_use_error>Command timed out after ${timeout}ms: ${command}</tool_use_error>`, is_error: true });
        return;
      }

      const MAX_OUTPUT = 100_000; // 100KB cap for context window sanity
      let output = stdout;
      if (stderr) output += (output ? "\n" : "") + `[stderr]\n${stderr}`;
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + `\n\n[Output truncated at ${MAX_OUTPUT} chars. ${output.length - MAX_OUTPUT} more chars omitted.]`;
      }

      resolve({
        content: output || `[Command completed with exit code ${code} and no output]`,
        is_error: code !== 0,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ content: `<tool_use_error>Failed to spawn process: ${err.message}</tool_use_error>`, is_error: true });
    });
  });
}

// ─── Glob ──────────────────────────────────────────────────────────────────────

async function toolGlob(input: ToolInput, cwd: string = process.cwd()): Promise<ToolResult> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? cwd;

  // Use bun's native glob
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];

  for await (const file of glob.scan({ cwd: searchPath, absolute: true, onlyFiles: true })) {
    matches.push(file);
  }

  if (matches.length === 0) {
    return { content: "No files found matching the pattern." };
  }

  // Sort by modification time (newest first)
  const withMtime = await Promise.all(
    matches.map(async (f) => {
      try {
        const s = statSync(f);
        return { path: f, mtime: s.mtimeMs };
      } catch {
        return { path: f, mtime: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);

  return { content: withMtime.map((f) => f.path).join("\n") };
}

// ─── Grep ──────────────────────────────────────────────────────────────────────

async function toolGrep(input: ToolInput, cwd: string = process.cwd()): Promise<ToolResult> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? cwd;
  const globFilter = input.glob as string | undefined;
  const outputMode = (input.output_mode as string) ?? "files_with_matches";
  const caseInsensitive = (input.case_insensitive as boolean) ?? false;

  const flags = caseInsensitive ? "gi" : "g";
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (e) {
    return { content: `<tool_use_error>Invalid regex: ${pattern}</tool_use_error>`, is_error: true };
  }

  // Collect files to search
  const files: string[] = [];
  const fileGlob = new Bun.Glob(globFilter ?? "**/*");

  for await (const file of fileGlob.scan({ cwd: searchPath, absolute: true, onlyFiles: true })) {
    // Skip binary-ish files and common noise
    if (/node_modules|\.git|dist|\.next|\.cache/.test(file)) continue;
    if (/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|lock|wasm)$/.test(file)) continue;
    files.push(file);
  }

  const results: string[] = [];
  const matchedFiles = new Set<string>();

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    let fileHasMatch = false;
    let matchCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        fileHasMatch = true;
        matchCount++;
        regex.lastIndex = 0; // reset for /g flag

        if (outputMode === "content") {
          results.push(`${file}:${i + 1}:${line}`);
        }
      }
      regex.lastIndex = 0;
    }

    if (fileHasMatch) {
      matchedFiles.add(file);
      if (outputMode === "count") results.push(`${file}:${matchCount}`);
    }
  }

  if (outputMode === "files_with_matches") {
    if (matchedFiles.size === 0) return { content: "No matches found." };
    return { content: Array.from(matchedFiles).join("\n") };
  }

  if (results.length === 0) return { content: "No matches found." };

  const MAX = 200;
  const truncated = results.length > MAX;
  const output = results.slice(0, MAX).join("\n");
  return {
    content: output + (truncated ? `\n\n[Output truncated. ${results.length - MAX} more matches omitted.]` : ""),
  };
}

// ─── WebFetch ──────────────────────────────────────────────────────────────────

async function toolWebFetch(input: ToolInput): Promise<ToolResult> {
  const url = input.url as string;

  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; girlfriend/1.0)" },    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    return { content: `<tool_use_error>HTTP ${resp.status} ${resp.statusText} for ${url}</tool_use_error>`, is_error: true };
  }

  const contentType = resp.headers.get("content-type") ?? "";
  let text: string;

  if (contentType.includes("text/html")) {
    const html = await resp.text();
    // Strip HTML tags — naive but functional
    text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    text = await resp.text();
  }

  const MAX = 50_000;
  if (text.length > MAX) text = text.slice(0, MAX) + `\n\n[Content truncated at ${MAX} chars]`;

  return { content: text };
}
