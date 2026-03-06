# girlfriend

A terminal-based AI coding assistant powered by Claude. Persistent sessions, a full TUI, and a rich tool set for software engineering tasks.

## Requirements

- [Bun](https://bun.sh) v1.3+
- An Anthropic API key (or Claude OAuth token)

## Setup

```bash
bun install
```

Set your API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or use a Claude OAuth token:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=...
```

## Running

```bash
bun run index.ts
```

Launches the TUI. On first run, a new session is created automatically. On subsequent runs, the session picker opens.

## CLI flags

```
--list                  List all saved sessions
--new [name]            Start a new session (optional name)
--resume <id>           Resume a session by ID
--delete <id>           Delete a session by ID
```

## TUI keybinds

### Session picker
| Key | Action |
|-----|--------|
| `enter` | Open session |
| `n` | New session |
| `d` → `enter` | Delete selected session |
| `esc` | Back to last chat |
| `ctrl+c` | Exit |

### Chat
| Key | Action |
|-----|--------|
| `enter` | Send message |
| `esc` | Open session picker |
| `ctrl+c` | Abort current agent turn (or exit if idle) |
| `ctrl+m` | Switch model |
| `ctrl+r` | Rename current session |

## Tools

The agent has access to the following tools:

| Tool | Description |
|------|-------------|
| `Read` | Read files from the filesystem (paginated, line-numbered) |
| `Write` | Write or overwrite files |
| `Edit` | Exact string replacement in files |
| `Bash` | Execute shell commands (2 min timeout) |
| `Glob` | Find files by pattern |
| `Grep` | Search file contents with ripgrep |
| `WebFetch` | Fetch a URL and return its text content |
| `Task` | Spawn a subagent for focused, parallel work |
| `Memory` | Persistent key-value store that survives across sessions |

### Memory tool

The agent can store and retrieve facts across sessions using `Memory`:

```
set    — store a value under a key
get    — retrieve a value by key
list   — list all stored key-value pairs
delete — remove a key
```

Data is stored in SQLite at `~/.girlfriend/sessions.db`.

## Sessions

Conversation history is persisted in `~/.girlfriend/sessions.db` (SQLite, WAL mode). Each session stores:

- Full message history
- Token usage (input + output)
- Files read during the session (for `Edit` tool continuity)
- Compaction checkpoints (automatic context compression when approaching token limits)

## Project layout

```
index.ts          Entry point, CLI arg handling, TUI bootstrap
src/
  agent.ts        Core agent loop (streaming, tool execution, compaction)
  tools.ts        Tool definitions and implementations
  sessions.ts     SQLite persistence (sessions, messages, memory)
  prompts.ts      System prompt builders
  tui.ts          Full terminal UI (session picker, chat screen, model picker)
  compaction.ts   Context compression logic
  retry.ts        Exponential backoff for API calls
  subagent.ts     Task tool / subagent executor
```

## CLAUDE.md

If a `CLAUDE.md` (or `.claude/CLAUDE.md`) file exists in the working directory, its contents are injected as a system reminder at the start of each session. Use it to provide project-specific instructions.
