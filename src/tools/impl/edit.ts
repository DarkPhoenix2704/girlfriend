import { existsSync } from "fs";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "Edit",
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

  async execute(input, { readFiles }) {
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;

    if (!readFiles.has(filePath)) {
      return { content: `<tool_use_error>You must read the file before editing it. Use the Read tool first on ${filePath}.</tool_use_error>`, is_error: true };
    }
    if (!existsSync(filePath)) {
      return { content: `<tool_use_error>File not found: ${filePath}</tool_use_error>`, is_error: true };
    }

    const original = await Bun.file(filePath).text();

    let effectiveOld = oldString;
    if (!original.includes(oldString)) {
      const trimmed = oldString.replace(/\n+$/, "");
      if (!original.includes(trimmed)) {
        return { content: `<tool_use_error>old_string not found in file. Make sure it matches exactly (including whitespace and indentation).\n\nFile: ${filePath}\nSearched for:\n${oldString}</tool_use_error>`, is_error: true };
      }
      effectiveOld = trimmed;
    }

    if (!replaceAll) {
      const count = original.split(effectiveOld).length - 1;
      if (count > 1) {
        return { content: `<tool_use_error>old_string is not unique in the file (found ${count} occurrences). Either provide a larger string with more surrounding context to make it unique, or use replace_all=true to change every instance.</tool_use_error>`, is_error: true };
      }
    }

    const trailingNewlineStripped = effectiveOld !== oldString;
    const updated = replaceAll ? original.replaceAll(effectiveOld, newString) : original.replace(effectiveOld, newString);
    await Bun.write(filePath, updated);
    readFiles.add(filePath);

    const lineDiff = newString.split("\n").length - effectiveOld.split("\n").length;
    const note = trailingNewlineStripped ? " (trailing newline stripped from old_string to match)" : "";
    return { content: `File edited successfully.\n${filePath}: replaced ${replaceAll ? "all occurrences of" : ""} the specified string${lineDiff !== 0 ? ` (${lineDiff > 0 ? "+" : ""}${lineDiff} lines)` : ""}${note}` };
  },
};
