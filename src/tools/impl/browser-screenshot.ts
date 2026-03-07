import { getPage } from "../../browser.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "BrowserScreenshot",
    description: "Capture a screenshot of the current browser page as base64 PNG. Use this ONLY when you need to visually inspect layout, images, or charts — BrowserOpen's YAML snapshot is preferred for reading content as it uses far fewer tokens.",
    input_schema: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "Capture the full scrollable page (default false — viewport only)" },
        selector: { type: "string", description: "CSS selector to screenshot a specific element only" },
      },
      required: [],
    },
  },

  async execute(input) {
    const page = await getPage();
    const fullPage = (input.full_page as boolean | undefined) ?? false;
    const selector = input.selector as string | undefined;

    let screenshotBuffer: Buffer;
    if (selector) {
      const el = page.locator(selector).first();
      screenshotBuffer = await el.screenshot({ type: "png" }) as Buffer;
    } else {
      screenshotBuffer = await page.screenshot({ type: "png", fullPage }) as Buffer;
    }

    const base64 = screenshotBuffer.toString("base64");
    // Return as image content block for vision models
    return {
      content: JSON.stringify({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64 },
      }),
    };
  },
};
