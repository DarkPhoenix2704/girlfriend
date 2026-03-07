// Session list screen

import {
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  InputRenderable,
  InputRenderableEvents,
  BoxRenderable,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { YELLOW, BG, FG, MUTED, PINK } from "./theme.ts";
import { makeHeader, makeFooter, makeHelpBox } from "./components.ts";
import {
  listSessions, getSession, deleteSession, formatAge,
} from "../sessions.ts";
import { CURRENT_VERSION } from "../updater.ts";

export interface SessionScreenContext {
  renderer: CliRenderer;
  updateNotice: string | null;
  lastChatSessionId: number | null;
  onOpenSession: (id: number) => void;
  onNewSession: () => void;
  onMemoryScreen: () => void;
  onBack: () => void;
}

export function mountSessionScreen(ctx: SessionScreenContext): () => void {
  const { renderer } = ctx;

  const header = makeHeader(renderer, ` girlfriend ${CURRENT_VERSION} `);
  renderer.root.add(header);

  if (ctx.updateNotice) {
    const updateBanner = new TextRenderable(renderer, {
      content: `  update available: ${ctx.updateNotice}  →  bunx gf-uwu`,
      fg: YELLOW, width: "100%", height: 1,
    });
    renderer.root.add(updateBanner);
  }

  // Search bar
  const searchBox = new BoxRenderable(renderer, {
    width: "100%", height: 3,
    border: true, borderStyle: "rounded", borderColor: MUTED,
  });
  searchBox.title = " search ";
  const searchInput = new InputRenderable(renderer, {
    width: "100%", paddingLeft: 1, placeholder: "filter sessions…",
  });
  searchBox.add(searchInput);
  renderer.root.add(searchBox);

  const statusLine = new TextRenderable(renderer, {
    content: "", fg: YELLOW, width: "100%", height: 1, marginLeft: 2,
  });
  renderer.root.add(statusLine);

  const sessions = listSessions(200);

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
      name: `  ${String(s.id).padStart(3)}  [${s.source.padEnd(9)}]  ${s.name}`,
      description: `        ${formatAge(s.updated_at).padEnd(10)} ${s.message_count} msgs  ${s.total_input_tokens}↑`,
      value: s.id,
    })),
  });
  renderer.root.add(selectBox);
  renderer.root.add(makeFooter(renderer, "enter: open  n: new  d: delete  m: memories  /: search  ?: help  esc: back  ctrl+c: exit"));

  const SESSION_SHORTCUTS: [string, string][] = [
    ["enter",  "open selected session"],
    ["n",      "new session"],
    ["d → enter", "delete selected session"],
    ["m",      "open memory browser"],
    ["/",      "search / filter sessions"],
    ["esc",    "clear filter or go back"],
    ["ctrl+c", "exit"],
  ];
  const helpBox = makeHelpBox(renderer, SESSION_SHORTCUTS);
  renderer.root.add(helpBox);

  selectBox.focus();

  let confirming = false;
  let pendingDeleteId: number | null = null;

  let filterText = "";

  function refreshList() {
    const updated = listSessions(200);
    const filtered = filterText
      ? updated.filter((s) => s.name.toLowerCase().includes(filterText.toLowerCase()) || s.source.includes(filterText))
      : updated;
    selectBox.options = filtered.map((s) => ({
      name: `  ${String(s.id).padStart(3)}  [${s.source.padEnd(9)}]  ${s.name}`,
      description: `        ${formatAge(s.updated_at).padEnd(10)} ${s.message_count} msgs  ${s.total_input_tokens}↑`,
      value: s.id,
    }));
  }

  // Search input wiring
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  searchInput.on(InputRenderableEvents.INPUT, () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    filterText = searchInput.value;
    searchDebounce = setTimeout(() => refreshList(), 150);
  });
  searchInput.on(InputRenderableEvents.ENTER, () => selectBox.focus());

  selectBox.on(SelectRenderableEvents.ITEM_SELECTED, () => {
    if (confirming) {
      deleteSession(pendingDeleteId!);
      confirming = false; pendingDeleteId = null;
      statusLine.content = "";
      refreshList();
      return;
    }
    const opt = selectBox.getSelectedOption();
    if (opt?.value != null) ctx.onOpenSession(opt.value as number);
  });

  let helpVisible = false;

  const onKey = (key: KeyEvent) => {
    if (key.ctrl) return;

    const typing = renderer.currentFocusedRenderable === searchInput;
    if ((key.name === "?" && !typing) || (helpVisible && key.name === "escape")) {
      key.preventDefault();
      helpVisible = !helpVisible;
      selectBox.visible = !helpVisible;
      searchBox.visible = !helpVisible;
      helpBox.visible = helpVisible;
      return;
    }

    if (helpVisible) return;

    if (confirming) {
      if (key.name === "escape") {
        confirming = false; pendingDeleteId = null;
        statusLine.content = "";
      }
      return;
    }

    if (key.name === "escape") {
      key.preventDefault();
      if (filterText) {
        filterText = ""; searchInput.value = ""; refreshList();
        selectBox.focus();
      } else {
        ctx.onBack();
      }
      return;
    }

    if (key.name === "/" || key.name === "slash") {
      key.preventDefault();
      searchInput.focus();
      return;
    }

    if (key.name === "m") {
      key.preventDefault();
      ctx.onMemoryScreen();
      return;
    }

    if (key.name === "n") {
      key.preventDefault();
      ctx.onNewSession();
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

  // Return cleanup function
  return () => renderer._internalKeyInput.offInternal("keypress", onKey);
}
