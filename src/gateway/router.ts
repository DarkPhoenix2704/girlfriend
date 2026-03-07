// Gateway router — single place for session lifecycle, agent execution, and persistence.
// Used by all channels: Telegram, WhatsApp, and the local TUI.

import Anthropic from "@anthropic-ai/sdk";
import {
  getSessionByExternalId, createSession, getSession, renameSession,
  loadMessages, loadReadFiles,
  appendMessages, saveCompactionMessages,
  saveReadFiles, addTokens, logEvent, listMemories, searchMemories,
} from "../sessions.ts";
import { runAgent } from "../agent.ts";
import { compact } from "../compaction.ts";
import { buildSystemPrompt } from "../prompts.ts";
import { TOOL_SCHEMAS } from "../tools.ts";
import { log } from "../daemon-log.ts";
import type { IncomingMessage, OutgoingMessage, Gateway, DispatchOptions, DispatchResult } from "./types.ts";

const DEFAULT_MODEL = process.env.GIRLFRIEND_MODEL ?? "claude-sonnet-4-6";

// Per-session lock — prevents overlapping agent runs for the same session.
// If the previous run is still locked after 5 minutes (e.g. crashed), we escape it.
const _locks = new Map<number, Promise<void>>();
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
function withSessionLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
  const prev = _locks.get(sessionId) ?? Promise.resolve();
  let timedOut = false;
  const prevWithTimeout = Promise.race([
    prev,
    new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, LOCK_TIMEOUT_MS)),
  ]);
  const next = prevWithTimeout.then(() => {
    if (timedOut) {
      log("warn", `session lock timeout for session ${sessionId} — previous run may still be active, forcing unlock`);
    }
    return fn();
  });
  _locks.set(sessionId, next.then(() => {}).catch(() => {}));
  return next;
}

/** Return memories relevant to the current message, scoped to the caller's namespace. */
function loadMemoriesString(query: string, namespace: string): string {
  let facts: import("../sessions.ts").MemoryFact[];
  try {
    facts = searchMemories(query, { limit: 10, namespace });
  } catch {
    facts = [];
  }
  if (facts.length === 0) facts = listMemories({ limit: 10, namespace });
  if (facts.length === 0) return "";
  return facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
}

/** Call Haiku to generate a short session name from the first exchange. Fire-and-forget. */
async function autoNameSession(client: Anthropic, sessionId: number, userText: string, agentText: string): Promise<void> {
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 15,
      messages: [{
        role: "user",
        content: `Title this conversation in 4-6 words. Reply with ONLY the title, no punctuation or quotes.\n\nUser: ${userText.slice(0, 300)}\nAssistant: ${agentText.slice(0, 300)}`,
      }],
    });
    const name = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text).join("").trim()
      .replace(/^["'`]|["'`]$/g, "")
      .slice(0, 60);
    if (name) renameSession(sessionId, name);
  } catch { /* non-fatal — keep the default name */ }
}

/** Wrap a gateway message callback with a 2-second batcher per externalId. */
function makeBatcher(
  handler: (msg: IncomingMessage) => Promise<void>,
  delayMs = 2_000,
): (msg: IncomingMessage) => Promise<void> {
  const pending = new Map<string, {
    texts: string[];
    lastMsg: IncomingMessage;
    timer: ReturnType<typeof setTimeout>;
    waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
  }>();

  async function fire(key: string) {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    const text = entry.texts.length === 1
      ? entry.texts[0]!
      : entry.texts.join("\n\n---\n\n");
    try {
      await handler({ ...entry.lastMsg, text });
      for (const { resolve } of entry.waiters) resolve();
    } catch (err) {
      for (const { reject } of entry.waiters) reject(err);
    }
  }

  return (msg: IncomingMessage): Promise<void> => {
    const key = msg.externalId;
    const entry = pending.get(key);
    const p = new Promise<void>((resolve, reject) => {
      if (entry) {
        clearTimeout(entry.timer);
        entry.texts.push(msg.text);
        entry.lastMsg = msg;
        entry.waiters.push({ resolve, reject });
        entry.timer = setTimeout(() => fire(key), delayMs);
      } else {
        const newEntry = {
          texts: [msg.text],
          lastMsg: msg,
          timer: setTimeout(() => fire(key), delayMs),
          waiters: [{ resolve, reject }],
        };
        pending.set(key, newEntry);
      }
    });
    return p;
  };
}

/** Split long text into chunks at word/newline boundaries. */
export function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut < 1) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class GatewayRouter {
  private client: Anthropic;
  private gateways = new Map<string, Gateway>();

  constructor(client: Anthropic) {
    this.client = client;
  }

  register(gateway: Gateway): void {
    this.gateways.set(gateway.source, gateway);
  }

  async start(): Promise<void> {
    for (const gw of this.gateways.values()) {
      const batched = makeBatcher((msg) => this.dispatch(msg).then(() => {}));
      await gw.start(batched);
      log("info", `gateway started: ${gw.source}`);
    }
  }

  async stop(): Promise<void> {
    for (const gw of this.gateways.values()) {
      await gw.stop();
    }
  }

  /**
   * Core dispatch — resolves session, runs agent, persists, sends reply.
   * The TUI passes streaming callbacks + explicit sessionId.
   * Async gateways (Telegram/WhatsApp) pass neither — session is looked up by externalId.
   */
  async dispatch(msg: IncomingMessage, options: DispatchOptions = {}): Promise<DispatchResult> {
    const model = options.model ?? DEFAULT_MODEL;

    // Namespace scopes memories to the specific user; only set for user-facing gateways.
    const namespace = (msg.source === "telegram" || msg.source === "whatsapp")
      ? `${msg.source}:${msg.externalId}`
      : undefined;

    // ── Resolve session ───────────────────────────────────────────────────────
    let sessionId: number;

    if (options.sessionId != null) {
      // Explicit session ID (TUI resuming a session)
      sessionId = options.sessionId;
    } else if (options.sessionId === null) {
      // Explicitly create a new session
      const name = options.newSessionName
        ?? `${msg.source}-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      sessionId = createSession(name, model, msg.source, msg.externalId, namespace);
      log("info", `new session created`, { source: msg.source, sessionId });
    } else {
      // Look up by source + externalId (gateway mode)
      const existing = getSessionByExternalId(msg.source, msg.externalId);
      if (existing) {
        sessionId = existing.id;
      } else {
        const name = msg.senderName
          ? `${msg.source}:${msg.senderName}`
          : `${msg.source}:${msg.externalId}`;
        sessionId = createSession(name, model, msg.source, msg.externalId, namespace);
        log("info", `new session for ${msg.source}:${msg.externalId}`, { sessionId });
      }
    }

    logEvent("message_received", { sessionId, name: msg.source, input: msg.text.slice(0, 500) });

    return withSessionLock(sessionId, async () => {
      const history = loadMessages(sessionId);
      const readFiles = loadReadFiles(sessionId);
      const savedLength = history.length;

      try {
        // Inject memories scoped to this user's namespace (telegram/whatsapp only)
        const memories = namespace ? loadMemoriesString(msg.text, namespace) : undefined;

        const result = await runAgent(msg.text, {
          client: this.client,
          model,
          sessionId,
          namespace,
          cwd: options.cwd ?? process.cwd(),
          claudeMd: options.claudeMd,
          claudeMdPath: options.claudeMdPath,
          memories,
          history,
          readFiles,
          askUser:      options.askUser,
          onText:       options.streaming?.onText,
          onToolUse:    options.streaming?.onToolUse,
          onToolResult: options.streaming?.onToolResult,
          onCompact:    options.streaming?.onCompact,
          onRateLimit:  options.streaming?.onRateLimit,
          signal:       options.streaming?.signal,
        });

        // Persist
        if (result.compacted) {
          saveCompactionMessages(sessionId, result.history);
        } else {
          appendMessages(sessionId, result.history, savedLength);
        }
        saveReadFiles(sessionId, result.readFiles);
        addTokens(sessionId, result.inputTokens, result.outputTokens);

        // Auto-name new sessions after first turn (fire and forget)
        if (savedLength === 0 && result.text) {
          autoNameSession(this.client, sessionId, msg.text, result.text).catch(() => {});
        }

        // Send reply for async gateways (TUI uses streaming callbacks instead)
        if (!options.streaming?.onText) {
          const gw = this.gateways.get(msg.source);
          if (gw && result.text) {
            for (const chunk of splitMessage(result.text)) {
              await gw.send({ source: msg.source, externalId: msg.externalId, text: chunk });
            }
          }
        }

        return {
          sessionId,
          text: result.text,
          turns: result.turns,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log("error", `agent error for ${msg.source}:${msg.externalId}`, { error: errMsg });
        // Only send error back for async gateways
        if (!options.streaming?.onText) {
          const gw = this.gateways.get(msg.source);
          await gw?.send({ source: msg.source, externalId: msg.externalId, text: `Error: ${errMsg}` });
        }
        throw err;
      }
    });
  }

  /** Send a message directly through a registered gateway (for proactive notifications). */
  async sendDirect(msg: OutgoingMessage): Promise<void> {
    const gw = this.gateways.get(msg.source);
    if (!gw) throw new Error(`no gateway registered for source: ${msg.source}`);
    await gw.send(msg);
  }

  /** Force-compact the history for a given session (used by /compact TUI command). */
  async compact(sessionId: number, model: string, cwd: string, claudeMd?: string, claudeMdPath?: string): Promise<string> {
    const history = loadMessages(sessionId);
    if (history.length === 0) return "";
    const systemPrompt = buildSystemPrompt({
      tools: TOOL_SCHEMAS.map(t => t.name),
      cwd, model, claudeMd, claudeMdPath,
      platform: process.platform,
      shell: process.env.SHELL ?? "bash",
    });
    const summary = await compact(this.client, history, systemPrompt, model);
    saveCompactionMessages(sessionId, [{ role: "user", content: summary }]);
    return summary;
  }

  /** Create a new local session and return its ID. */
  newLocalSession(model: string, name?: string): number {
    const sessionName = name ?? `session-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    return createSession(sessionName, model, "local");
  }

  /** Rename a session. */
  renameSession(sessionId: number, name: string): void {
    renameSession(sessionId, name);
  }

  getSession(sessionId: number) {
    return getSession(sessionId);
  }
}
