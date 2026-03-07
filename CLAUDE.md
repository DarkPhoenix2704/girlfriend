# agent-claw

A minimal Claude agent REPL built with Bun. No frontend, no server, no database drivers beyond `bun:sqlite`.

## Runtime

Always use Bun, never Node.

- `bun index.ts` — run the app
- `bun test` — run tests
- `bun install` — install deps
- `bunx <pkg>` — execute packages
- `Bun.file()` — read/write files (not `node:fs`)
- `bun:sqlite` — SQLite (not `better-sqlite3`)
- Bun auto-loads `.env`, no dotenv needed

## Project structure

```
index.ts                  — entry: CLI flags, auth, launches TUI
src/
  agent.ts                — main agent loop (streaming, tool execution, compaction)
  subagent.ts             — subagent runner for the Task tool
  compaction.ts           — context compaction (fires at 50k tokens)
  prompts.ts              — system prompt builder, compaction prompt, subagent prompts
  sessions.ts             — SQLite session persistence (~/.agent-claw/sessions.db)
  retry.ts                — exponential backoff retry wrapper
  updater.ts              — background update checker
  tools/
    index.ts              — auto-builds TOOL_SCHEMAS + executeTool from registry
    types.ts              — ToolDefinition, ToolContext, ToolResult interfaces
    impl/
      index.ts            — tool registry (one export per tool)
      read.ts, write.ts, edit.ts, bash.ts, glob.ts, grep.ts, web-fetch.ts, memory.ts, task.ts
  tui/
    index.ts              — TUI entry, mounts screens
    chat-screen.ts        — main chat view, input handling, agent integration
    session-screen.ts     — session picker
    model-screen.ts       — model selector
    components.ts, theme.ts
```

## Key conventions

### Adding a new tool
1. Create `src/tools/impl/<name>.ts` exporting `definition: ToolDefinition`
2. Add one line to `src/tools/impl/index.ts`: `export { definition as ToolName } from "./<name>.ts";`
3. Nothing else needs changing — the registry auto-discovers it

Mark `concurrent: true` on the definition if the tool is read-only and safe to run in parallel.

### Agent loop (`src/agent.ts`)
- Streams API calls, executes tools, loops until no `tool_use` blocks in response
- Compaction fires automatically at 50k context tokens via `maybeCompact()`
- All API calls use `cache_control: { type: "ephemeral" }` on the system prompt and last tool for prompt caching
- `claudeMd` is injected into the system prompt (not user messages)

### Sessions (`src/sessions.ts`)
- SQLite at `~/.agent-claw/sessions.db`
- Tables: `sessions`, `messages`, `read_files`, `migrations`
- To add a schema change: append to the `MIGRATIONS` array — each entry runs exactly once

### Subagents (`src/subagent.ts`)
- Task tool spawns subagents with a restricted tool set
- Default unnamed subagents use Haiku; named definitions can specify `model: "sonnet" | "opus" | "haiku" | "inherit"`
- Subagents cannot spawn their own subagents (depth guard)

## Auth

- API key: set `ANTHROPIC_API_KEY` (standard SDK default)
- OAuth: set `CLAUDE_CODE_OAUTH_TOKEN` — automatically adds `anthropic-beta: oauth-2025-04-20` header

## Release

Releases are fully automated via GitHub Actions. To cut a release:

```sh
git tag v0.x.y && git push origin v0.x.y
```

The CI workflow builds native binaries (linux-x64, darwin-arm64), signs them with GPG, creates a GitHub release, and publishes the `gf-uwu` npm package family.
