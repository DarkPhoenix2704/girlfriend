// Telegram gateway — uses grammy for long-polling.
// Set TELEGRAM_BOT_TOKEN in env. Optionally TELEGRAM_ALLOWED_IDS (comma-separated chat IDs).

import { Bot, type Context } from "grammy";
import { log } from "../daemon-log.ts";
import type { Gateway, IncomingMessage, OutgoingMessage } from "./types.ts";
import { splitMessage } from "./router.ts";

const ALLOWED_IDS: Set<number> = new Set(
  (process.env.TELEGRAM_ALLOWED_IDS ?? "")
    .split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n))
);

function isAllowed(chatId: number): boolean {
  return ALLOWED_IDS.size === 0 || ALLOWED_IDS.has(chatId);
}

export class TelegramGateway implements Gateway {
  readonly source = "telegram" as const;
  private bot: Bot | null = null;

  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      log("warn", "TELEGRAM_BOT_TOKEN not set — Telegram gateway disabled");
      return;
    }

    this.bot = new Bot(token);

    // Built-in commands
    this.bot.command("start", (ctx) => ctx.reply(
      "Hey! I'm girlfriend — your personal AI assistant. Just send me a message."
    ));

    this.bot.command("reset", async (ctx) => {
      // A fresh session will be created on next message
      await ctx.reply("Conversation reset. Send a new message to start fresh.");
    });

    this.bot.command("memory", async (ctx) => {
      onMessage({
        source: "telegram",
        externalId: String(ctx.chat.id),
        senderName: ctx.from?.first_name,
        text: "List everything you remember about me (use SearchMemory with no filters).",
      });
    });

    this.bot.command("history", async (ctx) => {
      onMessage({
        source: "telegram",
        externalId: String(ctx.chat.id),
        senderName: ctx.from?.first_name,
        text: "Summarise our recent conversation history.",
      });
    });

    // Main message handler
    this.bot.on("message:text", async (ctx: Context) => {
      const chatId = ctx.chat!.id;
      if (!isAllowed(chatId)) {
        await ctx.reply("Sorry, you're not authorised to use this bot.");
        return;
      }

      // Show typing indicator while agent processes; keep refreshing every 4s
      let typingInterval: ReturnType<typeof setInterval> | null = null;
      try {
        await this.bot!.api.sendChatAction(chatId, "typing").catch(() => {});
        typingInterval = setInterval(() => {
          this.bot?.api.sendChatAction(chatId, "typing").catch(() => {});
        }, 4_000);

        await onMessage({
          source: "telegram",
          externalId: String(chatId),
          senderName: ctx.from?.first_name ?? ctx.from?.username,
          text: ctx.message!.text!,
        });
      } finally {
        if (typingInterval) clearInterval(typingInterval);
      }
    });

    this.bot.catch((err) => {
      log("error", "telegram bot error", { error: String(err) });
    });

    // Start long-polling in background — don't await, it runs forever
    this.bot.start({ drop_pending_updates: true }).catch((err) => {
      log("error", "telegram bot stopped unexpectedly", { error: String(err) });
    });
  }

  async send(msg: OutgoingMessage): Promise<void> {
    if (!this.bot) return;
    const chatId = parseInt(msg.externalId);
    for (const chunk of splitMessage(msg.text, 4096)) {
      await this.bot.api.sendMessage(chatId, chunk, { parse_mode: "Markdown" }).catch(async () => {
        // Markdown parse failure — retry as plain text
        await this.bot!.api.sendMessage(chatId, chunk);
      });
    }
  }

  async stop(): Promise<void> {
    await this.bot?.stop();
    this.bot = null;
  }
}
