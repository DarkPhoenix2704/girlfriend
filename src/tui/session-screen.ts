// Session list screen

import {
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { YELLOW, BG, FG, MUTED, PINK } from "./theme.ts";
import { makeHeader, makeFooter } from "./components.ts";
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
  renderer.root.add(makeFooter(renderer, "enter: open  n: new  d: delete (then enter)  esc: back  ctrl+c: exit"));

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
      ctx.onBack();
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
