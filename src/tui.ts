// Full TUI app — single renderer, swappable screens (session list ↔ chat)

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  SyntaxStyle,
  CliRenderEvents,
} from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { runAgent } from "./agent.ts";
import type { RateLimitInfo } from "./agent.ts";
import { compact } from "./compaction.ts";
import { buildSystemPrompt } from "./prompts.ts";
import { setTaskExecutor, TOOL_SCHEMAS } from "./tools.ts";
import { createTaskExecutor } from "./subagent.ts";
import {
  createSession, listSessions, getSession, deleteSession, renameSession,
  loadMessages, loadReadFiles, appendMessages, saveCompactionMessages,
  saveReadFiles, addTokens, formatAge,
} from "./sessions.ts";
import type { Session } from "./sessions.ts";
import type Anthropic from "@anthropic-ai/sdk";

type ContentBlock = Anthropic.TextBlock | Anthropic.ToolUseBlock;
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PINK   = "#FF79C6";
const YELLOW = "#F1FA8C";
const RED    = "#FF5555";
const MUTED  = "#6272A4";
const FG     = "#F8F8F2";
const BG     = "#282A36";

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

  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  const syntax = SyntaxStyle.create();

  renderer.root.flexDirection = "column";
  renderer.root.width = "100%";
  renderer.root.height = "100%";

  // load CLAUDE.md relative to cwd
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

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function makeHeader(title: string): BoxRenderable {
    const box = new BoxRenderable(renderer, {
      width: "100%", height: 3, border: true, borderStyle: "round", borderColor: PINK,
    });
    box.title = title;
    return box;
  }

  function makeFooter(hints: string): TextRenderable {
    return new TextRenderable(renderer, {
      content: `  ${hints}`,
      fg: MUTED, width: "100%", height: 1, marginBottom: 1,
    });
  }


  // ════════════════════════════════════════════════════════════════════════════
  // SESSION LIST SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  function mountSessionScreen() {
    clearRoot();

    const header = makeHeader(" girlfriend ");
    renderer.root.add(header);

    // Status line (shows pending action / confirmation)
    const statusLine = new TextRenderable(renderer, {
      content: "", fg: YELLOW, width: "100%", height: 1, marginLeft: 2,
    });
    renderer.root.add(statusLine);

    const sessions = listSessions(50);

    const selectBox = new SelectRenderable(renderer, {
      flexGrow: 1,
      width: "100%",
      backgroundColor: BG,
      textColor: FG,
      focusedBackgroundColor: "#44475A",
      focusedTextColor: PINK,
      wrapSelection: true,
      showDescription: true,
      descriptionColor: MUTED,
      itemSpacing: 0,
      options: sessions.map((s) => ({
        name: `  ${String(s.id).padStart(3)}  ${s.name}`,
        description: `        ${formatAge(s.updated_at).padEnd(10)} ${s.message_count} msgs  ${s.total_input_tokens}↑`,
        value: s.id,
      })),
    });
    renderer.root.add(selectBox);
    renderer.root.add(makeFooter("enter: open  n: new  d: delete (then enter)  esc: back  ctrl+c: exit"));

    selectBox.focus();

    let confirming = false;
    let pendingDeleteId: number | null = null;

    function refreshList() {
      const updated = listSessions(50);
      selectBox.options = updated.map((s) => ({
        name: `  ${String(s.id).padStart(3)}  ${s.name}`,
        description: `        ${formatAge(s.updated_at).padEnd(10)} ${s.message_count} msgs  ${s.total_input_tokens}↑`,
        value: s.id,
      }));
    }

    // Open selected session (or confirm delete)
    selectBox.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      if (confirming) {
        deleteSession(pendingDeleteId!);
        confirming = false; pendingDeleteId = null;
        statusLine.content = "";
        refreshList();
        return;
      }
      const opt = selectBox.getSelectedOption();
      if (opt?.value != null) mountChatScreen(opt.value as number);
    });

    const onKey = (key: KeyEvent) => {
      if (key.ctrl) return;

      if (confirming) {
        if (key.name === "escape") {
          confirming = false; pendingDeleteId = null;
          statusLine.content = "";
        }
        return;
      }

      if (key.name === "escape") {
        key.preventDefault();
        mountChatScreen(lastChatSessionId);
        return;
      }

      if (key.name === "n") {
        key.preventDefault();
        mountChatScreen(null);
        return;
      }

      if (key.name === "d") {
        key.preventDefault();
        const opt = selectBox.getSelectedOption();
        if (!opt) return;
        const session = getSession(opt.value as number);
        if (!session) return;
        confirming = true;
        pendingDeleteId = opt.value as number;
        statusLine.content = `  delete "${session.name}"? (enter to confirm / esc to cancel)`;
      }
    };

    renderer._internalKeyInput.onInternal("keypress", onKey);
    screenCleanup = () => renderer._internalKeyInput.offInternal("keypress", onKey);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODEL SELECTION SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  async function mountModelScreen() {
    clearRoot();

    const header = makeHeader(" select model ");
    renderer.root.add(header);

    const statusLine = new TextRenderable(renderer, {
      content: "  loading models…", fg: MUTED, width: "100%", height: 1, marginLeft: 2,
    });
    renderer.root.add(statusLine);

    const selectBox = new SelectRenderable(renderer, {
      flexGrow: 1, width: "100%",
      backgroundColor: BG, textColor: FG,
      focusedBackgroundColor: "#44475A", focusedTextColor: PINK,
      wrapSelection: true, showDescription: true, descriptionColor: MUTED,
      itemSpacing: 0, options: [],
    });
    renderer.root.add(selectBox);
    renderer.root.add(makeFooter("enter: select  esc: back  ctrl+c: exit"));

    try {
      const resp = await opts.client.models.list({ limit: 100 });
      statusLine.content = "";
      selectBox.options = resp.data.map((m) => ({
        name: `  ${m.display_name}`,
        description: `        ${m.id}`,
        value: m.id,
      }));
      selectBox.focus();
    } catch (err) {
      statusLine.content = `  ✗ ${err instanceof Error ? err.message : String(err)}`;
      statusLine.fg = RED;
    }

    selectBox.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const opt = selectBox.getSelectedOption();
      if (opt?.value) currentModel = opt.value as string;
      mountChatScreen(lastChatSessionId);
    });

    const onKey = (key: KeyEvent) => {
      if (key.name === "escape") { key.preventDefault(); mountChatScreen(lastChatSessionId); }
    };
    renderer._internalKeyInput.onInternal("keypress", onKey);
    screenCleanup = () => renderer._internalKeyInput.offInternal("keypress", onKey);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CHAT SCREEN
  // ════════════════════════════════════════════════════════════════════════════
  function mountChatScreen(initialSessionId: number | null) {
    clearRoot();
    if (initialSessionId != null) lastChatSessionId = initialSessionId;

    let sessionId: number | null = initialSessionId;
    let session: Session | null = sessionId != null ? getSession(sessionId)! : null;
    let history = sessionId != null ? loadMessages(sessionId) : [] as ReturnType<typeof loadMessages>;
    let readFiles = sessionId != null ? loadReadFiles(sessionId) : new Set<string>();
    let savedLength = history.length;
    let pendingCompaction = false;
    let agentRunning = false;
    const pendingTools = new Map<string, TextRenderable>();
    let lastAgentText = "";
    let headerSessionText: TextRenderable;

    // Lazily create session on first message
    function ensureSession(): number {
      if (sessionId != null) return sessionId;
      const name = `session-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      sessionId = createSession(name, currentModel);
      lastChatSessionId = sessionId;
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
      content: "(❀◕‿◕❀)  ", fg: PINK, alignSelf: "center",
    });
    const headerInfo = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, justifyContent: "center" });
    headerInfo.add(new TextRenderable(renderer, { content: "girlfriend", fg: PINK }));
    const headerModelText = new TextRenderable(renderer, { content: currentModel, fg: MUTED });
    headerInfo.add(headerModelText);
    headerSessionText = new TextRenderable(renderer, { content: sessionId != null ? `#${sessionId}  ·  ${session!.name}` : "new session", fg: MUTED });
    headerInfo.add(headerSessionText);
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
      // If Tab is cycling and this value is the current selection, don't re-filter
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
      border: true, borderStyle: "round", borderColor: PINK,
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
      // OAuth unified limits
      if (info.unified5hUtilization !== null) {
        const pct = (info.unified5hUtilization * 100).toFixed(0);
        const status = info.unifiedStatus === "allowed" ? "" : ` ⚠ ${info.unifiedStatus}`;
        parts.push(`5h: ${pct}%${status}`);
      }
      if (info.unified7dUtilization !== null)
        parts.push(`7d: ${(info.unified7dUtilization * 100).toFixed(0)}%`);
      if (info.unifiedFallback && info.unifiedFallback !== "available")
        parts.push(`fallback: ${info.unifiedFallback}`);
      // Standard API key limits
      if (info.requestsRemaining !== null) parts.push(`${info.requestsRemaining} req`);
      if (info.inputTokensRemaining !== null) parts.push(`${(info.inputTokensRemaining / 1000).toFixed(0)}k in`);
      if (info.outputTokensRemaining !== null) parts.push(`${info.outputTokensRemaining} out`);

      if (parts.length > 0) inputBox.title = ` ${parts.join(" · ")} `;
    }

    inputField.focus();

    // Update suggestions on every keystroke
    inputField.on(InputRenderableEvents.INPUT, () => updateAc(inputField.value));

    // Tab cycles through acMatches; updateAc guards against re-filtering the selection
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
    const ctrlOHandler = (key: KeyEvent) => {
      if (!key.ctrl || key.name !== "o") return;
      key.preventDefault();
      allExpanded = !allExpanded;
      toolToggles.forEach(t => t());
    };

    // ctrl+x — toggle selection mode (disable mouse so terminal can select text)
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

    renderer._internalKeyInput.onInternal("keypress", ctrlOHandler);
    renderer._internalKeyInput.onInternal("keypress", selectionModeHandler);
    renderer._internalKeyInput.onInternal("keypress", clipboardHandler);

    // Hide suggestions when input is cleared
    inputField.on(InputRenderableEvents.ENTER, () => {
      acBar.visible = false; acMatches = []; acIdx = -1;
    });

    screenCleanup = () => {
      renderer._internalKeyInput.offInternal("keypress", tabHandler);
      renderer._internalKeyInput.offInternal("keypress", ctrlOHandler);
      renderer._internalKeyInput.offInternal("keypress", selectionModeHandler);
      renderer._internalKeyInput.offInternal("keypress", clipboardHandler);
      renderer.useMouse = true; // restore on screen switch
      flushAndCleanup();
    };

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

    // Tool entries support ctrl+o expand/collapse
    const toolToggles: Array<() => void> = [];
    let allExpanded = false;

    // Add the ⏺ call line + a placeholder result immediately (called on onToolUse)
    function addToolCall(name: string, inp: Record<string, unknown>): TextRenderable {
      const callText = new TextRenderable(renderer, {
        content: formatToolCall(name, inp), fg: YELLOW, width: "100%",
      });
      chat.add(callText);
      const resultText = new TextRenderable(renderer, { content: "  ⎿  …", fg: MUTED, width: "100%" });
      chat.add(resultText);
      return resultText;
    }

    // Fill in the placeholder result once the tool returns (called on onToolResult)
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
    // tool_use blocks create a placeholder; tool_result messages fill them in
    const replayResultTexts = new Map<string, TextRenderable>();

    for (const msg of history) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          // Strip injected <system-reminder> (CLAUDE.md) prefix before displaying
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
      if (value === "/sessions") { flushAndCleanup(); mountSessionScreen(); return; }
      if (value === "/new") {
        flushAndCleanup();
        mountChatScreen(null);
        return;
      }
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
      if (value === "/model") { flushAndCleanup(); mountModelScreen(); return; }
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
            cwd: opts.cwd,
            platform: process.platform,
            shell: process.env.SHELL || "bash",
            model: currentModel,
          });
          const summary = await compact(opts.client, history, systemPrompt, currentModel);
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
      inputField.blur();
      addUserBubble(value);

      let currentBubble: ReturnType<typeof addAgentBubble> | null = addAgentBubble();
      let currentText = "";
      let bubbleHasContent = false;
      startSpinner(currentBubble.label);
      const prevHistoryLen = history.length;

      try {
        const result = await runAgent(value, {
          client: opts.client,
          model: currentModel,
          cwd: opts.cwd,
          history, readFiles,
          claudeMd, claudeMdPath,
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
              // No text yet — remove pre-created bubble so tool entry comes first
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
            // Create bubble for spinner / next response text
            if (!currentBubble) currentBubble = addAgentBubble();
            startSpinner(currentBubble.label);
          },
          onCompact: () => {
            pendingCompaction = true;
            addLine("  ↻ context compacted");
          },
          onRateLimit: updateRateLimit,
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
      inputField.focus();
    });
  }

  // ── Initial screen ──────────────────────────────────────────────────────────
  if (opts.initialSessionId != null && getSession(opts.initialSessionId)) {
    mountChatScreen(opts.initialSessionId);
  } else {
    mountChatScreen(null);
  }

  await new Promise<void>((resolve) => renderer.on(CliRenderEvents.DESTROY, resolve));
  screenCleanup?.();
}
