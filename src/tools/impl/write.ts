import { mkdirSync } from "fs";
import { dirname } from "path";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "Write",
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

  async execute(input) {
    const filePath = input.file_path as string;
    const content = input.content as string;
    mkdirSync(dirname(filePath), { recursive: true });
    await Bun.write(Bun.file(filePath), content);
    return { content: `File written successfully to ${filePath}` };
  },
};
