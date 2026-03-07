import { getPage } from "../../browser.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "BrowserScroll",
    description: "Scroll the current browser page up, down, or to a specific element. Useful for infinite-scroll pages or revealing lazy-loaded content.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["down", "up", "top", "bottom"], description: "Scroll direction (default 'down')" },
        pixels: { type: "number", description: "Pixels to scroll (default 800). Ignored if direction is 'top' or 'bottom'." },
        selector: { type: "string", description: "CSS selector to scroll into view" },
      },
      required: [],
    },
  },

  async execute(input) {
    const page = await getPage();
    const direction = (input.direction as string | undefined) ?? "down";
    const pixels = (input.pixels as number | undefined) ?? 800;
    const selector = input.selector as string | undefined;

    if (selector) {
      await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
      return { content: `Scrolled "${selector}" into view.` };
    }

    await page.evaluate(({ dir, px }) => {
      if (dir === "top") window.scrollTo(0, 0);
      else if (dir === "bottom") window.scrollTo(0, document.body.scrollHeight);
      else if (dir === "up") window.scrollBy(0, -px);
      else window.scrollBy(0, px);
    }, { dir: direction, px: pixels });

    return { content: `Scrolled ${direction}${direction === "top" || direction === "bottom" ? "" : ` ${pixels}px`}.` };
  },
};
