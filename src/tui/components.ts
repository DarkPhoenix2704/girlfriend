// Shared UI components and helpers

import {
  BoxRenderable,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { PINK, MUTED } from "./theme.ts";

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
