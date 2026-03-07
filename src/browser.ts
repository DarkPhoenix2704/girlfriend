// Singleton Playwright browser manager.
// One Chromium instance, one active page. Restarts on crash.
// Set BROWSER_HEADED=1 to run with a visible window.

import { chromium, type Browser, type Page } from "playwright";

let _browser: Browser | null = null;
let _page: Page | null = null;
let _lastUsedAt = 0;
const BROWSER_IDLE_MS = 5 * 60 * 1000; // close after 5 min idle

async function launchBrowser(): Promise<Browser> {
  const headed = process.env.BROWSER_HEADED === "1";
  const browser = await chromium.launch({ headless: !headed });
  browser.on("disconnected", () => {
    _browser = null;
    _page = null;
  });
  return browser;
}

export async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await launchBrowser();
    _page = null;
  }
  return _browser;
}

export async function getPage(): Promise<Page> {
  // Auto-close stale browser to reclaim memory after idle period
  if (_browser && _browser.isConnected() && Date.now() - _lastUsedAt > BROWSER_IDLE_MS) {
    await closeBrowser();
  }
  _lastUsedAt = Date.now();
  const browser = await getBrowser();
  if (!_page || _page.isClosed()) {
    const ctx = await browser.newContext({
      // No stored cookies — fresh incognito-style context each time
      storageState: undefined,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    _page = await ctx.newPage();
  }
  return _page;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _page = null;
  }
}

export async function resetPage(): Promise<void> {
  if (_page && !_page.isClosed()) {
    await _page.close();
    _page = null;
  }
}

/**
 * Returns the page as a YAML accessibility snapshot (aria snapshot).
 * This is the Playwright MCP approach — structured, no images, very token-efficient.
 * Playwright 1.48+ supports page.locator("body").ariaSnapshot() natively.
 */
export async function getAriaSnapshot(page: Page, maxChars = 12_000): Promise<string> {
  const yaml = await page.locator("body").ariaSnapshot();
  return yaml.slice(0, maxChars);
}
