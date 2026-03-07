import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { getPage, getAriaSnapshot } from "../../browser.ts";
import type { ToolDefinition } from "../types.ts";

/**
 * SSRF guard using the same ipaddr.js logic as request-filtering-agent.
 * DNS-resolves the hostname so loopback-domain tricks (e.g. 127.0.0.1.nip.io) are caught.
 * Throws if the URL targets a private, reserved, or non-unicast address.
 */
async function assertSafeUrl(urlStr: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { throw new Error(`Invalid URL: ${urlStr}`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Protocol not allowed: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  const addresses = await lookup(hostname, { all: true }).catch((err) => {
    throw new Error(`DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : err}`);
  });
  for (const { address } of addresses) {
    const ip = ipaddr.parse(address);
    const range = ip.range();
    if (range !== "unicast") {
      throw new Error(`Request blocked: ${hostname} resolves to ${address} (${range})`);
    }
  }
}

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

    try {
      await assertSafeUrl(url);
    } catch (err) {
      return { content: `<tool_use_error>${err instanceof Error ? err.message : String(err)}</tool_use_error>`, is_error: true };
    }

    const page = await getPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (waitMs > 0) await page.waitForTimeout(waitMs);

    const title = await page.title();
    const snapshot = await getAriaSnapshot(page, maxChars);

    return { content: `# ${title}\nURL: ${page.url()}\n\n${snapshot}` };
  },
};
