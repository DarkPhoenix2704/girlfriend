// Gateway interface — every channel (Telegram, WhatsApp, HTTP, local TUI) implements this.

import type { RateLimitInfo } from "../agent.ts";

export type GatewaySource = "local" | "telegram" | "whatsapp" | "http";

export interface IncomingMessage {
  source: GatewaySource;
  /** Unique identifier within the source (chat_id, phone number, "local", etc.) */
  externalId: string;
  senderName?: string;
  text: string;
}

export interface OutgoingMessage {
  source: GatewaySource;
  externalId: string;
  text: string;
}

/** Streaming callbacks — used by the TUI for live rendering. Async gateways leave these empty. */
export interface StreamingCallbacks {
  onText?: (chunk: string) => void;
  onToolUse?: (name: string, input: unknown, id: string) => void;
  onToolResult?: (name: string, result: string, id: string) => void;
  onCompact?: (summary: string) => void;
  onRateLimit?: (info: RateLimitInfo) => void;
  signal?: AbortSignal;
}

export interface DispatchOptions {
  /** Explicit session ID to use. null = create new session. undefined = look up by externalId. */
  sessionId?: number | null;
  /** Name for a newly-created session (when sessionId is null) */
  newSessionName?: string;
  /** Model override */
  model?: string;
  /** Working directory for tools */
  cwd?: string;
  /** CLAUDE.md content */
  claudeMd?: string;
  claudeMdPath?: string;
  /** Streaming callbacks for interactive (TUI) use */
  streaming?: StreamingCallbacks;
  /** AskUser callback — wires up the AskUserQuestion tool for interactive (TUI) sessions. */
  askUser?: (question: string, options?: string[]) => Promise<string>;
}

export interface DispatchResult {
  sessionId: number;
  text: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Gateway {
  readonly source: GatewaySource;
  start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void>;
  send(msg: OutgoingMessage): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Minimal router interface used by the TUI chat-screen.
 * Implemented by both GatewayRouter (direct, no daemon) and HttpClient (daemon mode).
 */
export interface IRouter {
  dispatch(msg: IncomingMessage, opts?: DispatchOptions): Promise<DispatchResult>;
  compact(sessionId: number, model: string, cwd: string, claudeMd?: string, claudeMdPath?: string): Promise<string>;
}
