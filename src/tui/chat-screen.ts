// Chat screen — the main interactive conversation view.
// Session lifecycle and agent execution are delegated to GatewayRouter.

import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  MarkdownRenderable,
  SyntaxStyle,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { PINK, YELLOW, RED, MUTED, FG, BG } from "./theme.ts";
import { makeHelpBox } from "./components.ts";
import { renameSession, getSession, loadMessages } from "../sessions.ts";
import type { Session } from "../sessions.ts";
import type { IRouter } from "../gateway/types.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "fs";
import { join } from "path";


type ContentBlock = Anthropic.TextBlock | Anthropic.ToolUseBlock;

export interface ChatScreenContext {
  renderer: CliRenderer;
  localRouter: IRouter;
  daemonRouter: IRouter | null;
  currentModel: string;
  cwd: string;
  claudeMd: string | undefined;
  claudeMdPath: string | undefined;
  updateNotice: string | null;
  lastChatSessionId: number | null;
  initialSessionId: number | null;
  onSessionListRequested: () => void;
  onModelScreenRequested: () => void;
  onMemoryScreenRequested: () => void;
  onNewChatRequested: () => void;
  onSessionIdChanged: (id: number) => void;
}

export function mountChatScreen(ctx: ChatScreenContext): () => void {
  const { renderer } = ctx;

  // Mode: "local" runs agent in TUI process; "daemon" forwards to daemon via HTTP
  type Mode = "local" | "daemon";
  let mode: Mode = ctx.daemonRouter ? "daemon" : "local";
  const router = () => mode === "daemon" && ctx.daemonRouter ? ctx.daemonRouter : ctx.localRouter;
  const syntax = SyntaxStyle.create();

  let sessionId: number | null = ctx.initialSessionId;
  let session: Session | null = sessionId != null ? getSession(sessionId) : null;
  let agentRunning = false;
  let agentAbort: AbortController | null = null;
  let escPrimed = false;
  const pendingTools = new Map<string, TextRenderable>();
  let lastAgentText = "";
  let headerSessionText: TextRenderable;
  // AskUser: set when the agent is waiting for user input
  let awaitingAnswer: ((answer: string) => void) | null = null;

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
  const headerModeText = new TextRenderable(renderer, {
    content: ctx.daemonRouter ? `mode: ${mode}` : "mode: local",
    fg: MUTED,
  });
  headerSessionText = new TextRenderable(renderer, {
    content: sessionId != null ? `#${sessionId}  ·  ${session!.name}` : "new session", fg: MUTED,
  });
  headerInfo.add(headerSessionText);
  if (ctx.daemonRouter) headerInfo.add(headerModeText);
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
  const COMMANDS = ["/sessions", "/new", "/rename ", "/compact", "/model", "/mode", "/memories", "/export", "/help"];
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

  // ── Question panel (AskUserQuestion tool) ──────────────────────────────────
  // Wrapper has explicit height set dynamically; questionSelect uses flexGrow: 1
  // to fill it — the same pattern used in all other SelectRenderable screens.
  const questionWrapper = new BoxRenderable(renderer, {
    width: "100%", flexDirection: "column",
    paddingLeft: 2, paddingRight: 2,
    visible: false, height: 0,
  });
  const questionText = new TextRenderable(renderer, {
    content: "", fg: YELLOW, width: "100%", height: 1,
  });
  const questionSelect = new SelectRenderable(renderer, {
    width: "100%", flexGrow: 1,
    backgroundColor: BG, textColor: FG,
    focusedBackgroundColor: "#44475A", focusedTextColor: PINK,
    wrapSelection: true,
    options: [],
  });
  questionWrapper.add(questionText);
  questionWrapper.add(questionSelect);
  renderer.root.add(questionWrapper);

  function hideQuestionPanel() {
    questionWrapper.visible = false;
    questionWrapper.height = 0;
  }

  questionSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => {
    const opt = questionSelect.getSelectedOption();
    if (!opt || !awaitingAnswer) return;
    hideQuestionPanel();
    if (opt.value === "__custom__") {
      inputField.placeholder = "your answer…";
      inputField.focus();
    } else {
      const answer = String(opt.value);
      addUserBubble(answer);
      const resolver = awaitingAnswer;
      awaitingAnswer = null;
      resolver(answer);
    }
  });

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

  // Help overlay — toggled by '?'
  const CHAT_SHORTCUTS: [string, string][] = [
    ["enter",          "send message"],
    ["/sessions",      "session list"],
    ["/new",           "new session"],
    ["/rename <name>", "rename session"],
    ["/model",         "switch model"],
    ["/mode",          "toggle local/daemon"],
    ["/compact",       "compact context"],
    ["/memories",      "memory browser"],
    ["/export",        "export session as markdown"],
    ["ctrl+o",         "expand/collapse all tool outputs"],
    ["ctrl+y",         "copy last response to clipboard"],
    ["ctrl+x",         "toggle selection mode"],
    ["esc esc",        "cancel running agent"],
    ["ctrl+c",         "exit"],
  ];
  const helpBox = makeHelpBox(renderer, CHAT_SHORTCUTS);
  renderer.root.add(helpBox);

  let helpVisible = false;
  const helpHandler = (key: KeyEvent) => {
    if (key.ctrl) return;
    const typing = renderer.currentFocusedRenderable === inputField;
    if ((key.name === "?" && !typing) || (helpVisible && key.name === "escape")) {
      key.preventDefault();
      helpVisible = !helpVisible;
      chat.visible = !helpVisible;
      helpBox.visible = helpVisible;
    }
  };
  renderer._internalKeyInput.onInternal("keypress", helpHandler);

  function updateRateLimit(info: import("../agent.ts").RateLimitInfo) {
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
    } catch { /* clipboard unavailable */ }
  };

  // Esc — first press shows warning, second cancels agent
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
      case "Bash":        summary = arg("command") ?? ""; break;
      case "Read":        summary = arg("file_path") ?? ""; break;
      case "Write":       summary = arg("file_path") ?? ""; break;
      case "Edit":        summary = arg("file_path") ?? ""; break;
      case "Glob":        summary = arg("pattern") ?? ""; break;
      case "Grep":        summary = arg("pattern") ?? ""; break;
      case "WebFetch":    summary = arg("url") ?? ""; break;
      case "BrowserOpen": summary = arg("url") ?? ""; break;
      case "Search":      summary = arg("query") ?? ""; break;
      case "Task":              summary = arg("description") ?? arg("prompt") ?? ""; break;
      case "AskUserQuestion":   summary = arg("question") ?? ""; break;
      default:                  summary = Object.values(inp).map(v => String(v).slice(0, 40)).join(", ");
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
  function replayHistory() {
    if (sessionId == null) return;
    const history = loadMessages(sessionId);
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
  }

  replayHistory();

  // ── Input handler ─────────────────────────────────────────────────────────
  inputField.on(InputRenderableEvents.ENTER, async () => {
    // AskUser: free-text answer (when no options, or after "Write custom message" was chosen)
    if (awaitingAnswer) {
      const raw = inputField.value.trim();
      if (!raw) return;
      inputField.value = "";
      inputField.placeholder = "message…";
      addUserBubble(raw);
      const resolver = awaitingAnswer;
      awaitingAnswer = null;
      resolver(raw);
      return;
    }

    if (agentRunning) return;
    const value = inputField.value.trim();
    if (!value) return;
    inputField.value = "";

    // Commands
    if (value === "?" || value === "/help") {
      helpVisible = true;
      chat.visible = false;
      helpBox.visible = true;
      return;
    }
    if (value === "/sessions") { ctx.onSessionListRequested(); return; }
    if (value === "/new")      { ctx.onNewChatRequested(); return; }
    if (value.startsWith("/rename ")) {
      const name = value.slice(8).trim();
      if (name && sessionId != null) {
        renameSession(sessionId, name);
        session = getSession(sessionId);
        headerSessionText.content = `#${sessionId}  ·  ${name}`;
        addLine(`  renamed to "${name}"`);
      }
      return;
    }
    if (value === "/model")    { ctx.onModelScreenRequested(); return; }
    if (value === "/memories") { ctx.onMemoryScreenRequested(); return; }
    if (value === "/export") {
      if (sessionId == null) { addLine("  nothing to export"); return; }
      const history = loadMessages(sessionId);
      const lines: string[] = [`# Session #${sessionId} — ${session?.name ?? ""}\n`];
      // Map tool_use id → name so we can label tool results
      const toolNames = new Map<string, string>();
      for (const m of history) {
        if (m.role === "user") {
          if (typeof m.content === "string") {
            const cleaned = m.content.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\n?/, "").trim();
            if (cleaned) lines.push(`**You:** ${cleaned}\n`);
          } else if (Array.isArray(m.content)) {
            for (const b of m.content as Anthropic.ToolResultBlockParam[]) {
              if (b.type !== "tool_result") continue;
              const name = toolNames.get(b.tool_use_id) ?? "tool";
              const text = typeof b.content === "string"
                ? b.content
                : Array.isArray(b.content)
                  ? (b.content as Anthropic.TextBlockParam[]).filter(x => x.type === "text").map(x => x.text).join("")
                  : "";
              if (text) lines.push(`> **${name} result:** ${text.slice(0, 500)}${text.length > 500 ? "…" : ""}\n`);
            }
          }
        } else {
          const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
          let assistantText = "";
          for (const b of blocks as Anthropic.ContentBlock[]) {
            if (b.type === "text" && b.text) {
              assistantText += b.text;
            } else if (b.type === "tool_use") {
              if (assistantText) { lines.push(`**Assistant:** ${assistantText}\n`); assistantText = ""; }
              toolNames.set(b.id, b.name);
              const argStr = JSON.stringify(b.input).slice(0, 120);
              lines.push(`> **${b.name}(${argStr})**\n`);
            }
          }
          if (assistantText) lines.push(`**Assistant:** ${assistantText}\n`);
        }
      }
      const outPath = join(ctx.cwd, `session-${sessionId}.md`);
      writeFileSync(outPath, lines.join("\n"));
      addLine(`  exported → ${outPath}`, PINK);
      return;
    }
    if (value.startsWith("/mode")) {
      const arg = value.slice(5).trim();
      if (!ctx.daemonRouter) { addLine("  daemon not running — local mode only"); return; }
      const next: Mode = arg === "local" ? "local" : arg === "daemon" ? "daemon" : mode === "daemon" ? "local" : "daemon";
      mode = next;
      headerModeText.content = `mode: ${mode}`;
      addLine(`  switched to ${mode} mode`);
      return;
    }
    if (value === "/compact") {
      if (sessionId == null) { addLine("  nothing to compact"); return; }
      agentRunning = true;
      inputField.blur();
      const dots = [".", "..", "..."];
      let dotIdx = 0;
      const statusLine = new TextRenderable(renderer, { content: `  ↻ compacting${dots[0]}`, fg: MUTED, width: "100%" });
      chat.add(statusLine);
      const dotTimer = setInterval(() => {
        dotIdx = (dotIdx + 1) % dots.length;
        statusLine.content = `  ↻ compacting${dots[dotIdx]}`;
      }, 400);
      try {
        await router().compact(sessionId, ctx.currentModel, ctx.cwd, ctx.claudeMd, ctx.claudeMdPath);
        clearInterval(dotTimer);
        statusLine.content = "  ↻ compacted";
      } catch (err) {
        clearInterval(dotTimer);
        statusLine.content = `  ✗ ${err instanceof Error ? err.message : String(err)}`;
      }
      agentRunning = false;
      inputField.focus();
      return;
    }
    if (value === "exit" || value === "quit") { renderer.destroy(); return; }

    // ── Agent turn ────────────────────────────────────────────────────────
    agentRunning = true;
    agentAbort = new AbortController();
    escPrimed = false;
    inputField.blur();
    addUserBubble(value);

    // Wire up AskUser tool — SelectRenderable for options, plain input for free text
    const askUser = (question: string, options?: string[]) => new Promise<string>((resolve, reject) => {
      awaitingAnswer = resolve;
      if (options && options.length > 0) {
        questionText.content = question;
        const allOpts = [
          ...options.map((opt) => ({ name: `  ${opt}`, value: opt })),
          { name: "  Write custom message…", value: "__custom__" },
        ];
        questionSelect.options = allOpts;
        // 1 (text) + N (options) + 1 (padding) — wrapper gets explicit height so
        // SelectRenderable's flexGrow: 1 can fill the rest
        questionWrapper.height = 1 + allOpts.length + 1;
        questionWrapper.visible = true;
        questionSelect.focus();
      } else {
        addLine(`  ${question}`, YELLOW);
        inputField.placeholder = "your answer…";
        inputField.focus();
      }
      agentAbort!.signal.addEventListener("abort", () => {
        hideQuestionPanel();
        awaitingAnswer = null;
        inputField.placeholder = "message…";
        reject(new Error("aborted"));
      }, { once: true });
    });

    let currentBubble: ReturnType<typeof addAgentBubble> | null = addAgentBubble();
    let currentText = "";
    let bubbleHasContent = false;
    startSpinner(currentBubble.label);

    // If no session yet, create one via the router on first dispatch
    const dispatchSessionId: number | null = sessionId;

    try {
      const result = await router().dispatch(
        { source: "local", externalId: "local", text: value },
        {
          sessionId: dispatchSessionId,
          newSessionName: `session-${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
          model: ctx.currentModel,
          cwd: ctx.cwd,
          claudeMd: ctx.claudeMd,
          claudeMdPath: ctx.claudeMdPath,
          askUser,
          streaming: {
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
              if (name === "AskUserQuestion") return;
              const resultText = addToolCall(name, inp as Record<string, unknown>);
              pendingTools.set(id, resultText);
            },
            onToolResult: (_name, res, id) => {
              const pt = pendingTools.get(id);
              if (pt) { fillToolResult(pt, res); pendingTools.delete(id); }
              if (bubbleHasContent && currentBubble) {
                currentBubble.md.streaming = false;
                currentBubble = null;
                currentText = "";
                bubbleHasContent = false;
              }
              if (!currentBubble) currentBubble = addAgentBubble();
              startSpinner(currentBubble.label);
            },
            onCompact: () => addLine("  ↻ context compacted"),
            onRateLimit: updateRateLimit,
            signal: agentAbort.signal,
          },
        }
      );

      if (currentBubble) {
        currentBubble.md.streaming = false;
        if (!bubbleHasContent) chat.remove(currentBubble.row.id);
      }
      lastAgentText = result.text;

      // Update session state if newly created
      const isNewSession = sessionId == null;
      if (isNewSession) {
        sessionId = result.sessionId;
        session = getSession(sessionId);
        ctx.onSessionIdChanged(sessionId);
        headerSessionText.content = `#${sessionId}  ·  ${session?.name ?? ""}`;
        // Poll once for auto-rename (Haiku renames in background after first turn)
        setTimeout(() => {
          const refreshed = getSession(sessionId!);
          if (refreshed && refreshed.name !== session?.name) {
            session = refreshed;
            headerSessionText.content = `#${sessionId}  ·  ${refreshed.name}`;
          }
        }, 5000);
      }

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
    awaitingAnswer = null;
    hideQuestionPanel();
    agentRunning = false;
    agentAbort = null;
    clearEscPrimed();
    inputField.placeholder = "message…";
    inputField.focus();
  });

  // Return cleanup function
  return () => {
    hideQuestionPanel();
    renderer._internalKeyInput.offInternal("keypress", tabHandler);
    renderer._internalKeyInput.offInternal("keypress", ctrlOHandler);
    renderer._internalKeyInput.offInternal("keypress", selectionModeHandler);
    renderer._internalKeyInput.offInternal("keypress", clipboardHandler);
    renderer._internalKeyInput.offInternal("keypress", escHandler);
    renderer._internalKeyInput.offInternal("keypress", helpHandler);
    renderer.useMouse = true;
  };
}
