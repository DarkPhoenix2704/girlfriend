import type { ToolDefinition } from "../types.ts";

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

export const definition: ToolDefinition = {
  concurrent: true,
  schema: {
    name: "Search",
    description: `Web search via Brave Search API. Returns top results with title, URL, and snippet.
Requires BRAVE_SEARCH_API_KEY environment variable.
Use this to find current information, news, documentation, or anything that requires a live web search.
Follow up with BrowserOpen to read the full content of a result.`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results to return (default 10, max 20)" },
        country: { type: "string", description: "Country code for results (e.g. 'IN', 'US'). Default: 'IN'" },
      },
      required: ["query"],
    },
  },

  async execute(input) {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return { content: "Error: BRAVE_SEARCH_API_KEY not set in environment.", is_error: true };
    }

    const query = input.query as string;
    const count = Math.min((input.count as number | undefined) ?? 10, 20);
    const country = (input.country as string | undefined) ?? "IN";

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    url.searchParams.set("country", country);
    url.searchParams.set("search_lang", "en");

    const response = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!response.ok) {
      return { content: `Brave Search error: ${response.status} ${response.statusText}`, is_error: true };
    }

    const data = await response.json() as BraveSearchResponse;
    const results = data.web?.results ?? [];

    if (results.length === 0) {
      return { content: "No results found." };
    }

    const lines = results.map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description ?? ""}`.trim()
    );

    return { content: `Search results for "${query}":\n\n${lines.join("\n\n")}` };
  },
};
