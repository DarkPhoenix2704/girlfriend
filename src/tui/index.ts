// TUI entry point — manages the renderer and screen transitions

import {
  createCliRenderer,
} from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { setTaskExecutor } from "../tools.ts";
import { createTaskExecutor } from "../subagent.ts";
import { getSession } from "../sessions.ts";
import { checkForUpdates, getUpdateNotice } from "../updater.ts";
import { mountSessionScreen } from "./session-screen.ts";
import { mountModelScreen } from "./model-screen.ts";
import { mountChatScreen } from "./chat-screen.ts";
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

  // Register Task tool executor (runs subagents) — reads currentModel at call time
  setTaskExecutor(async (input, cwd) => {
    const executor = createTaskExecutor(
      { Explore: { description: "Codebase exploration", prompt: "", tools: ["Read", "Glob", "Grep", "WebFetch"] } },
      { client: opts.client, parentModel: currentModel, cwd }
    );
    const result = await executor(input);
    return { content: result };
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
  function showSessionScreen() {
    clearRoot();
    screenCleanup = mountSessionScreen({
      renderer,
      updateNotice,
      lastChatSessionId,
      onOpenSession: (id) => showChatScreen(id),
      onNewSession: () => showChatScreen(null),
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
      client: opts.client,
      currentModel,
      cwd: opts.cwd,
      claudeMd,
      claudeMdPath,
      updateNotice,
      lastChatSessionId,
      initialSessionId,
      onSessionListRequested: () => showSessionScreen(),
      onModelScreenRequested: () => showModelScreen(),
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
  screenCleanup?.();
}
