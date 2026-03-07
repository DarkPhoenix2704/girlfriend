// Config loader — reads ~/.girlfriend/config.toml on first access, cached thereafter.
// All fields are optional; missing keys fall back to sensible defaults or env vars.
// Uses Bun's native TOML import support (no extra package needed).

import { existsSync, readFileSync, mkdirSync, writeFileSync, watch } from "fs";
import { join } from "path";

const DATA_DIR = join(process.env.HOME ?? ".", ".girlfriend");
const CONFIG_PATH = join(DATA_DIR, "config.toml");

export interface Config {
  model: {
    default: string;
  };
  telegram: {
    enabled: boolean;
  };
  whatsapp: {
    enabled: boolean;
    /** Accept messages you send to your own Saved Messages chat */
    allow_saved_messages: boolean;
    /** Accept messages from these phone numbers (e.g. ["919876543210"]) */
    allowed_numbers: string[];
  };
  browser: {
    headless: boolean;
  };
  search: {
    country: string;
    count: number;
  };
  notify: {
    /** "telegram" | "whatsapp" — channel to send proactive notifications through */
    channel: string;
    /** Telegram chat_id or WhatsApp number for proactive notifications */
    chat_id: string;
  };
  memory: {
    consolidation_enabled: boolean;
    consolidation_schedule: string;
  };
  slack: {
    enabled: boolean;
  };
  http: {
    /** Enable the local HTTP gateway for TUI → daemon communication */
    enabled: boolean;
    /** Port for the HTTP server (default 7070) */
    port: number;
  };
}

const DEFAULTS: Config = {
  model:    { default: "claude-sonnet-4-6" },
  telegram: { enabled: true },
  whatsapp: { enabled: false, allow_saved_messages: true, allowed_numbers: [] },
  browser:  { headless: true },
  search:   { country: "IN", count: 5 },
  notify:   { channel: "telegram", chat_id: "" },
  memory:   { consolidation_enabled: true, consolidation_schedule: "0 3 * * *" },
  slack:    { enabled: false },
  http:     { enabled: true, port: 7070 },
};

let _config: Config | null = null;

function deepMerge<T>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override ?? {}) as (keyof T)[]) {
    const v = override[key];
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof base[key] === "object") {
      (result[key] as unknown) = deepMerge(base[key], v as Partial<T[keyof T]>);
    } else if (v !== undefined) {
      result[key] = v as T[keyof T];
    }
  }
  return result;
}

export function loadConfig(): Config {
  if (_config) return _config;

  if (!existsSync(CONFIG_PATH)) {
    _config = DEFAULTS;
    return _config;
  }

  try {
    // Bun natively parses TOML files imported with the .toml extension.
    // For a dynamic path at runtime we read the raw text and parse via Bun.TOML.parse().
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = Bun.TOML.parse(raw) as Partial<Config>;
    _config = deepMerge(DEFAULTS, parsed);
  } catch (err) {
    console.error(`[config] failed to parse ${CONFIG_PATH}:`, err);
    _config = DEFAULTS;
  }

  return _config;
}

/** Write a starter config.toml if none exists. */
export function initConfig(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(CONFIG_PATH)) return;

  const starter = `# girlfriend config — ~/.girlfriend/config.toml
# Secrets (API keys, bot tokens) stay in environment variables, not here.

[model]
default = "claude-sonnet-4-6"

[telegram]
enabled = true
# Set TELEGRAM_BOT_TOKEN env var to activate

[whatsapp]
enabled = false
allow_saved_messages = true        # accept messages you send to yourself (Saved Messages)
allowed_numbers = []               # e.g. ["919876543210"] to also accept specific contacts

[browser]
headless = true   # set to false to watch the browser

[search]
country = "IN"
count = 5

[notify]
channel = "telegram"   # channel for proactive agent notifications
chat_id = ""           # your Telegram chat_id or WhatsApp number

[memory]
consolidation_enabled = true
consolidation_schedule = "0 3 * * *"   # nightly at 3am

[slack]
enabled = false
# Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN env vars to activate

[http]
enabled = true
port = 7070   # TUI connects here when daemon is running
# Set GIRLFRIEND_HTTP_TOKEN env var to require auth
`;
  writeFileSync(CONFIG_PATH, starter, "utf-8");
  console.log(`created starter config at ${CONFIG_PATH}`);
}

/** Convenience accessor — always returns the cached config. */
export function config(): Config {
  return loadConfig();
}

/**
 * Watch config.toml for changes and reload automatically.
 * Call once from the daemon on startup. Returns a cleanup function.
 */
export function watchConfig(onChange?: (cfg: Config) => void): () => void {
  if (!existsSync(CONFIG_PATH)) return () => {};

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(CONFIG_PATH, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      const prev = _config;
      _config = null; // invalidate cache so loadConfig re-reads
      try {
        const newCfg = loadConfig();
        onChange?.(newCfg);
      } catch (err) {
        _config = prev; // restore previous config on parse failure
        console.error("[config] reload failed, keeping previous config:", err);
      }
    }, 300);
  });

  return () => {
    if (debounce) clearTimeout(debounce);
    watcher.close();
  };
}
