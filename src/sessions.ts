// Session persistence using bun:sqlite
// Stores conversation history so you can create, resume, and list sessions.

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import type Anthropic from "@anthropic-ai/sdk";

// DB lives in ~/.girlfriend/data.db
const DB_DIR = join(process.env.HOME ?? ".", ".girlfriend");
const DB_PATH = join(DB_DIR, "data.db");
export interface Session {
  id: number;
  name: string;
  model: string;
  source: string;
  external_id: string | null;
  namespace: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  total_input_tokens: number;
  total_output_tokens: number;
  message_count: number;
}

export type SessionSource = "local" | "telegram" | "whatsapp" | "cron" | "http";

export interface MemoryFact {
  id: number;
  key: string;
  value: string;
  category: string | null;
  namespace: string | null;
  source_session: number | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface EventLog {
  id: number;
  session_id: number | null;
  type: string;
  name: string | null;
  input: string | null;
  output: string | null;
  tokens_used: number | null;
  created_at: string;
}

export type EventType = "tool_call" | "cron_fired" | "message_received" | "subagent_run" | "compaction";

export interface CronJob {
  id: number;
  name: string;
  cron_expr: string;
  prompt: string;
  last_run: string | null;
  next_run: string | null;
  enabled: number;
  created_at: string;
}

// ─── Migrations ───────────────────────────────────────────────────────────────
// Add new migrations to the END of this array only. Never edit existing entries.

const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        name                TEXT NOT NULL,
        model               TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        total_input_tokens  INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS read_files (
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_path  TEXT NOT NULL,
        PRIMARY KEY (session_id, file_path)
      );
    `,
  },
  {
    id: 2,
    sql: `ALTER TABLE messages ADD COLUMN is_compaction_point INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    id: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS memory (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  // Phase 1: sessions get source/channel metadata
  {
    id: 4,
    sql: `
      ALTER TABLE sessions ADD COLUMN source      TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE sessions ADD COLUMN external_id TEXT;
      ALTER TABLE sessions ADD COLUMN namespace   TEXT;
      ALTER TABLE sessions ADD COLUMN owner_id    TEXT;
    `,
  },
  // Phase 1: structured fact memory (replaces flat key-value for rich use cases)
  {
    id: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS memories (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        key            TEXT NOT NULL,
        value          TEXT NOT NULL,
        category       TEXT,
        namespace      TEXT,
        source_session INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        confidence     REAL NOT NULL DEFAULT 1.0,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memories_key_namespace ON memories(key, COALESCE(namespace, ''));
      CREATE INDEX IF NOT EXISTS memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS memories_namespace ON memories(namespace);
    `,
  },
  // Phase 1: full-text search over messages
  {
    id: 6,
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        role,
        content,
        content=messages,
        content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS messages_fts_insert
        AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, role, content) VALUES (new.id, new.role, new.content);
        END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_delete
        AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, role, content) VALUES ('delete', old.id, old.role, old.content);
        END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_update
        AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, role, content) VALUES ('delete', old.id, old.role, old.content);
          INSERT INTO messages_fts(rowid, role, content) VALUES (new.id, new.role, new.content);
        END;
    `,
  },
  // Phase 1: full-text search over memory facts
  {
    id: 7,
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        key,
        value,
        content=memories,
        content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS memories_fts_insert
        AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
        END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_delete
        AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
        END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_update
        AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
          INSERT INTO memories_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
        END;
    `,
  },
  // Phase 1: full audit event log
  {
    id: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
        type        TEXT NOT NULL,
        name        TEXT,
        input       TEXT,
        output      TEXT,
        tokens_used INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS events_type    ON events(type);
      CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
    `,
  },
  // Phase 2: cron jobs table
  {
    id: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        cron_expr  TEXT NOT NULL,
        prompt     TEXT NOT NULL,
        last_run   TEXT,
        next_run   TEXT,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];

function runMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (database.prepare("SELECT id FROM migrations").all() as { id: number }[]).map((r) => r.id)
  );

  const insert = database.prepare("INSERT INTO migrations (id) VALUES (?)");

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      insert.run(migration.id);
    })();
  }
}

// ─── DB init ──────────────────────────────────────────────────────────────────

let _db: Database | null = null;

function db(): Database {
  if (_db) return _db;
  mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  runMigrations(_db);
  return _db;
}

// ─── Session CRUD ─────────────────────────────────────────────────────────────

export function createSession(
  name: string,
  model: string,
  source: SessionSource = "local",
  externalId?: string,
  namespace?: string,
  ownerId?: string,
): number {
  const result = db()
    .prepare("INSERT INTO sessions (name, model, source, external_id, namespace, owner_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .get(name, model, source, externalId ?? null, namespace ?? null, ownerId ?? null) as { id: number };
  return result.id;
}

export function listSessions(limit = 20): Session[] {
  return db()
    .prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT ?
    `)
    .all(limit) as Session[];
}

export function getSession(id: number): Session | null {
  return db()
    .prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
    `)
    .get(id) as Session | null;
}

export function deleteSession(id: number): void {
  db().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function renameSession(id: number, name: string): void {
  db().prepare("UPDATE sessions SET name = ? WHERE id = ?").run(name, id);
}

export function getSessionByExternalId(source: SessionSource, externalId: string): Session | null {
  return db()
    .prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.source = ? AND s.external_id = ?
      GROUP BY s.id
    `)
    .get(source, externalId) as Session | null;
}

// ─── Message persistence ──────────────────────────────────────────────────────

export function saveMessage(sessionId: number, msg: Anthropic.MessageParam): void {
  db()
    .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
    .run(sessionId, msg.role, JSON.stringify(msg.content));
}

export function loadMessages(sessionId: number): Anthropic.MessageParam[] {
  // Resume from last compaction point if one exists — avoids replaying stale pre-compaction history
  const checkpoint = db()
    .prepare("SELECT id FROM messages WHERE session_id = ? AND is_compaction_point = 1 ORDER BY id DESC LIMIT 1")
    .get(sessionId) as { id: number } | null;

  const rows = (
    checkpoint
      ? db().prepare("SELECT role, content FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC")
          .all(sessionId, checkpoint.id)
      : db().prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC")
          .all(sessionId)
  ) as { role: string; content: string }[];

  return rows.map((r) => ({
    role: r.role as "user" | "assistant",
    content: JSON.parse(r.content),
  }));
}

/** Saves only the NEW messages appended since `previousLength` */
export function appendMessages(
  sessionId: number,
  messages: Anthropic.MessageParam[],
  previousLength: number
): void {
  const insert = db().prepare(
    "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
  );
  const tx = db().transaction(() => {
    for (let i = previousLength; i < messages.length; i++) {
      const msg = messages[i]!;
      insert.run(sessionId, msg.role, JSON.stringify(msg.content));
    }
  });
  tx();
}

/**
 * Called when compaction occurred. Deletes all existing messages for the session
 * and inserts the compacted history, marking the first message as the compaction point.
 * On resume, loadMessages will start from this checkpoint.
 */
export function saveCompactionMessages(
  sessionId: number,
  messages: Anthropic.MessageParam[]
): void {
  const d = db();
  const del = d.prepare("DELETE FROM messages WHERE session_id = ?");
  const insert = d.prepare(
    "INSERT INTO messages (session_id, role, content, is_compaction_point) VALUES (?, ?, ?, ?)"
  );
  const tx = d.transaction(() => {
    del.run(sessionId);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      insert.run(sessionId, msg.role, JSON.stringify(msg.content), i === 0 ? 1 : 0);
    }
  });
  tx();
}

// ─── Token tracking ───────────────────────────────────────────────────────────

export function addTokens(sessionId: number, inputTokens: number, outputTokens: number): void {
  db()
    .prepare(`
      UPDATE sessions
      SET total_input_tokens  = total_input_tokens + ?,
          total_output_tokens = total_output_tokens + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `)
    .run(inputTokens, outputTokens, sessionId);
}

// ─── Read-file tracking ───────────────────────────────────────────────────────

export function saveReadFiles(sessionId: number, files: Set<string>): void {
  const insert = db().prepare(
    "INSERT OR IGNORE INTO read_files (session_id, file_path) VALUES (?, ?)"
  );
  const tx = db().transaction(() => {
    for (const f of files) insert.run(sessionId, f);
  });
  tx();
}

export function loadReadFiles(sessionId: number): Set<string> {
  const rows = db()
    .prepare("SELECT file_path FROM read_files WHERE session_id = ?")
    .all(sessionId) as { file_path: string }[];
  return new Set(rows.map((r) => r.file_path));
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  key: string;
  value: string;
  updated_at: string;
}

export function memorySet(key: string, value: string): void {
  db()
    .prepare("INSERT OR REPLACE INTO memory (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .run(key, value);
}

export function memoryGet(key: string): string | null {
  const row = db()
    .prepare("SELECT value FROM memory WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function memoryList(): MemoryEntry[] {
  return db()
    .prepare("SELECT key, value, updated_at FROM memory ORDER BY updated_at DESC")
    .all() as MemoryEntry[];
}

export function memoryDelete(key: string): boolean {
  const result = db().prepare("DELETE FROM memory WHERE key = ?").run(key);
  return result.changes > 0;
}

// ─── Structured memories ──────────────────────────────────────────────────────

export function upsertMemory(
  key: string,
  value: string,
  options: {
    category?: string;
    namespace?: string;
    sourceSession?: number;
    confidence?: number;
  } = {}
): void {
  db().prepare(`
    INSERT INTO memories (key, value, category, namespace, source_session, confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(key, COALESCE(namespace, '')) DO UPDATE SET
      value          = excluded.value,
      category       = excluded.category,
      confidence     = excluded.confidence,
      source_session = excluded.source_session,
      updated_at     = datetime('now')
  `).run(
    key,
    value,
    options.category ?? null,
    options.namespace ?? null,
    options.sourceSession ?? null,
    options.confidence ?? 1.0,
  );
}

export function searchMemories(
  query: string,
  options: { category?: string; namespace?: string; limit?: number } = {}
): MemoryFact[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.trim()) {
    // FTS5 phrase search — wrap in quotes to safely handle arbitrary input text
    const ftsQuery = '"' + query.replace(/"/g, " ") + '"';
    const rows = db().prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts fts ON fts.rowid = m.id
      WHERE memories_fts MATCH ?
      ${options.category ? "AND m.category = ?" : ""}
      ${options.namespace !== undefined ? "AND m.namespace IS ?" : ""}
      ORDER BY rank
      LIMIT ?
    `).all(
      ftsQuery,
      ...(options.category ? [options.category] : []),
      ...(options.namespace !== undefined ? [options.namespace] : []),
      options.limit ?? 20,
    ) as MemoryFact[];
    return rows;
  }

  // No query — list by category/namespace
  if (options.category) { conditions.push("category = ?"); params.push(options.category); }
  if (options.namespace !== undefined) { conditions.push("namespace IS ?"); params.push(options.namespace); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db().prepare(`
    SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?
  `).all(...params, options.limit ?? 20) as MemoryFact[];
}

export function deleteMemory(key: string, namespace?: string): boolean {
  const result = db().prepare(
    "DELETE FROM memories WHERE key = ? AND COALESCE(namespace, '') = COALESCE(?, '')"
  ).run(key, namespace ?? null);
  return result.changes > 0;
}

/** Delete low-confidence memories older than N days (default: confidence < 0.6 AND older than 90 days). */
export function pruneMemories(options: { olderThanDays?: number; maxConfidence?: number } = {}): number {
  const days = options.olderThanDays ?? 90;
  const maxConf = options.maxConfidence ?? 0.6;
  const result = db().prepare(`
    DELETE FROM memories
    WHERE confidence < ?
    AND updated_at < datetime('now', '-' || ? || ' days')
  `).run(maxConf, days);
  return result.changes;
}

export interface TokenStats {
  today: number;
  thisWeek: number;
  total: number;
}

export function getTokenStats(): TokenStats {
  const q = (sql: string) => (db().prepare(sql).get() as { n: number }).n;
  return {
    today:    q("SELECT COALESCE(SUM(total_input_tokens+total_output_tokens),0) AS n FROM sessions WHERE date(updated_at)=date('now')"),
    thisWeek: q("SELECT COALESCE(SUM(total_input_tokens+total_output_tokens),0) AS n FROM sessions WHERE updated_at>=datetime('now','-7 days')"),
    total:    q("SELECT COALESCE(SUM(total_input_tokens+total_output_tokens),0) AS n FROM sessions"),
  };
}

export function listMemories(options: { category?: string; namespace?: string; limit?: number } = {}): MemoryFact[] {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];
  if (options.category) { conditions.push("category = ?"); params.push(options.category); }
  if (options.namespace !== undefined) { conditions.push("namespace IS ?"); params.push(options.namespace ?? null); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db().prepare(
    `SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`
  ).all(...params, options.limit ?? 50) as MemoryFact[];
}

// ─── Recent messages for consolidation ───────────────────────────────────────

export interface RawMessage {
  role: string;
  content: string;
  created_at: string;
}

export function getRecentMessages(since: string | null, limit = 200): RawMessage[] {
  const rows = (
    since
      ? db().prepare("SELECT role, content, created_at FROM messages WHERE created_at > ? ORDER BY id DESC LIMIT ?").all(since, limit)
      : db().prepare("SELECT role, content, created_at FROM messages ORDER BY id DESC LIMIT ?").all(limit)
  ) as RawMessage[];
  return rows.reverse(); // chronological
}

// ─── Full-text message search ─────────────────────────────────────────────────

export interface MessageSearchResult {
  message_id: number;
  session_id: number;
  session_name: string;
  role: string;
  content: string;
  created_at: string;
  rank: number;
}

export function searchMessages(
  query: string,
  options: { sessionId?: number; role?: string; limit?: number; since?: string } = {}
): MessageSearchResult[] {
  const extraConditions: string[] = [];
  const extraParams: (string | number)[] = [];

  if (options.sessionId) { extraConditions.push("m.session_id = ?"); extraParams.push(options.sessionId); }
  if (options.role) { extraConditions.push("m.role = ?"); extraParams.push(options.role); }
  if (options.since) { extraConditions.push("m.created_at >= ?"); extraParams.push(options.since); }

  const extra = extraConditions.length ? `AND ${extraConditions.join(" AND ")}` : "";

  // Wrap in FTS5 phrase quotes to safely handle arbitrary input (same as searchMemories)
  const ftsQuery = '"' + query.replace(/"/g, " ") + '"';
  return db().prepare(`
    SELECT
      m.id        AS message_id,
      m.session_id,
      s.name      AS session_name,
      m.role,
      m.content,
      m.created_at,
      fts.rank
    FROM messages_fts fts
    JOIN messages m ON m.id = fts.rowid
    JOIN sessions s ON s.id = m.session_id
    WHERE messages_fts MATCH ? ${extra}
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, ...extraParams, options.limit ?? 20) as MessageSearchResult[];
}

// ─── Events ───────────────────────────────────────────────────────────────────

export function logEvent(
  type: EventType,
  options: {
    sessionId?: number | null;
    name?: string;
    input?: unknown;
    output?: string;
    tokensUsed?: number;
  } = {}
): void {
  db().prepare(`
    INSERT INTO events (session_id, type, name, input, output, tokens_used)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    options.sessionId ?? null,
    type,
    options.name ?? null,
    options.input != null ? JSON.stringify(options.input) : null,
    options.output ?? null,
    options.tokensUsed ?? null,
  );
}

export function queryEvents(options: {
  sessionId?: number;
  type?: EventType;
  name?: string;
  since?: string;
  until?: string;
  limit?: number;
} = {}): EventLog[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options.sessionId != null) { conditions.push("session_id = ?"); params.push(options.sessionId); }
  if (options.type) { conditions.push("type = ?"); params.push(options.type); }
  if (options.name) { conditions.push("name LIKE ?"); params.push(`%${options.name}%`); }
  if (options.since) { conditions.push("created_at >= ?"); params.push(options.since); }
  if (options.until) { conditions.push("created_at <= ?"); params.push(options.until); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db().prepare(
    `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, options.limit ?? 50) as EventLog[];
}

// ─── Cron jobs ────────────────────────────────────────────────────────────────

export function createCronJob(name: string, cronExpr: string, prompt: string, nextRun?: string): CronJob {
  const result = db().prepare(`
    INSERT INTO cron_jobs (name, cron_expr, prompt, next_run)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `).get(name, cronExpr, prompt, nextRun ?? null) as CronJob;
  return result;
}

export function listCronJobs(): CronJob[] {
  return db().prepare("SELECT * FROM cron_jobs ORDER BY next_run ASC").all() as CronJob[];
}

export function getCronJob(name: string): CronJob | null {
  return db().prepare("SELECT * FROM cron_jobs WHERE name = ?").get(name) as CronJob | null;
}

const ALLOWED_CRON_FIELDS = new Set(["cron_expr", "prompt", "last_run", "next_run", "enabled"]);

export function updateCronJob(name: string, updates: Partial<Pick<CronJob, "cron_expr" | "prompt" | "last_run" | "next_run" | "enabled">>): void {
  const entries = Object.entries(updates).filter(([k]) => ALLOWED_CRON_FIELDS.has(k));
  if (entries.length === 0) return;
  const fields = entries.map(([k]) => `${k} = ?`).join(", ");
  const values = entries.map(([, v]) => v);
  db().prepare(`UPDATE cron_jobs SET ${fields} WHERE name = ?`).run(...values, name);
}

export function deleteCronJob(name: string): boolean {
  const result = db().prepare("DELETE FROM cron_jobs WHERE name = ?").run(name);
  return result.changes > 0;
}

export function getDueCronJobs(): CronJob[] {
  return db().prepare(`
    SELECT * FROM cron_jobs
    WHERE enabled = 1
      AND (next_run IS NULL OR next_run <= datetime('now'))
    ORDER BY next_run ASC
  `).all() as CronJob[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatAge(iso: string): string {
  const diff = Date.now() - new Date(iso + "Z").getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
