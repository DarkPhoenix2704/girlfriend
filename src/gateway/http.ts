// HTTP gateway — exposes the GatewayRouter over a local HTTP server.
// The TUI connects here when the daemon is running, so all agent work
// stays in the daemon process (single DB writer, shared scheduler, etc).
//
// POST /stream  — dispatch a message, streams SSE events back
// POST /compact — compact a session's history
// GET  /health  — liveness check

import type { GatewayRouter } from "./router.ts";
import type { RateLimitInfo } from "../agent.ts";
import { log } from "../daemon-log.ts";

// ── SSE helpers ───────────────────────────────────────────────────────────────

const enc = new TextEncoder();
function sse(data: object): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Request body shapes ───────────────────────────────────────────────────────

interface StreamBody {
  text: string;
  session_id?: number | null;
  new_session_name?: string;
  model?: string;
  cwd?: string;
  claude_md?: string;
  claude_md_path?: string;
}

interface CompactBody {
  session_id: number;
  model: string;
  cwd: string;
  claude_md?: string;
  claude_md_path?: string;
}

// ── HttpServer ────────────────────────────────────────────────────────────────

export class HttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(
    private router: GatewayRouter,
    private port: number = 7070,
    private token: string | null = null,
  ) {}

  start(): void {
    this.server = Bun.serve({
      port: this.port,
      fetch: (req) => this.handle(req),
      error: (err) => {
        log("error", "HTTP server error", { error: String(err) });
        return new Response("Internal Server Error", { status: 500 });
      },
    });
    log("info", `HTTP server listening on port ${this.port}`);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private authorized(req: Request): boolean {
    if (!this.token) return true;
    return req.headers.get("Authorization") === `Bearer ${this.token}`;
  }

  // ── Router ────────────────────────────────────────────────────────────────

  private async handle(req: Request): Promise<Response> {
    if (!this.authorized(req)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, pid: process.pid });
    }

    if (req.method === "POST" && url.pathname === "/stream") {
      return this.handleStream(req);
    }

    if (req.method === "POST" && url.pathname === "/compact") {
      return this.handleCompact(req);
    }

    return new Response("Not Found", { status: 404 });
  }

  // ── POST /stream ──────────────────────────────────────────────────────────

  private handleStream(req: Request): Response {
    const router = this.router;
    const clientGone = req.signal;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const abort = new AbortController();
        // If the TUI disconnects, abort the agent run
        clientGone.addEventListener("abort", () => abort.abort(), { once: true });

        let body: StreamBody;
        try {
          body = await req.json() as StreamBody;
        } catch {
          controller.enqueue(sse({ type: "error", message: "invalid JSON body" }));
          controller.close();
          return;
        }

        try {
          const result = await router.dispatch(
            { source: "http", externalId: "tui", text: body.text },
            {
              sessionId: body.session_id,
              newSessionName: body.new_session_name,
              model: body.model,
              cwd: body.cwd,
              claudeMd: body.claude_md,
              claudeMdPath: body.claude_md_path,
              streaming: {
                onText:       (chunk)          => controller.enqueue(sse({ type: "text", chunk })),
                onToolUse:    (name, input, id) => controller.enqueue(sse({ type: "tool_use", name, input, id })),
                onToolResult: (name, result, id) => controller.enqueue(sse({ type: "tool_result", name, result, id })),
                onCompact:    (summary)         => controller.enqueue(sse({ type: "compact", summary })),
                onRateLimit:  (info: RateLimitInfo) => controller.enqueue(sse({ type: "rate_limit", ...info })),
                signal: abort.signal,
              },
            },
          );

          controller.enqueue(sse({
            type: "done",
            session_id:    result.sessionId,
            text:          result.text,
            turns:         result.turns,
            input_tokens:  result.inputTokens,
            output_tokens: result.outputTokens,
          }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(sse({ type: "error", message }));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "X-Accel-Buffering": "no", // disable nginx buffering if proxied
      },
    });
  }

  // ── POST /compact ─────────────────────────────────────────────────────────

  private async handleCompact(req: Request): Promise<Response> {
    let body: CompactBody;
    try {
      body = await req.json() as CompactBody;
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    try {
      const summary = await this.router.compact(
        body.session_id, body.model, body.cwd, body.claude_md, body.claude_md_path,
      );
      return Response.json({ summary });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }
}
