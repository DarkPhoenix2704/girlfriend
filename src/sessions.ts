// Session persistence using bun:sqlite
// Stores conversation history so you can create, resume, and list sessions.

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import type Anthropic from "@anthropic-ai/sdk";

// DB lives in ~/.agent-claw/sessions.db
const DB_DIR = join(process.env.HOME ?? ".", ".agent-claw");
const DB_PATH = join(DB_DIR, "sessions.db");

export interface Session {
  id: number;
  name: string;
  model: string;
  created_at: string;
  updated_at: string;
  total_input_tokens: number;
  total_output_tokens: number;
  message_count: number;
}

// ─── DB init ──────────────────────────────────────────────────────────────────

let _db: Database | null = null;

function db(): Database {
  if (_db) return _db;
  mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec(`
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
      content    TEXT NOT NULL,  -- JSON-encoded Anthropic content
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS read_files (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      file_path  TEXT NOT NULL,
      PRIMARY KEY (session_id, file_path)
    );
  `);
  return _db;
}

// ─── Session CRUD ─────────────────────────────────────────────────────────────

export function createSession(name: string, model: string): number {
  const result = db()
    .prepare("INSERT INTO sessions (name, model) VALUES (?, ?) RETURNING id")
    .get(name, model) as { id: number };
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

// ─── Message persistence ──────────────────────────────────────────────────────

export function saveMessage(sessionId: number, msg: Anthropic.MessageParam): void {
  db()
    .prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
    .run(sessionId, msg.role, JSON.stringify(msg.content));
}

export function loadMessages(sessionId: number): Anthropic.MessageParam[] {
  const rows = db()
    .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC")
    .all(sessionId) as { role: string; content: string }[];
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
