import { getPage, extractPageText } from "../../browser.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "BrowserOpen",
    description: "Navigate to a URL in the browser and return the page title and readable text content. Use this to read web pages, articles, docs, or any URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to navigate to (must include https://)" },
        max_chars: { type: "number", description: "Max characters of page text to return (default 6000)" },
        wait_ms: { type: "number", description: "Extra ms to wait after load for dynamic content (default 0)" },
      },
      required: ["url"],
    },
  },

  async execute(input) {
    const url = input.url as string;
    const maxChars = (input.max_chars as number | undefined) ?? 6000;
    const waitMs = (input.wait_ms as number | undefined) ?? 0;

    const page = await getPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (waitMs > 0) await page.waitForTimeout(waitMs);

    const title = await page.title();
    const text = await extractPageText(page, maxChars);

    return { content: `# ${title}\nURL: ${page.url()}\n\n${text}` };
  },
};
