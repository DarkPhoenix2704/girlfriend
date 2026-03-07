import { getPage, getAriaSnapshot } from "../../browser.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "BrowserOpen",
    description: `Navigate to a URL and return the page as a YAML accessibility snapshot.
The snapshot is a structured, token-efficient representation of the page — headings, links, buttons, inputs, text — without images.
Use BrowserClick / BrowserFill to interact, BrowserScreenshot only when you truly need to see visuals.`,
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to navigate to (must include https://)" },
        wait_ms: { type: "number", description: "Extra ms to wait after load for dynamic content (default 0)" },
        max_chars: { type: "number", description: "Max characters of snapshot to return (default 12000)" },
      },
      required: ["url"],
    },
  },

  async execute(input) {
    const url = input.url as string;
    const waitMs = (input.wait_ms as number | undefined) ?? 0;
    const maxChars = (input.max_chars as number | undefined) ?? 12_000;

    const page = await getPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (waitMs > 0) await page.waitForTimeout(waitMs);

    const title = await page.title();
    const snapshot = await getAriaSnapshot(page, maxChars);

    return { content: `# ${title}\nURL: ${page.url()}\n\n${snapshot}` };
  },
};
