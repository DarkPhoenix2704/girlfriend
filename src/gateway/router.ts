// Gateway router — single place for session lifecycle, agent execution, and persistence.
// Used by all channels: Telegram, WhatsApp, and the local TUI.

import Anthropic from "@anthropic-ai/sdk";
import {
  getSessionByExternalId, createSession, getSession,
  loadMessages, loadReadFiles,
  appendMessages, saveCompactionMessages,
  saveReadFiles, addTokens, logEvent,
} from "../sessions.ts";
import { runAgent } from "../agent.ts";
import { compact } from "../compaction.ts";
import { buildSystemPrompt } from "../prompts.ts";
import { TOOL_SCHEMAS, setActiveSession } from "../tools.ts";
import { log } from "../daemon-log.ts";
import type { IncomingMessage, OutgoingMessage, Gateway, DispatchOptions, DispatchResult } from "./types.ts";

const DEFAULT_MODEL = process.env.GIRLFRIEND_MODEL ?? "claude-sonnet-4-6";

// Per-session lock — prevents overlapping agent runs for the same session
const _locks = new Map<number, Promise<void>>();
function withSessionLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
  const prev = _locks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn);
  _locks.set(sessionId, next.then(() => {}).catch(() => {}));
  return next;
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
      await gw.start((msg) => this.dispatch(msg).then(() => {}));
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

    // ── Resolve session ───────────────────────────────────────────────────────
    let sessionId: number;

    if (options.sessionId != null) {
      // Explicit session ID (TUI resuming a session)
      sessionId = options.sessionId;
    } else if (options.sessionId === null) {
      // Explicitly create a new session
      const name = options.newSessionName
        ?? `${msg.source}-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      sessionId = createSession(name, model, msg.source, msg.externalId);
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
        sessionId = createSession(name, model, msg.source, msg.externalId);
        log("info", `new session for ${msg.source}:${msg.externalId}`, { sessionId });
      }
    }

    logEvent("message_received", { sessionId, name: msg.source, input: msg.text.slice(0, 500) });

    return withSessionLock(sessionId, async () => {
      const history = loadMessages(sessionId);
      const readFiles = loadReadFiles(sessionId);
      const savedLength = history.length;

      setActiveSession(sessionId);

      try {
        const result = await runAgent(msg.text, {
          client: this.client,
          model,
          sessionId,
          cwd: options.cwd ?? process.cwd(),
          claudeMd: options.claudeMd,
          claudeMdPath: options.claudeMdPath,
          history,
          readFiles,
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
      } finally {
        setActiveSession(null);
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
    const { renameSession } = require("../sessions.ts") as typeof import("../sessions.ts");
    renameSession(sessionId, name);
  }

  getSession(sessionId: number) {
    return getSession(sessionId);
  }
}
