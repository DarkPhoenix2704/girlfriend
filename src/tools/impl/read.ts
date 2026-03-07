import { existsSync, statSync } from "fs";
import type { ToolDefinition } from "../types.ts";

const READ_CHAR_LIMIT = 20_000;

export const definition: ToolDefinition = {
  concurrent: true,
  schema: {
    name: "Read",
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

  async execute(input, { readFiles }) {
    const filePath = input.file_path as string;
    const offset = (input.offset as number) ?? 1;
    const limit = (input.limit as number) ?? 250;
    const maxLineLen = 500;

    if (!existsSync(filePath)) return { content: `File not found: ${filePath}`, is_error: true };

    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return { content: `<tool_use_error>${filePath} is a directory. Use Bash with 'ls' to list contents.</tool_use_error>`, is_error: true };
    }

    readFiles.add(filePath);
    const raw = await Bun.file(filePath).text();
    if (!raw) return { content: "(file is empty)" };

    const lines = raw.split("\n");
    const totalLines = lines.length;
    const startIdx = Math.max(0, offset - 1);
    const slice = lines.slice(startIdx, Math.min(totalLines, startIdx + limit));

    const numbered: string[] = [];
    let chars = 0;
    for (let i = 0; i < slice.length; i++) {
      const lineNum = startIdx + i + 1;
      const line = slice[i] ?? "";
      const truncated = line.length > maxLineLen ? line.slice(0, maxLineLen) + "…" : line;
      const entry = `${String(lineNum).padStart(6)}\t${truncated}`;
      chars += entry.length + 1;
      if (chars > READ_CHAR_LIMIT) break;
      numbered.push(entry);
    }

    const linesShown = startIdx + numbered.length;
    const remaining = totalLines - linesShown;
    const footer = remaining > 0
      ? `\n\n[Showing lines ${offset}–${linesShown} of ${totalLines}. ${remaining} more lines — use offset=${linesShown + 1} to continue.]`
      : totalLines > limit ? `\n\n[End of requested range. File has ${totalLines} total lines.]` : "";

    return { content: numbered.join("\n") + footer };
  },
};
