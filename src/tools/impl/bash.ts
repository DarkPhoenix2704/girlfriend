import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "Bash",
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

  async execute(input, { cwd }) {
    const command = input.command as string;
    const timeout = Math.min((input.timeout as number) ?? 120_000, 120_000);

    try {
      const proc = Bun.spawn([process.env.SHELL || "bash", "-c", command], {
        cwd,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => proc.kill(), timeout);
      const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);

      const MAX_OUTPUT = 100_000;
      let output = stdoutBuf;
      if (stderrBuf) output += (output ? "\n" : "") + `[stderr]\n${stderrBuf}`;
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + `\n\n[Output truncated at ${MAX_OUTPUT} chars. ${output.length - MAX_OUTPUT} more chars omitted.]`;
      }

      return {
        content: output || `[Command completed with exit code ${exitCode} and no output]`,
        is_error: exitCode !== 0,
      };
    } catch (err) {
      return { content: `<tool_use_error>Failed to run command: ${err instanceof Error ? err.message : String(err)}</tool_use_error>`, is_error: true };
    }
  },
};
