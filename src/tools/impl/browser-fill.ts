import { getPage } from "../../browser.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "BrowserFill",
    description: "Fill an input field or textarea on the current page. Optionally press Enter to submit.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the input field" },
        value: { type: "string", description: "Text to type into the field" },
        press_enter: { type: "boolean", description: "Press Enter after filling (default false)" },
        clear_first: { type: "boolean", description: "Clear existing value before filling (default true)" },
      },
      required: ["selector", "value"],
    },
  },

  async execute(input) {
    const page = await getPage();
    const selector = input.selector as string;
    const value = input.value as string;
    const pressEnter = (input.press_enter as boolean | undefined) ?? false;
    const clearFirst = (input.clear_first as boolean | undefined) ?? true;

    const locator = page.locator(selector).first();
    if (clearFirst) await locator.clear({ timeout: 10_000 });
    await locator.fill(value, { timeout: 10_000 });
    if (pressEnter) await locator.press("Enter");

    return { content: `Filled "${selector}" with value. Current URL: ${page.url()}` };
  },
};
