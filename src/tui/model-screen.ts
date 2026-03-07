// Model selection screen

import {
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BG, FG, MUTED, PINK, RED } from "./theme.ts";
import { makeHeader, makeFooter } from "./components.ts";
import type Anthropic from "@anthropic-ai/sdk";

export interface ModelScreenContext {
  renderer: CliRenderer;
  client: Anthropic;
  onSelect: (modelId: string) => void;
  onBack: () => void;
}

export async function mountModelScreen(ctx: ModelScreenContext): Promise<() => void> {
  const { renderer } = ctx;

  const header = makeHeader(renderer, " select model ");
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
  renderer.root.add(makeFooter(renderer, "enter: select  esc: back  ctrl+c: exit"));

  try {
    const resp = await ctx.client.models.list({ limit: 100 });
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
    if (opt?.value) ctx.onSelect(opt.value as string);
  });

  const onKey = (key: KeyEvent) => {
    if (key.name === "escape") { key.preventDefault(); ctx.onBack(); }
  };
  renderer._internalKeyInput.onInternal("keypress", onKey);

  return () => renderer._internalKeyInput.offInternal("keypress", onKey);
}
