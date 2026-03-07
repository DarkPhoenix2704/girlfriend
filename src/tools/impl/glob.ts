import { statSync } from "fs";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  concurrent: true,
  schema: {
    name: "Glob",
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

  async execute(input, { cwd }) {
    const pattern = input.pattern as string;
    const searchPath = (input.path as string) ?? cwd;

    const glob = new Bun.Glob(pattern);
    const matches: string[] = [];
    for await (const file of glob.scan({ cwd: searchPath, absolute: true, onlyFiles: true })) {
      matches.push(file);
    }

    if (matches.length === 0) return { content: "No files found matching the pattern." };

    const MAX = 500;
    const withMtime = await Promise.all(
      matches.map(async (f) => {
        try { return { path: f, mtime: statSync(f).mtimeMs }; }
        catch { return { path: f, mtime: 0 }; }
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const truncated = withMtime.length > MAX;
    const results = withMtime.slice(0, MAX);
    const footer = truncated ? `\n(showing ${MAX} of ${withMtime.length} matches — use a more specific pattern)` : "";

    return { content: results.map((f) => f.path).join("\n") + footer };
  },
};
