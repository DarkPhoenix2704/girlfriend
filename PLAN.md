# openclaw — Build Plan

A persistent, autonomous personal assistant platform built on agent-claw.
Runs 24/7, accepts messages from Telegram/WhatsApp, manages cron jobs, delegates to specialized subagents, and maintains deep searchable memory.

---

## Legend

- `[ ]` — not started
- `[~]` — in progress
- `[x]` — done
- `[!]` — blocked / needs decision

---

## Phase 1 — Foundation & Memory Layer

> Everything else depends on this. Get the data model right before building anything on top.

### 1.1 Schema redesign

- [x] Add `source` column to `sessions` table — (`telegram` | `whatsapp` | `cron` | `local`)
- [x] Add `external_id` column to `sessions` — maps a Telegram chat_id / WhatsApp number to a session
- [x] Add `namespace` column to `sessions` — for subagent memory isolation
- [x] Create `memories` table — structured facts with key, value, category, namespace, confidence, source_session, created_at, updated_at
- [x] Create `events` table — full audit log of tool calls, cron fires, messages received, subagent runs
- [x] Create `cron_jobs` table — name, cron_expr, prompt, last_run, next_run, enabled, created_at
- [x] Add FTS5 virtual table `messages_fts` over messages.content — enables full-text search over history
- [x] Add FTS5 virtual table `memories_fts` over memories.value
- [x] Wire all schema changes through the existing MIGRATIONS array in `sessions.ts`

### 1.2 Memory tools

- [x] `src/tools/impl/search-history.ts` — FTS5 query over past messages, filterable by session/date/role
- [x] `src/tools/impl/search-memory.ts` — query structured facts by keyword, category, namespace
- [x] `src/tools/impl/remember-fact.ts` — upsert a fact into memories table with category + confidence
- [x] `src/tools/impl/forget-fact.ts` — delete or mark a memory as stale
- [x] `src/tools/impl/get-events.ts` — query events log by time range, type, or name
- [x] Register all new tools in `src/tools/impl/index.ts`

### 1.3 Event logging

- [x] Hook `executeTool` in `src/tools/index.ts` to write every tool call + result to `events` table
- [ ] Log incoming messages (channel, session_id, content digest) to events on receipt
- [ ] Log cron fires to events (job name, trigger time, outcome)

### 1.4 Memory consolidation (background)

- [ ] `src/consolidator.ts` — reads recent messages, calls Haiku to extract memorable facts, upserts to memories
- [ ] Runs as a nightly cron job (self-scheduled, stored in cron_jobs table)
- [ ] Deduplicates facts before inserting (match by key + namespace)

---

## Phase 2 — Daemon & Scheduler

> Get the process running 24/7 with cron support before adding any channels.

### 2.1 Daemon entry point

- [ ] `src/daemon.ts` — new entry point (replaces TUI for server mode)
- [ ] Graceful shutdown on SIGINT/SIGTERM — flush pending DB writes, cancel in-flight agents
- [ ] PID file at `~/.openclaw/daemon.pid` — prevent double-start
- [ ] Structured logging to `~/.openclaw/daemon.log` (JSON lines, rotated daily)
- [ ] `index.ts` — add `--daemon` flag to launch `src/daemon.ts` instead of TUI

### 2.2 Scheduler

- [ ] `src/scheduler.ts` — reads `cron_jobs` table, evaluates cron expressions, fires due jobs
- [ ] Use a pure-JS cron parser (e.g. `croner` — works with Bun, no native deps)
- [ ] Scheduler loop runs every 60s, checks `next_run <= now AND enabled = 1`
- [ ] On fire: create a new session (source=cron), run `runAgent` with the job's prompt
- [ ] Update `last_run`, compute and store `next_run` after each fire
- [ ] Missed job recovery — on daemon start, check for jobs that should have run while offline

### 2.3 Cron tools (agent-managed schedules)

- [ ] `src/tools/impl/create-cron.ts` — agent creates a new cron job (name, expr, prompt)
- [ ] `src/tools/impl/list-crons.ts` — list all scheduled jobs with next_run times
- [ ] `src/tools/impl/delete-cron.ts` — agent deletes or disables a cron job
- [ ] `src/tools/impl/update-cron.ts` — update expression or prompt of an existing job
- [ ] Register all in `src/tools/impl/index.ts`

### 2.4 Process management

- [ ] Add `launchd` plist for macOS autostart at `~/Library/LaunchAgents/com.openclaw.daemon.plist`
- [ ] Add `systemd` unit file for Linux autostart at `~/.config/systemd/user/openclaw.service`
- [ ] CLI commands: `bun index.ts --daemon start|stop|status|restart`

---

## Phase 3 — Channel Gateways

> Telegram first (easier API, no phone required). WhatsApp second.

### 3.1 Gateway interface

- [ ] `src/gateway/types.ts` — define `IncomingMessage`, `OutgoingMessage`, `Gateway` interface
- [ ] `src/gateway/router.ts` — receives messages from any gateway, routes to correct session, runs orchestrator agent, sends reply back

### 3.2 Telegram gateway

- [ ] Install `grammy` (Telegram bot framework, works with Bun)
- [ ] `src/gateway/telegram.ts` — implements `Gateway`, handles text messages, commands, media
- [ ] Map Telegram `chat_id` → `session_id` (create session on first message, reuse after)
- [ ] Handle `/start`, `/reset`, `/memory`, `/history` commands
- [ ] Stream agent responses back as Telegram messages (split long messages at 4096 char limit)
- [ ] Handle Telegram rate limits (30 msg/sec global, 1 msg/sec per chat)
- [ ] Support sending photos/files back (for charts, screenshots, etc.)

### 3.3 WhatsApp gateway

- [ ] Decide: Baileys (free, unofficial, scan QR) vs Twilio WhatsApp API (paid, reliable) — **[!] needs decision**
- [ ] `src/gateway/whatsapp.ts` — implements `Gateway`
- [ ] Map WhatsApp number → `session_id`
- [ ] Handle text, voice notes (transcribe with Whisper API), images

### 3.4 Webhook / HTTP gateway (optional, for future integrations)

- [ ] `src/gateway/http.ts` — simple HTTP server (Bun.serve) accepting POST `/message`
- [ ] Auth via bearer token in header
- [ ] Useful for integrating any other source (Slack, email, custom apps)

---

## Phase 4 — Browser & Web Actions

> Unlocks real-world web automation — searching, form filling, scraping.

### 4.1 Playwright integration

- [ ] Install `playwright` + `playwright-chromium`
- [ ] `src/browser.ts` — singleton browser manager (one Chromium instance, multiple pages)
- [ ] Browser lifecycle: launch on first use, keep alive, restart on crash
- [ ] Configurable: headless by default, `--headed` flag for debugging

### 4.2 Browser tools

- [ ] `src/tools/impl/browser-open.ts` — navigate to URL, return page title + text content
- [ ] `src/tools/impl/browser-click.ts` — click element by CSS selector or text
- [ ] `src/tools/impl/browser-fill.ts` — fill input fields (forms, search boxes)
- [ ] `src/tools/impl/browser-screenshot.ts` — capture screenshot, return base64 (for vision)
- [ ] `src/tools/impl/browser-extract.ts` — extract structured data from page (tables, lists)
- [ ] `src/tools/impl/browser-scroll.ts` — scroll page, useful for infinite scroll pages
- [ ] `src/tools/impl/browser-close.ts` — close current page / reset browser state

### 4.3 Search tool

- [ ] `src/tools/impl/search.ts` — web search via Brave Search API or SerpAPI
- [ ] Returns top N results with title, URL, snippet
- [ ] Agent can follow up with `browser-open` to read full content

### 4.4 Security & sandboxing

- [ ] Browser runs with no stored cookies/profiles by default (incognito)
- [ ] Allowlist/blocklist of domains configurable in `~/.openclaw/config.toml`
- [ ] Sensitive actions (login, form submit, payments) require explicit user confirmation tool

---

## Phase 5 — Specialized Subagents

> Named agents with curated tools, system prompts, and isolated memory namespaces.

### 5.1 Subagent framework

- [ ] `src/agents/types.ts` — `AgentDefinition` interface (name, description, tools, systemPrompt, namespace, model)
- [ ] `src/agents/registry.ts` — auto-discovers agent definitions, similar to tool registry
- [ ] `src/tools/impl/delegate.ts` — orchestrator tool to hand off to a named subagent, returns result
- [ ] Subagents can read from their own memory namespace but write to shared memories too
- [ ] Subagent depth guard — subagents cannot spawn other subagents (already partially in place)

### 5.2 Finance subagent

- [ ] `src/agents/finance.ts` — tracks accounts, expenses, budgets, transactions
- [ ] Tools: `SearchMemory` (finance namespace), `RememberFact`, `WebFetch` (bank portals read-only)
- [ ] Can answer: "how much did I spend on food this month?", "what's my net worth?"
- [ ] Manual entry via chat: "add expense: ₹450 dinner, category food"
- [ ] [ ] Decide on data source — manual entry vs bank API vs statement parsing — **[!] needs decision**

### 5.3 Stocks / investments subagent

- [ ] `src/agents/stocks.ts` — tracks portfolio, watchlist, P&L
- [ ] Tools: `WebFetch` or a market data API (Yahoo Finance, Alpha Vantage, NSE/BSE for India)
- [ ] Daily cron: fetch prices, update portfolio value, alert on significant moves
- [ ] Can answer: "what's my portfolio up/down today?", "any news on Infosys?"
- [ ] `src/tools/impl/fetch-stock-price.ts` — get current/historical price for a ticker

### 5.4 Research subagent

- [ ] `src/agents/research.ts` — deep research using search + browser + WebFetch
- [ ] Given a topic, produces a structured report
- [ ] Saves research summaries to memory for later reference

### 5.5 Calendar / reminders subagent

- [ ] `src/agents/calendar.ts` — manages reminders, events, deadlines
- [ ] Backed by cron_jobs table (reminders = one-shot crons)
- [ ] Integrates with Google Calendar API (optional, needs OAuth) — **[!] needs decision**
- [ ] Proactive: morning briefing cron summarizes today's events

### 5.6 Orchestrator agent

- [ ] `src/agents/orchestrator.ts` — the master agent that receives all incoming messages
- [ ] Decides: answer directly, delegate to subagent, or ask clarifying question
- [ ] Has access to all memory tools + delegate tool
- [ ] System prompt emphasizes routing, not doing

---

## Phase 6 — Config, Auth & Multi-user

### 6.1 Config file

- [ ] `~/.openclaw/config.toml` — user preferences, API keys, enabled gateways, browser settings
- [ ] `src/config.ts` — loads and validates config, provides typed access
- [ ] Secrets never stored in config — use env vars or a secrets file with restricted permissions

### 6.2 Multi-user support

- [ ] Each gateway user (Telegram user_id, WhatsApp number) maps to an `owner_id` in sessions
- [ ] Memory and events are scoped per owner
- [ ] Allowlist of authorized users per gateway (prevent unauthorized access)

### 6.3 API keys management

- [ ] Anthropic API key (existing)
- [ ] Telegram bot token
- [ ] WhatsApp / Twilio credentials
- [ ] Brave Search / SerpAPI key
- [ ] Market data API key
- [ ] Google Calendar OAuth (optional)

---

## Phase 7 — Observability & TUI Debug Console

### 7.1 Daemon health

- [ ] `bun index.ts --status` — shows daemon uptime, active sessions, pending crons, memory stats
- [ ] Health check endpoint: `GET /health` via HTTP gateway

### 7.2 TUI (keep for local debugging)

- [ ] Repurpose existing TUI as a local debug console for the daemon
- [ ] Show live event log, active sessions, cron job schedule
- [ ] Allow manually triggering cron jobs or sending test messages

### 7.3 Alerting

- [ ] Agent can send proactive messages to user (not just respond)
- [ ] `src/tools/impl/notify.ts` — sends a message to the user's preferred channel
- [ ] Used by cron jobs, stock alerts, reminders

---

## Decisions needed (before building)

| # | Decision | Options |
|---|----------|---------|
| 1 | WhatsApp integration method | Baileys (free/unofficial) vs Twilio (paid/reliable) |
| 2 | Finance data source | Manual entry vs bank scraping vs Plaid/Setu API |
| 3 | Google Calendar | Integrate or keep reminders self-contained in SQLite |
| 4 | Search API | Brave Search API vs SerpAPI vs DuckDuckGo scrape |
| 5 | Deployment target | Local Mac only vs VPS (needed for 24/7 if Mac sleeps) |
| 6 | Multi-user | Single user (you) only, or support family/team? |

---

## Dependency map

```
Phase 1 (Memory)
    └── Phase 2 (Daemon + Scheduler)
            └── Phase 3 (Gateways)
            └── Phase 4 (Browser)
            └── Phase 5 (Subagents)  ← needs Phase 1 + 2
                    └── Phase 6 (Multi-user)
                            └── Phase 7 (Observability)
```

---

## Current state

- [x] Core agent loop (`src/agent.ts`)
- [x] SQLite session persistence (`src/sessions.ts`)
- [x] Subagent runner (`src/subagent.ts`)
- [x] Tool registry pattern (`src/tools/`)
- [x] Basic Memory tool (flat key-value)
- [x] WebFetch tool
- [x] Compaction + retry
- [x] TUI chat interface
- [ ] Everything else above
