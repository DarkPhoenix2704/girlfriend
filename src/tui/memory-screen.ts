// Memory browser screen — view, search, and delete memory facts.

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
import { listMemories, searchMemories, deleteMemory } from "../sessions.ts";
import type { MemoryFact } from "../sessions.ts";
import { CURRENT_VERSION } from "../updater.ts";

export interface MemoryScreenContext {
  renderer: CliRenderer;
  onBack: () => void;
}

export function mountMemoryScreen(ctx: MemoryScreenContext): () => void {
  const { renderer } = ctx;

  const header = makeHeader(renderer, ` girlfriend ${CURRENT_VERSION} — memories `);
  renderer.root.add(header);

  // Search input
  const searchBox = new BoxRenderable(renderer, {
    width: "100%", height: 3,
    border: true, borderStyle: "rounded", borderColor: MUTED,
    flexDirection: "row",
  });
  searchBox.title = " search ";
  const searchInput = new InputRenderable(renderer, {
    width: "100%", paddingLeft: 1,
    placeholder: "filter memories…",
  });
  searchBox.add(searchInput);
  renderer.root.add(searchBox);

  const statusLine = new TextRenderable(renderer, {
    content: "", fg: YELLOW, width: "100%", height: 1, marginLeft: 2,
  });
  renderer.root.add(statusLine);

  let facts: MemoryFact[] = listMemories({ limit: 100 });

  function buildOptions(data: MemoryFact[]) {
    return data.map((f) => ({
      name: `  ${f.key.padEnd(36)}  ${f.value.slice(0, 60)}`,
      description: `        category: ${f.category ?? "—"}  confidence: ${f.confidence.toFixed(2)}  updated: ${f.updated_at.slice(0, 10)}`,
      value: f.key,
    }));
  }

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
    options: buildOptions(facts),
  });
  // Category filter bar
  const CATEGORIES = [
    ["a", null,        "all"],
    ["p", "preference","pref"],
    ["f", "finance",   "finance"],
    ["t", "task",      "task"],
    ["h", "health",    "health"],
    ["c", "contact",   "contact"],
    ["k", "fact",      "fact"],
  ] as const;

  const catBar = new BoxRenderable(renderer, {
    width: "100%", height: 1, flexDirection: "row", paddingLeft: 2, gap: 2,
  });
  const catChips = CATEGORIES.map(([key, , label]) => {
    const t = new TextRenderable(renderer, { content: `[${key}] ${label}`, fg: MUTED });
    catBar.add(t);
    return t;
  });
  renderer.root.add(catBar);
  renderer.root.add(selectBox);

  const MEMORY_SHORTCUTS: [string, string][] = [
    ["/",          "search memories"],
    ["d → enter",  "delete selected memory"],
    ["a",          "show all categories"],
    ["p",          "filter: preference"],
    ["f",          "filter: finance"],
    ["t",          "filter: task"],
    ["h",          "filter: health"],
    ["c",          "filter: contact"],
    ["k",          "filter: fact"],
    ["esc",        "clear search/filter or go back"],
    ["ctrl+c",     "exit"],
  ];
  const helpBox = makeHelpBox(renderer, MEMORY_SHORTCUTS);
  renderer.root.add(helpBox);

  renderer.root.add(makeFooter(renderer, "d: delete  /: search  a/p/f/t/h/c/k: category  ?: help  esc: back"));

  selectBox.focus();

  let confirming = false;
  let pendingDeleteKey: string | null = null;
  let activeCategory: string | null = null;
  let helpVisible = false;

  function updateCatChips() {
    CATEGORIES.forEach(([, cat, ], i) => {
      catChips[i]!.fg = cat === activeCategory ? PINK : MUTED;
    });
  }

  function refreshList(query = "") {
    facts = query.trim()
      ? searchMemories(query, { limit: 100, category: activeCategory ?? undefined })
      : listMemories({ limit: 100, category: activeCategory ?? undefined });
    selectBox.options = buildOptions(facts);
    const catLabel = activeCategory ? `  [${activeCategory}]` : "";
    statusLine.content = facts.length > 0
      ? `  ${facts.length} memories${catLabel}`
      : `  no memories found${catLabel}`;
  }

  updateCatChips();
  refreshList();

  // Search input handler
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  searchInput.on(InputRenderableEvents.INPUT, () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => refreshList(searchInput.value), 200);
  });

  searchInput.on(InputRenderableEvents.ENTER, () => {
    selectBox.focus();
  });

  selectBox.on(SelectRenderableEvents.ITEM_SELECTED, () => {
    if (confirming) {
      const fact = facts.find((f) => f.key === pendingDeleteKey);
      if (fact) deleteMemory(fact.key, fact.namespace ?? undefined);
      confirming = false; pendingDeleteKey = null;
      statusLine.content = "  deleted";
      refreshList(searchInput.value);
      return;
    }
    // Nothing else to do on select — just highlighting
  });

  const onKey = (key: KeyEvent) => {
    if (key.ctrl) return;

    // Help toggle
    const typing = renderer.currentFocusedRenderable === searchInput;
    if ((key.name === "?" && !typing) || (helpVisible && key.name === "escape")) {
      key.preventDefault();
      helpVisible = !helpVisible;
      searchBox.visible = !helpVisible;
      catBar.visible = !helpVisible;
      selectBox.visible = !helpVisible;
      helpBox.visible = helpVisible;
      return;
    }
    if (helpVisible) return;

    if (confirming) {
      if (key.name === "escape") {
        confirming = false; pendingDeleteKey = null;
        statusLine.content = "";
      }
      return;
    }

    if (key.name === "escape") {
      if (searchInput.value || activeCategory) {
        searchInput.value = "";
        activeCategory = null;
        updateCatChips();
        refreshList();
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

    // Category filter shortcuts (only when select is focused)
    if (renderer.currentFocusedRenderable === selectBox) {
      const catMatch = CATEGORIES.find(([k]) => k === key.name);
      if (catMatch) {
        key.preventDefault();
        activeCategory = catMatch[1] ?? null;
        updateCatChips();
        refreshList(searchInput.value);
        return;
      }

      if (key.name === "d") {
        key.preventDefault();
        const opt = selectBox.getSelectedOption();
        if (!opt) return;
        confirming = true;
        pendingDeleteKey = opt.value as string;
        statusLine.content = `  delete "${pendingDeleteKey}"? (enter to confirm / esc to cancel)`;
      }
    }
  };

  renderer._internalKeyInput.onInternal("keypress", onKey);

  return () => renderer._internalKeyInput.offInternal("keypress", onKey);
}
