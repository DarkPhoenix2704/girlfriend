import { getPage } from "../../browser.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "BrowserExtract",
    description: "Extract structured data from the current page — tables, lists, or any elements matching a CSS selector. Returns as formatted text.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for elements to extract (e.g. 'table', 'ul.results li', '.price')" },
        attribute: { type: "string", description: "If set, extract this attribute instead of inner text (e.g. 'href', 'src')" },
        limit: { type: "number", description: "Max elements to return (default 50)" },
      },
      required: ["selector"],
    },
  },

  async execute(input) {
    const page = await getPage();
    const selector = input.selector as string;
    const attribute = input.attribute as string | undefined;
    const limit = (input.limit as number | undefined) ?? 50;

    const results = await page.evaluate(
      ({ sel, attr, max }) => {
        const elements = Array.from(document.querySelectorAll(sel)).slice(0, max);
        return elements.map((el) =>
          attr ? (el as HTMLElement).getAttribute(attr) ?? "" : (el as HTMLElement).innerText?.trim() ?? ""
        );
      },
      { sel: selector, attr: attribute, max: limit }
    );

    if (results.length === 0) {
      return { content: `No elements found matching: ${selector}` };
    }

    const lines = results.map((r, i) => `${i + 1}. ${r}`).join("\n");
    return { content: `Extracted ${results.length} elements (${selector}):\n\n${lines}` };
  },
};
