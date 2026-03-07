// TUI entry point — manages the renderer and screen transitions

import {
  createCliRenderer,
} from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { setTaskExecutor, setActiveRouter } from "../tools.ts";
import { createTaskExecutor } from "../subagent.ts";
import { getSession } from "../sessions.ts";
import { checkForUpdates, getUpdateNotice } from "../updater.ts";
import { mountSessionScreen } from "./session-screen.ts";
import { mountModelScreen } from "./model-screen.ts";
import { mountChatScreen } from "./chat-screen.ts";
import { mountMemoryScreen } from "./memory-screen.ts";
import { GatewayRouter } from "../gateway/router.ts";
import { LocalGateway } from "../gateway/local.ts";
import { HttpClient } from "../gateway/http-client.ts";
import type { IRouter } from "../gateway/types.ts";
import { isDaemonRunning } from "../pid.ts";
import { loadConfig } from "../config.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface AppOptions {
  client: Anthropic;
  model: string;
  cwd: string;
  initialSessionId?: number;
}

export async function runApp(opts: AppOptions): Promise<void> {
  let currentModel = opts.model;

  // Always create a local router (tools run on this machine)
  const localRouter = new GatewayRouter(opts.client);
  localRouter.register(new LocalGateway());
  setActiveRouter(localRouter);

  // If daemon is running, also create an HTTP client for daemon mode
  const daemonRouter: IRouter | null = isDaemonRunning()
    ? (() => {
        const cfg = loadConfig();
        const token = process.env.GIRLFRIEND_HTTP_TOKEN ?? null;
        return new HttpClient(`http://localhost:${cfg.http.port}`, token);
      })()
    : null;

  // Register Task tool executor — reads currentModel, callbacks, and sessionId at call time
  setTaskExecutor(async (input, cwd, callbacks, sessionId) => {
    const executor = createTaskExecutor(
      { Explore: { description: "Codebase exploration", prompt: "", tools: ["Read", "Glob", "Grep", "WebFetch"] } },
      { client: opts.client, parentModel: currentModel, cwd, sessionId },
      callbacks,
    );
    return executor(input);
  });

  // Check for updates in the background — never blocks startup
  checkForUpdates();
  const updateNotice = getUpdateNotice();

  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });

  renderer.root.flexDirection = "column";
  renderer.root.width = "100%";
  renderer.root.height = "100%";

  // Load CLAUDE.md relative to cwd
  let claudeMd: string | undefined;
  let claudeMdPath: string | undefined;
  for (const p of [join(opts.cwd, "CLAUDE.md"), join(opts.cwd, ".claude", "CLAUDE.md")]) {
    if (existsSync(p)) { claudeMd = readFileSync(p, "utf-8"); claudeMdPath = p; break; }
  }

  // ── Screen management ───────────────────────────────────────────────────────
  let screenCleanup: (() => void) | null = null;
  let lastChatSessionId: number | null = null;

  function clearRoot() {
    screenCleanup?.();
    screenCleanup = null;
    for (const child of [...renderer.root.getChildren()]) {
      renderer.root.remove(child.id);
    }
  }

  // ── Global Ctrl+C ───────────────────────────────────────────────────────────
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") renderer.destroy();
  });

  // ── Screen mount functions ──────────────────────────────────────────────────
  function showMemoryScreen() {
    clearRoot();
    screenCleanup = mountMemoryScreen({
      renderer,
      onBack: () => showSessionScreen(),
    });
  }

  function showSessionScreen() {
    clearRoot();
    screenCleanup = mountSessionScreen({
      renderer,
      updateNotice,
      lastChatSessionId,
      onOpenSession: (id) => showChatScreen(id),
      onNewSession: () => showChatScreen(null),
      onMemoryScreen: () => showMemoryScreen(),
      onBack: () => showChatScreen(lastChatSessionId),
    });
  }

  async function showModelScreen() {
    clearRoot();
    screenCleanup = await mountModelScreen({
      renderer,
      client: opts.client,
      onSelect: (modelId) => {
        currentModel = modelId;
        showChatScreen(lastChatSessionId);
      },
      onBack: () => showChatScreen(lastChatSessionId),
    });
  }

  function showChatScreen(initialSessionId: number | null) {
    clearRoot();
    if (initialSessionId != null) lastChatSessionId = initialSessionId;
    screenCleanup = mountChatScreen({
      renderer,
      localRouter,
      daemonRouter,
      currentModel,
      cwd: opts.cwd,
      claudeMd,
      claudeMdPath,
      updateNotice,
      lastChatSessionId,
      initialSessionId,
      onSessionListRequested: () => showSessionScreen(),
      onModelScreenRequested: () => showModelScreen(),
      onMemoryScreenRequested: () => showMemoryScreen(),
      onNewChatRequested: () => showChatScreen(null),
      onSessionIdChanged: (id) => { lastChatSessionId = id; },
    });
  }

  // ── Initial screen ──────────────────────────────────────────────────────────
  if (opts.initialSessionId != null && getSession(opts.initialSessionId)) {
    showChatScreen(opts.initialSessionId);
  } else {
    showChatScreen(null);
  }

  await new Promise<void>((resolve) => {
    (renderer as import("events").EventEmitter).on("destroy", resolve);
  });
  (screenCleanup as (() => void) | null)?.();
}
