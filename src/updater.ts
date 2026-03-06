// Background update checker — fires on startup, never blocks.
// Stores the latest version in the memory table; tui.ts reads it to show a banner.

import { memoryGet, memorySet } from "./sessions.ts";

const REPO = "DarkPhoenix2704/girlfriend";
const MEMORY_KEY = "__update_available__";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // recheck at most every 6h
const LAST_CHECK_KEY = "__update_last_check__";

// Embedded at build time from package.json
import pkg from "../npm/package.json" with { type: "json" };
export const CURRENT_VERSION: string = pkg.version;

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

export function getUpdateNotice(): string | null {
  return memoryGet(MEMORY_KEY);
}

export function dismissUpdate(): void {
  memorySet(MEMORY_KEY, "");
}

export function checkForUpdates(): void {
  // Don't recheck if we checked recently
  const lastCheck = memoryGet(LAST_CHECK_KEY);
  if (lastCheck && Date.now() - Number(lastCheck) < CHECK_INTERVAL_MS) return;

  // Fire and forget — never await, never throw into the main thread
  (async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { "User-Agent": "girlfriend-updater" },
      });
      if (!res.ok) return;
      const data = await res.json() as { tag_name: string };
      const latest = data.tag_name;

      memorySet(LAST_CHECK_KEY, String(Date.now()));

      if (semverGt(latest, CURRENT_VERSION)) {
        memorySet(MEMORY_KEY, latest);
      } else {
        // Clear stale notice if already up to date
        memorySet(MEMORY_KEY, "");
      }
    } catch {
      // silently ignore — no network, rate limit, etc.
    }
  })();
}
