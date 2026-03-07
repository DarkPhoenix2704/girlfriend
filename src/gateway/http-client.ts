// HTTP client — used by the TUI when the daemon is running.
// Implements IRouter by forwarding dispatch/compact calls to the daemon's HTTP server.
// SSE events from the server are translated back into the streaming callbacks
// the TUI chat-screen expects, so the live rendering works identically to direct mode.

import type { IRouter, IncomingMessage, DispatchOptions, DispatchResult } from "./types.ts";
import type { RateLimitInfo } from "../agent.ts";

export class HttpClient implements IRouter {
  constructor(
    private baseUrl: string,
    private token: string | null = null,
  ) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  async dispatch(msg: IncomingMessage, opts: DispatchOptions = {}): Promise<DispatchResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/stream`, {
        method:  "POST",
        headers: this.headers,
        body: JSON.stringify({
          text:             msg.text,
          session_id:       opts.sessionId,
          new_session_name: opts.newSessionName,
          model:            opts.model,
          cwd:              opts.cwd,
          claude_md:        opts.claudeMd,
          claude_md_path:   opts.claudeMdPath,
        }),
        signal: opts.streaming?.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot reach daemon: ${msg}`);
    }

    if (!res.ok) {
      throw new Error(`daemon HTTP ${res.status}: ${await res.text()}`);
    }
    if (!res.body) throw new Error("daemon returned no response body");

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: DispatchResult | null = null;

    // Read SSE stream line by line
    outer: while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch {
        break; // aborted
      }
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        } catch {
          continue;
        }

        switch (event.type) {
          case "text":
            opts.streaming?.onText?.(event.chunk as string);
            break;
          case "tool_use":
            opts.streaming?.onToolUse?.(
              event.name as string, event.input, event.id as string,
            );
            break;
          case "tool_result":
            opts.streaming?.onToolResult?.(
              event.name as string, event.result as string, event.id as string,
            );
            break;
          case "compact":
            opts.streaming?.onCompact?.(event.summary as string);
            break;
          case "rate_limit":
            opts.streaming?.onRateLimit?.(event as unknown as RateLimitInfo);
            break;
          case "done":
            result = {
              sessionId:    event.session_id    as number,
              text:         event.text          as string,
              turns:        event.turns         as number,
              inputTokens:  event.input_tokens  as number,
              outputTokens: event.output_tokens as number,
            };
            break outer;
          case "error":
            throw new Error(event.message as string);
        }
      }
    }

    if (!result) throw new Error("daemon stream ended without a done event");
    return result;
  }

  // ── compact ───────────────────────────────────────────────────────────────

  async compact(
    sessionId: number,
    model: string,
    cwd: string,
    claudeMd?: string,
    claudeMdPath?: string,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/compact`, {
        method:  "POST",
        headers: this.headers,
        body: JSON.stringify({
          session_id:    sessionId,
          model,
          cwd,
          claude_md:     claudeMd,
          claude_md_path: claudeMdPath,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot reach daemon: ${msg}`);
    }

    if (!res.ok) throw new Error(`daemon HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json() as { summary?: string; error?: string };
    if (json.error) throw new Error(json.error);
    return json.summary ?? "";
  }
}
