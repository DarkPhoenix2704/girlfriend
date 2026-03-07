import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  concurrent: true,
  schema: {
    name: "Grep",
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

  async execute(input, { cwd }) {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) ?? cwd;
    const globFilter = input.glob as string | undefined;
    const outputMode = (input.output_mode as string) ?? "files_with_matches";
    const caseInsensitive = (input.case_insensitive as boolean) ?? false;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? "gi" : "g");
    } catch {
      return { content: `<tool_use_error>Invalid regex: ${pattern}</tool_use_error>`, is_error: true };
    }

    const files: string[] = [];
    const fileGlob = new Bun.Glob(globFilter ?? "**/*");
    for await (const file of fileGlob.scan({ cwd: searchPath, absolute: true, onlyFiles: true })) {
      if (/node_modules|\.git|dist|\.next|\.cache/.test(file)) continue;
      if (/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|lock|wasm)$/.test(file)) continue;
      files.push(file);
    }

    const results: string[] = [];
    const matchedFiles = new Set<string>();

    for (const file of files) {
      let content: string;
      try { content = await Bun.file(file).text(); } catch { continue; }

      const lines = content.split("\n");
      let fileHasMatch = false;
      let matchCount = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        regex.lastIndex = 0;
        if (regex.test(line)) {
          fileHasMatch = true;
          matchCount++;
          if (outputMode === "content") results.push(`${file}:${i + 1}:${line}`);
        }
      }

      if (fileHasMatch) {
        matchedFiles.add(file);
        if (outputMode === "count") results.push(`${file}:${matchCount}`);
      }
    }

    if (outputMode === "files_with_matches") {
      return matchedFiles.size === 0
        ? { content: "No matches found." }
        : { content: Array.from(matchedFiles).join("\n") };
    }

    if (results.length === 0) return { content: "No matches found." };

    const MAX = 200;
    const truncated = results.length > MAX;
    return {
      content: results.slice(0, MAX).join("\n") + (truncated ? `\n\n[Output truncated. ${results.length - MAX} more matches omitted.]` : ""),
    };
  },
};
