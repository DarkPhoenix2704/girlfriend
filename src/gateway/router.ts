// Gateway router — maps incoming messages to sessions, runs the agent, sends reply.
// One router instance serves all gateways.

import Anthropic from "@anthropic-ai/sdk";
import {
  getSessionByExternalId, createSession,
  loadMessages, loadReadFiles, appendMessages, saveCompactionMessages,
  saveReadFiles, addTokens, logEvent,
} from "../sessions.ts";
import { runAgent } from "../agent.ts";
import { setActiveSession } from "../tools.ts";
import { log } from "../daemon-log.ts";
import type { IncomingMessage, Gateway, GatewaySource } from "./types.ts";

const MODEL = process.env.OPENCLAW_MODEL ?? "claude-sonnet-4-6";

// Per-session lock — prevents overlapping agent runs for the same user
const _locks = new Map<number, Promise<void>>();

function withSessionLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
  const prev = _locks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn);
  // Clean up lock reference once done
  _locks.set(sessionId, next.then(() => {}).catch(() => {}));
  return next;
}

/** Split long text into chunks that fit within maxLen, breaking at word boundaries. */
function splitMessage(text: string, maxLen = 4000): string[] {
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
      await gw.start((msg) => this.dispatch(msg));
      log("info", `gateway started: ${gw.source}`);
    }
  }

  async stop(): Promise<void> {
    for (const gw of this.gateways.values()) {
      await gw.stop();
    }
  }

  private async dispatch(msg: IncomingMessage): Promise<void> {
    const source: GatewaySource = msg.source;

    // Find or create a persistent session for this user
    let session = getSessionByExternalId(source, msg.externalId);
    if (!session) {
      const name = msg.senderName
        ? `${source}:${msg.senderName}`
        : `${source}:${msg.externalId}`;
      const sessionId = createSession(name, MODEL, source as "telegram" | "whatsapp" | "http", msg.externalId);
      session = { id: sessionId } as NonNullable<typeof session>;
      log("info", `new session for ${source}:${msg.externalId}`, { sessionId });
    }

    const sessionId = session!.id;

    logEvent("message_received", {
      sessionId,
      name: source,
      input: msg.text.slice(0, 500),
    });

    await withSessionLock(sessionId, async () => {
      const history = loadMessages(sessionId);
      const readFiles = loadReadFiles(sessionId);
      const savedLength = history.length;

      setActiveSession(sessionId);

      try {
        const result = await runAgent(msg.text, {
          client: this.client,
          model: MODEL,
          sessionId,
          history,
          readFiles,
        });

        // Persist conversation
        if (result.compacted) {
          saveCompactionMessages(sessionId, result.history);
        } else {
          appendMessages(sessionId, result.history, savedLength);
        }
        saveReadFiles(sessionId, result.readFiles);
        addTokens(sessionId, result.inputTokens, result.outputTokens);

        // Send reply back through the originating gateway
        const gw = this.gateways.get(source);
        if (gw && result.text) {
          const chunks = splitMessage(result.text);
          for (const chunk of chunks) {
            await gw.send({ source: msg.source, externalId: msg.externalId, text: chunk });
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log("error", `agent error for ${source}:${msg.externalId}`, { error: errMsg });
        const gw = this.gateways.get(source);
        await gw?.send({ source: msg.source, externalId: msg.externalId, text: `Error: ${errMsg}` });
      } finally {
        setActiveSession(null);
      }
    });
  }
}
