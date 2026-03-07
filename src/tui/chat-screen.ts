// Chat screen — the main interactive conversation view

import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  SyntaxStyle,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { PINK, YELLOW, RED, MUTED, FG, BG } from "./theme.ts";
import { runAgent } from "../agent.ts";
import type { RateLimitInfo } from "../agent.ts";
import { compact } from "../compaction.ts";
import { buildSystemPrompt } from "../prompts.ts";
import { TOOL_SCHEMAS } from "../tools.ts";
import {
  createSession, getSession, renameSession,
  loadMessages, loadReadFiles, appendMessages, saveCompactionMessages,
  saveReadFiles, addTokens,
} from "../sessions.ts";
import type { Session } from "../sessions.ts";
import type Anthropic from "@anthropic-ai/sdk";

type ContentBlock = Anthropic.TextBlock | Anthropic.ToolUseBlock;

export interface ChatScreenContext {
  renderer: CliRenderer;
  client: Anthropic;
  currentModel: string;
  cwd: string;
  claudeMd: string | undefined;
  claudeMdPath: string | undefined;
  updateNotice: string | null;
  lastChatSessionId: number | null;
  initialSessionId: number | null;
  onSessionListRequested: () => void;
  onModelScreenRequested: () => void;
  onNewChatRequested: () => void;
  /** Called when this screen updates the lastChatSessionId */
  onSessionIdChanged: (id: number) => void;
}

export function mountChatScreen(ctx: ChatScreenContext): () => void {
  const { renderer } = ctx;
  const syntax = SyntaxStyle.create();

  let sessionId: number | null = ctx.initialSessionId;
  let session: Session | null = sessionId != null ? getSession(sessionId)! : null;
  let history = sessionId != null ? loadMessages(sessionId) : [] as ReturnType<typeof loadMessages>;
  let readFiles = sessionId != null ? loadReadFiles(sessionId) : new Set<string>();
  let savedLength = history.length;
  let pendingCompaction = false;
  let agentRunning = false;
  let agentAbort: AbortController | null = null;
  let escPrimed = false;
  const pendingTools = new Map<string, TextRenderable>();
  let lastAgentText = "";
  let headerSessionText: TextRenderable;

  // Lazily create session on first message
  function ensureSession(): number {
    if (sessionId != null) return sessionId;
    const name = `session-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    sessionId = createSession(name, ctx.currentModel);
    ctx.onSessionIdChanged(sessionId);
    session = getSession(sessionId)!;
    headerSessionText.content = `#${sessionId}  ·  ${session.name}`;
    return sessionId;
  }

  // ── Auto-save ─────────────────────────────────────────────────────────────
  const autoSave = setInterval(() => {
    if (sessionId == null) return;
    if (pendingCompaction) {
      saveCompactionMessages(sessionId, history);
      saveReadFiles(sessionId, readFiles);
      savedLength = history.length;
      pendingCompaction = false;
    } else if (history.length > savedLength) {
      appendMessages(sessionId, history, savedLength);
      saveReadFiles(sessionId, readFiles);
      savedLength = history.length;
    }
  }, 3_000);

  function flushAndCleanup() {
    stopSpinner();
    clearInterval(autoSave);
    if (sessionId == null) return;
    if (pendingCompaction) {
      saveCompactionMessages(sessionId, history);
    } else {
      appendMessages(sessionId, history, savedLength);
    }
    saveReadFiles(sessionId, readFiles);
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  const header = new BoxRenderable(renderer, {
    width: "100%", height: 5,
    border: true, borderStyle: "rounded", borderColor: PINK,
    flexDirection: "row", paddingLeft: 1, paddingRight: 1,
  });
  const headerEmoji = new TextRenderable(renderer, {
    content: "(❀◕‿◕❀)", fg: BG, bg: PINK, alignSelf: "center", marginRight: 2,
  });
  const headerInfo = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, justifyContent: "center" });
  headerInfo.add(new TextRenderable(renderer, { content: "girlfriend", fg: PINK }));
  const headerModelText = new TextRenderable(renderer, { content: ctx.currentModel, fg: MUTED });
  headerInfo.add(headerModelText);
  headerSessionText = new TextRenderable(renderer, {
    content: sessionId != null ? `#${sessionId}  ·  ${session!.name}` : "new session", fg: MUTED,
  });
  headerInfo.add(headerSessionText);
  if (ctx.updateNotice) {
    headerInfo.add(new TextRenderable(renderer, {
      content: `update available: ${ctx.updateNotice}  →  bunx gf-uwu`, fg: YELLOW,
    }));
  }
  header.add(headerEmoji);
  header.add(headerInfo);
  renderer.root.add(header);

  const chat = new ScrollBoxRenderable(renderer, {
    width: "100%", flexGrow: 1,
    stickyScroll: true, stickyStart: "bottom",
    scrollY: true, paddingLeft: 2, paddingRight: 2,
  });
  renderer.root.add(chat);

  // ── Autocomplete bar ──────────────────────────────────────────────────────
  const COMMANDS = ["/sessions", "/new", "/rename ", "/reset", "/compact", "/model"];

  const acBar = new BoxRenderable(renderer, {
    width: "100%", height: 1,
    flexDirection: "row", paddingLeft: 2, gap: 3,
    visible: false,
  });
  const acChips = COMMANDS.map((cmd) => {
    const t = new TextRenderable(renderer, { content: cmd, fg: MUTED });
    acBar.add(t);
    return t;
  });
  renderer.root.add(acBar);

  let acMatches: string[] = [];
  let acIdx = -1;

  function highlightChips() {
    acChips.forEach((chip, i) => {
      const isMatch = acMatches.includes(COMMANDS[i]!);
      const isSelected = acIdx >= 0 && acMatches[acIdx] === COMMANDS[i];
      chip.fg = isSelected ? PINK : isMatch ? FG : MUTED;
    });
  }

  function updateAc(value: string) {
    if (acIdx >= 0 && acMatches[acIdx]?.trimEnd() === value.trimEnd()) return;
    acIdx = -1;
    if (!value.startsWith("/") || value.includes(" ")) {
      acBar.visible = false; acMatches = []; return;
    }
    acMatches = COMMANDS.filter((c) => c.trimEnd().startsWith(value));
    highlightChips();
    acBar.visible = acMatches.length > 0;
  }

  // ── Spinner ───────────────────────────────────────────────────────────────
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerFrame = 0;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerLabel: TextRenderable | null = null;

  function startSpinner(label: TextRenderable) {
    spinnerLabel = label;
    spinnerInterval = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      if (spinnerLabel) spinnerLabel.content = `${SPINNER_FRAMES[spinnerFrame]}    `;
    }, 80);
  }

  function stopSpinner() {
    if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
    if (spinnerLabel) { spinnerLabel.content = "♥    "; spinnerLabel = null; }
  }

  // ── Input box ─────────────────────────────────────────────────────────────
  const inputBox = new BoxRenderable(renderer, {
    width: "100%", height: 3,
    border: true, borderStyle: "rounded", borderColor: PINK,
  });
  inputBox.titleAlignment = "right";
  const inputField = new InputRenderable(renderer, {
    width: "100%", paddingLeft: 1,
    placeholder: "message…",
  });
  inputBox.add(inputField);
  renderer.root.add(inputBox);

  function updateRateLimit(info: RateLimitInfo) {
    const parts: string[] = [];
    if (info.unified5hUtilization !== null) {
      const pct = (info.unified5hUtilization * 100).toFixed(0);
      const status = info.unifiedStatus === "allowed" ? "" : ` ⚠ ${info.unifiedStatus}`;
      parts.push(`5h: ${pct}%${status}`);
    }
    if (info.unified7dUtilization !== null)
      parts.push(`7d: ${(info.unified7dUtilization * 100).toFixed(0)}%`);
    if (info.unifiedFallback && info.unifiedFallback !== "available")
      parts.push(`fallback: ${info.unifiedFallback}`);
    if (info.requestsRemaining !== null) parts.push(`${info.requestsRemaining} req`);
    if (info.inputTokensRemaining !== null) parts.push(`${(info.inputTokensRemaining / 1000).toFixed(0)}k in`);
    if (info.outputTokensRemaining !== null) parts.push(`${info.outputTokensRemaining} out`);

    if (parts.length > 0) inputBox.title = ` ${parts.join(" · ")} `;
  }

  inputField.focus();

  inputField.on(InputRenderableEvents.INPUT, () => updateAc(inputField.value));

  // Tab cycles through acMatches
  const tabHandler = (key: KeyEvent) => {
    if (key.name !== "tab") return;
    if (renderer.currentFocusedRenderable !== inputField) return;
    if (acMatches.length === 0) return;
    key.preventDefault();
    acIdx = (acIdx + 1) % acMatches.length;
    inputField.value = acMatches[acIdx]!;
    highlightChips();
  };
  renderer._internalKeyInput.onInternal("keypress", tabHandler);

  // ctrl+o — toggle expand/collapse all tool entries
  const toolToggles: Array<() => void> = [];
  let allExpanded = false;

  const ctrlOHandler = (key: KeyEvent) => {
    if (!key.ctrl || key.name !== "o") return;
    key.preventDefault();
    allExpanded = !allExpanded;
    toolToggles.forEach(t => t());
  };

  // ctrl+x — toggle selection mode
  const selectionModeIndicator = new TextRenderable(renderer, {
    content: "", fg: YELLOW, width: "100%", height: 0, paddingLeft: 2,
  });
  renderer.root.add(selectionModeIndicator);

  const selectionModeHandler = (key: KeyEvent) => {
    if (!key.ctrl || key.name !== "x") return;
    key.preventDefault();
    renderer.useMouse = !renderer.useMouse;
    if (!renderer.useMouse) {
      selectionModeIndicator.content = "  selection mode — scroll disabled. ctrl+x to exit";
      selectionModeIndicator.height = 1;
    } else {
      selectionModeIndicator.content = "";
      selectionModeIndicator.height = 0;
    }
  };

  // ctrl+y — copy last agent response to clipboard
  const clipboardHandler = (key: KeyEvent) => {
    if (!key.ctrl || key.name !== "y") return;
    key.preventDefault();
    if (!lastAgentText) return;
    try {
      const cmd = process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard";
      const proc = Bun.spawn([process.env.SHELL || "bash", "-c", cmd], { stdin: "pipe" });
      proc.stdin.write(lastAgentText);
      proc.stdin.end();
    } catch { /* clipboard unavailable — ignore */ }
  };

  // Esc — first press shows warning, second cancels the running agent
  const escCancelLine = new TextRenderable(renderer, {
    content: "", fg: YELLOW, width: "100%", height: 0, paddingLeft: 2,
  });
  renderer.root.add(escCancelLine);

  let escPrimedTimer: ReturnType<typeof setTimeout> | null = null;

  function clearEscPrimed() {
    escPrimed = false;
    escCancelLine.content = "";
    escCancelLine.height = 0;
    if (escPrimedTimer) { clearTimeout(escPrimedTimer); escPrimedTimer = null; }
  }

  const escHandler = (key: KeyEvent) => {
    if (key.name !== "escape") return;
    if (!agentRunning) return;
    key.preventDefault();
    if (!escPrimed) {
      escPrimed = true;
      escCancelLine.content = "  press Esc again to cancel";
      escCancelLine.height = 1;
      escPrimedTimer = setTimeout(clearEscPrimed, 2000);
    } else {
      clearEscPrimed();
      agentAbort?.abort();
    }
  };

  renderer._internalKeyInput.onInternal("keypress", ctrlOHandler);
  renderer._internalKeyInput.onInternal("keypress", selectionModeHandler);
  renderer._internalKeyInput.onInternal("keypress", clipboardHandler);
  renderer._internalKeyInput.onInternal("keypress", escHandler);

  inputField.on(InputRenderableEvents.ENTER, () => {
    acBar.visible = false; acMatches = []; acIdx = -1;
  });

  // ── Chat helpers ──────────────────────────────────────────────────────────
  function addUserBubble(text: string) {
    const row = new BoxRenderable(renderer, { width: "100%", flexDirection: "row", marginTop: 1 });
    row.add(new TextRenderable(renderer, { content: "you  ", fg: PINK, minWidth: 5 }));
    row.add(new TextRenderable(renderer, { content: text, fg: FG, flexGrow: 1 }));
    chat.add(row);
  }

  function addAgentBubble(): { md: MarkdownRenderable; label: TextRenderable; row: BoxRenderable } {
    const row = new BoxRenderable(renderer, {
      width: "100%", flexDirection: "row", marginTop: 1, marginBottom: 1,
    });
    const label = new TextRenderable(renderer, { content: "♥    ", fg: PINK, minWidth: 5 });
    const md = new MarkdownRenderable(renderer, {
      content: "", syntaxStyle: syntax, streaming: true, flexGrow: 1,
    });
    row.add(label);
    row.add(md);
    chat.add(row);
    return { md, label, row };
  }

  function addLine(text: string, color = MUTED) {
    chat.add(new TextRenderable(renderer, { content: text, fg: color, width: "100%" }));
  }

  function formatToolCall(name: string, inp: Record<string, unknown>): string {
    const arg = (key: string) => inp[key] ? String(inp[key]).slice(0, 80) : null;
    let summary: string;
    switch (name) {
      case "Bash":       summary = arg("command") ?? ""; break;
      case "Read":       summary = arg("file_path") ?? ""; break;
      case "Write":      summary = arg("file_path") ?? ""; break;
      case "Edit":       summary = arg("file_path") ?? ""; break;
      case "Glob":       summary = arg("pattern") ?? ""; break;
      case "Grep":       summary = arg("pattern") ?? ""; break;
      case "WebFetch":   summary = arg("url") ?? ""; break;
      case "Task":       summary = arg("description") ?? arg("prompt") ?? ""; break;
      default:           summary = Object.values(inp).map(v => String(v).slice(0, 40)).join(", ");
    }
    return `⏺ ${name}(${summary})`;
  }

  function addToolCall(name: string, inp: Record<string, unknown>): TextRenderable {
    const callText = new TextRenderable(renderer, {
      content: formatToolCall(name, inp), fg: YELLOW, width: "100%",
    });
    chat.add(callText);
    const resultText = new TextRenderable(renderer, { content: "  ⎿  …", fg: MUTED, width: "100%" });
    chat.add(resultText);
    return resultText;
  }

  function fillToolResult(resultText: TextRenderable, result: string) {
    const lines = result.split("\n");
    const collapsed = lines.length > 1
      ? `  ⎿  ${lines[0]!.slice(0, 100)}\n     … +${lines.length - 1} lines  (ctrl+o)`
      : `  ⎿  ${lines[0]!.slice(0, 100)}`;
    const expanded = lines.map(l => `  ⎿  ${l}`).join("\n");
    let isExpanded = allExpanded;
    resultText.content = isExpanded ? expanded : collapsed;
    toolToggles.push(() => {
      isExpanded = !isExpanded;
      resultText.content = isExpanded ? expanded : collapsed;
    });
  }

  // ── Replay history into chat ───────────────────────────────────────────────
  const replayResultTexts = new Map<string, TextRenderable>();

  for (const msg of history) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const cleaned = msg.content.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\n?/, "").trim();
        if (cleaned) addUserBubble(cleaned);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content as Anthropic.ToolResultBlockParam[]) {
          if (block.type !== "tool_result") continue;
          const rt = replayResultTexts.get(block.tool_use_id);
          if (!rt) continue;
          const text = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((b): b is Anthropic.TextBlockParam => b.type === "text").map(b => b.text).join("")
              : "";
          fillToolResult(rt, text || "(no output)");
          replayResultTexts.delete(block.tool_use_id);
        }
      }
    } else if (msg.role === "assistant") {
      const blocks: ContentBlock[] = Array.isArray(msg.content)
        ? msg.content as ContentBlock[]
        : [{ type: "text", text: String(msg.content) } as Anthropic.TextBlock];
      let md: MarkdownRenderable | null = null;
      let mdText = "";
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          if (!md) md = addAgentBubble().md;
          mdText += block.text;
          md.content = mdText;
          md.streaming = false;
        } else if (block.type === "tool_use") {
          if (md) { md.streaming = false; md = null; mdText = ""; }
          const resultText = addToolCall(block.name, block.input as Record<string, unknown>);
          replayResultTexts.set(block.id, resultText);
        }
      }
    }
  }

  // ── Input handler ─────────────────────────────────────────────────────────
  inputField.on(InputRenderableEvents.ENTER, async () => {
    if (agentRunning) return;
    const value = inputField.value.trim();
    if (!value) return;
    inputField.value = "";

    // Commands
    if (value === "/sessions") { flushAndCleanup(); ctx.onSessionListRequested(); return; }
    if (value === "/new") { flushAndCleanup(); ctx.onNewChatRequested(); return; }
    if (value.startsWith("/rename ")) {
      const name = value.slice(8).trim();
      if (name) {
        const sid = ensureSession();
        renameSession(sid, name);
        session = getSession(sid)!;
        headerSessionText.content = `#${sid}  ·  ${name}`;
        addLine(`  renamed to "${name}"`);
      }
      return;
    }
    if (value === "/model") { flushAndCleanup(); ctx.onModelScreenRequested(); return; }
    if (value === "/reset") {
      history = []; readFiles = new Set(); savedLength = 0;
      addLine("  history cleared");
      return;
    }
    if (value === "/compact") {
      if (history.length === 0) { addLine("  nothing to compact"); return; }
      agentRunning = true;
      inputField.blur();
      const dots = [".", "..", "..."];
      let dotIdx = 0;
      const compactStatusLine = new TextRenderable(renderer, { content: `  ↻ compacting${dots[0]}`, fg: MUTED, width: "100%" });
      chat.add(compactStatusLine);
      const dotTimer = setInterval(() => {
        dotIdx = (dotIdx + 1) % dots.length;
        compactStatusLine.content = `  ↻ compacting${dots[dotIdx]}`;
      }, 400);
      try {
        const systemPrompt = buildSystemPrompt({
          tools: TOOL_SCHEMAS.map(t => t.name),
          cwd: ctx.cwd,
          platform: process.platform,
          shell: process.env.SHELL || "bash",
          model: ctx.currentModel,
          claudeMd: ctx.claudeMd,
          claudeMdPath: ctx.claudeMdPath,
        });
        const summary = await compact(ctx.client, history, systemPrompt, ctx.currentModel);
        history = [{ role: "user", content: summary }];
        pendingCompaction = true;
        clearInterval(dotTimer);
        compactStatusLine.content = "  ↻ compacted";
      } catch (err) {
        clearInterval(dotTimer);
        compactStatusLine.content = `  ✗ ${err instanceof Error ? err.message : String(err)}`;
      }
      agentRunning = false;
      inputField.focus();
      return;
    }
    if (value === "exit" || value === "quit") { renderer.destroy(); return; }

    // Agent turn
    ensureSession();
    agentRunning = true;
    agentAbort = new AbortController();
    escPrimed = false;
    inputField.blur();
    addUserBubble(value);

    let currentBubble: ReturnType<typeof addAgentBubble> | null = addAgentBubble();
    let currentText = "";
    let bubbleHasContent = false;
    startSpinner(currentBubble.label);

    try {
      const result = await runAgent(value, {
        client: ctx.client,
        model: ctx.currentModel,
        cwd: ctx.cwd,
        history, readFiles,
        claudeMd: ctx.claudeMd, claudeMdPath: ctx.claudeMdPath,
        onText: (chunk) => {
          if (!currentBubble) currentBubble = addAgentBubble();
          currentText += chunk;
          currentBubble.md.content = currentText;
          bubbleHasContent = true;
        },
        onToolUse: (name, inp, id) => {
          stopSpinner();
          if (bubbleHasContent) {
            currentBubble!.md.streaming = false;
          } else if (currentBubble) {
            chat.remove(currentBubble.row.id);
            currentBubble = null;
          }
          const resultText = addToolCall(name, inp as Record<string, unknown>);
          pendingTools.set(id, resultText);
        },
        onToolResult: (_name, res, id) => {
          const pt = pendingTools.get(id);
          if (pt) {
            fillToolResult(pt, res);
            pendingTools.delete(id);
          }
          if (bubbleHasContent && currentBubble) {
            currentBubble.md.streaming = false;
            currentBubble = null;
            currentText = "";
            bubbleHasContent = false;
          }
          if (!currentBubble) currentBubble = addAgentBubble();
          startSpinner(currentBubble.label);
        },
        onCompact: () => {
          pendingCompaction = true;
          addLine("  ↻ context compacted");
        },
        onRateLimit: updateRateLimit,
        signal: agentAbort.signal,
      });

      if (currentBubble) {
        currentBubble.md.streaming = false;
        if (!bubbleHasContent) chat.remove(currentBubble.row.id);
      }
      lastAgentText = result.text;
      history = result.history;
      readFiles = result.readFiles;
      if (sessionId != null) addTokens(sessionId, result.inputTokens, result.outputTokens);

      const t = result.inputTokens, o = result.outputTokens;
      addLine(`  ${result.turns} turn${result.turns !== 1 ? "s" : ""}  ·  ${(t / 1000).toFixed(1)}k↑  ${o}↓`);
    } catch (err) {
      for (const [, rt] of pendingTools) fillToolResult(rt, "(interrupted)");
      pendingTools.clear();
      if (currentBubble) {
        currentBubble.md.streaming = false;
        if (!bubbleHasContent) chat.remove(currentBubble.row.id);
      }
      addLine(`  ✗ ${err instanceof Error ? err.message : String(err)}`, RED);
    }

    stopSpinner();
    agentRunning = false;
    agentAbort = null;
    clearEscPrimed();
    inputField.focus();
  });

  // Return cleanup function
  return () => {
    renderer._internalKeyInput.offInternal("keypress", tabHandler);
    renderer._internalKeyInput.offInternal("keypress", ctrlOHandler);
    renderer._internalKeyInput.offInternal("keypress", selectionModeHandler);
    renderer._internalKeyInput.offInternal("keypress", clipboardHandler);
    renderer._internalKeyInput.offInternal("keypress", escHandler);
    renderer.useMouse = true;
    flushAndCleanup();
  };
}
