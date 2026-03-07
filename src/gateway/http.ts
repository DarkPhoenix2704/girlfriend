// HTTP gateway — exposes the GatewayRouter over a local HTTP server.
// The TUI connects here when the daemon is running, so all agent work
// stays in the daemon process (single DB writer, shared scheduler, etc).
//
// POST /stream  — dispatch a message, streams SSE events back
// POST /compact — compact a session's history
// GET  /health  — liveness check

import type { Server } from "bun";
import type { GatewayRouter } from "./router.ts";
import type { RateLimitInfo } from "../agent.ts";
import { log } from "../daemon-log.ts";
import { listSessions, getSession, loadMessages } from "../sessions.ts";

// ── SSE helpers ───────────────────────────────────────────────────────────────

const enc = new TextEncoder();
function sse(data: object): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Request body shapes ───────────────────────────────────────────────────────

interface ChatBody {
  text: string;
  session_id?: number | null;
  new_session_name?: string;
  model?: string;
  cwd?: string;
}

interface StreamBody extends ChatBody {
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
    if (!this.token) {
      log("warn", "HTTP server has no auth token — set GIRLFRIEND_HTTP_TOKEN to require authentication");
    }
    try {
      this.server = Bun.serve({
        hostname: "127.0.0.1",
        port: this.port,
        fetch: (req, server) => this.handle(req, server),
        error: (err) => {
          log("error", "HTTP server error", { error: String(err) });
          return new Response("Internal Server Error", { status: 500 });
        },
      });
      log("info", `HTTP server listening on 127.0.0.1:${this.port}`);
    } catch (err) {
      log("error", `HTTP server failed to bind to port ${this.port}: ${String(err)}`);
      throw err;
    }
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

  private async handle(req: Request, server: Server): Promise<Response> {
    if (!this.authorized(req)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const ip = server.requestIP(req)?.address ?? "unknown";
    if (this.isRateLimited(ip)) {
      return new Response("Too Many Requests", { status: 429 });
    }

    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, pid: process.pid });
    }

    // Simple JSON chat — blocks until agent finishes, returns { session_id, text, turns, input_tokens, output_tokens }
    if (req.method === "POST" && url.pathname === "/chat") {
      return this.handleChat(req);
    }

    // SSE streaming chat — same as /chat but streams events in real-time
    if (req.method === "POST" && url.pathname === "/stream") {
      return this.handleStream(req);
    }

    if (req.method === "POST" && url.pathname === "/compact") {
      return this.handleCompact(req);
    }

    // Session listing and inspection
    if (req.method === "GET" && url.pathname === "/sessions") {
      const limit = parseInt(url.searchParams.get("limit") ?? "20");
      return Response.json(listSessions(limit));
    }

    if (req.method === "GET" && url.pathname.startsWith("/sessions/")) {
      const id = parseInt(url.pathname.split("/")[2] ?? "");
      if (isNaN(id)) return new Response("Bad Request", { status: 400 });
      const session = getSession(id);
      if (!session) return new Response("Not Found", { status: 404 });
      const messages = url.searchParams.has("messages") ? loadMessages(id) : undefined;
      return Response.json({ ...session, messages });
    }

    return new Response("Not Found", { status: 404 });
  }

  // ── POST /chat ────────────────────────────────────────────────────────────

  private async handleChat(req: Request): Promise<Response> {
    const parsed = await this.readJson<ChatBody>(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed;
    if (!body.text) return Response.json({ error: "text is required" }, { status: 400 });

    try {
      const result = await this.router.dispatch(
        { source: "http", externalId: "api", text: body.text },
        {
          sessionId:      body.session_id,
          newSessionName: body.new_session_name,
          model:          body.model,
          cwd:            body.cwd,
        },
      );
      return Response.json({
        session_id:    result.sessionId,
        text:          result.text,
        turns:         result.turns,
        input_tokens:  result.inputTokens,
        output_tokens: result.outputTokens,
      });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  // ── POST /stream ──────────────────────────────────────────────────────────

  private async handleStream(req: Request): Promise<Response> {
    const parsed = await this.readJson<StreamBody>(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    const router = this.router;
    const abort = new AbortController();
    // If the TUI disconnects, abort the agent run
    req.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
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
    const parsed = await this.readJson<CompactBody>(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed;
    try {
      const summary = await this.router.compact(
        body.session_id, body.model, body.cwd, body.claude_md, body.claude_md_path,
      );
      return Response.json({ summary });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  // ── Rate limiting (per IP, 30 req/min) ────────────────────────────────────

  private readonly _rateLimits = new Map<string, { count: number; resetAt: number }>();

  private isRateLimited(ip: string, max = 30, windowMs = 60_000): boolean {
    const now = Date.now();
    const entry = this._rateLimits.get(ip);
    if (!entry || now >= entry.resetAt) {
      this._rateLimits.set(ip, { count: 1, resetAt: now + windowMs });
      return false;
    }
    if (entry.count >= max) return true;
    entry.count++;
    return false;
  }

  // ── Body helpers ──────────────────────────────────────────────────────────

  private static readonly MAX_BODY_BYTES = 1_048_576; // 1 MB

  private async readJson<T>(req: Request): Promise<T | Response> {
    const cl = parseInt(req.headers.get("content-length") ?? "");
    if (!isNaN(cl) && cl > HttpServer.MAX_BODY_BYTES) {
      return Response.json({ error: "request body too large" }, { status: 413 });
    }
    const buf = await req.arrayBuffer();
    if (buf.byteLength > HttpServer.MAX_BODY_BYTES) {
      return Response.json({ error: "request body too large" }, { status: 413 });
    }
    try {
      return JSON.parse(new TextDecoder().decode(buf)) as T;
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
  }
}
