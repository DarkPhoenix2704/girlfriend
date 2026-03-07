// Shared UI components and helpers

import {
  BoxRenderable,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { PINK, MUTED, BG } from "./theme.ts";

export function makeHeader(renderer: CliRenderer, title: string): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    width: "100%", height: 3, border: true, borderStyle: "rounded", borderColor: PINK,
  });
  box.title = title;
  return box;
}

export function makeFooter(renderer: CliRenderer, hints: string): TextRenderable {
  return new TextRenderable(renderer, {
    content: `  ${hints}`,
    fg: MUTED, width: "100%", height: 1, marginBottom: 1,
  });
}

/** Create a help overlay box (initially hidden). Toggle visible to show/hide. */
export function makeHelpBox(renderer: CliRenderer, shortcuts: [string, string][]): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    width: "100%", flexGrow: 1,
    visible: false,
    flexDirection: "column",
    paddingLeft: 4, paddingTop: 1,
    backgroundColor: BG,
  });

  box.add(new TextRenderable(renderer, {
    content: "  keyboard shortcuts", fg: PINK, width: "100%", marginBottom: 1,
  }));

  for (const [key, desc] of shortcuts) {
    const row = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", height: 1 });
    row.add(new TextRenderable(renderer, { content: `  ${key}`, fg: PINK, minWidth: 22 }));
    row.add(new TextRenderable(renderer, { content: desc, fg: MUTED }));
    box.add(row);
  }

  box.add(new TextRenderable(renderer, { content: "\n  press ? or esc to close", fg: MUTED, width: "100%" }));
  return box;
}
