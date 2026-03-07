import { getPage } from "../../browser.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "BrowserClick",
    description: "Click an element on the current browser page by CSS selector or visible text.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click (e.g. '#submit', '.btn-primary')" },
        text: { type: "string", description: "Visible text of the element to click (used if selector is not provided)" },
        wait_for_nav: { type: "boolean", description: "If true, wait for navigation after click (default false)" },
      },
      required: [],
    },
  },

  async execute(input) {
    const page = await getPage();
    const selector = input.selector as string | undefined;
    const text = input.text as string | undefined;
    const waitNav = (input.wait_for_nav as boolean | undefined) ?? false;

    if (!selector && !text) {
      return { content: "Error: provide either selector or text", is_error: true };
    }

    const locator = selector
      ? page.locator(selector).first()
      : page.getByText(text!, { exact: false }).first();

    if (waitNav) {
      await Promise.all([page.waitForNavigation({ timeout: 15_000 }), locator.click({ timeout: 10_000 })]);
    } else {
      await locator.click({ timeout: 10_000 });
    }

    return { content: `Clicked: ${selector ?? `text="${text}"`}. Current URL: ${page.url()}` };
  },
};
