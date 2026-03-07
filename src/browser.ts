// Singleton Playwright browser manager.
// One Chromium instance, one active page. Restarts on crash.
// Set BROWSER_HEADED=1 to run with a visible window.

import { chromium, type Browser, type Page } from "playwright";

let _browser: Browser | null = null;
let _page: Page | null = null;

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

/** Extract readable text from the current page (strips scripts/styles). */
export async function extractPageText(page: Page, maxChars = 8000): Promise<string> {
  const text = await page.evaluate(() => {
    // Remove noisy elements
    document.querySelectorAll("script,style,noscript,svg,nav,footer,header").forEach((el) => el.remove());
    return (document.body?.innerText ?? "").replace(/\s{3,}/g, "\n\n").trim();
  });
  return text.slice(0, maxChars);
}
