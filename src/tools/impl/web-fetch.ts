import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  concurrent: true,
  schema: {
    name: "WebFetch",
    description: `Fetches content from a URL and returns it as text. Use this to read documentation, APIs, or any web content needed for the task.`,
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },

  async execute(input) {
    const url = input.url as string;

    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; girlfriend/1.0)",
        "Accept": "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.7",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      return { content: `<tool_use_error>HTTP ${resp.status} ${resp.statusText} for ${url}</tool_use_error>`, is_error: true };
    }

    const contentType = resp.headers.get("content-type") ?? "";
    let text: string;

    if (contentType.includes("text/html")) {
      const html = await resp.text();
      text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    } else {
      text = await resp.text();
    }

    const MAX = 50_000;
    if (text.length > MAX) text = text.slice(0, MAX) + `\n\n[Content truncated at ${MAX} chars]`;

    return { content: text };
  },
};
