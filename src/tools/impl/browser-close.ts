import { closeBrowser, resetPage } from "../../browser.ts";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "BrowserClose",
    description: "Close the current browser page or the entire browser. Use 'page' to reset state while keeping the browser alive; use 'browser' to shut down completely.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["page", "browser"], description: "'page' resets the tab (default); 'browser' shuts down Chromium entirely" },
      },
      required: [],
    },
  },

  async execute(input) {
    const target = (input.target as string | undefined) ?? "page";
    if (target === "browser") {
      await closeBrowser();
      return { content: "Browser closed." };
    }
    await resetPage();
    return { content: "Page closed. Browser still running." };
  },
};
