// Notify tool — sends a proactive message to the user's configured channel.
// Uses the active GatewayRouter; falls back to printing to stdout if unavailable.

import type { ToolDefinition } from "../types.ts";
import { getActiveRouter } from "../index.ts";
import { config } from "../../config.ts";

export const definition: ToolDefinition = {
  schema: {
    name: "Notify",
    description:
      "Send a proactive message to the user through their configured notification channel " +
      "(Telegram, WhatsApp, etc). Use this when a cron job completes, a background task " +
      "finishes, or you need to alert the user without waiting for them to message first.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The message to send to the user.",
        },
        channel: {
          type: "string",
          description:
            "Override the default notification channel. One of: 'telegram', 'whatsapp'. " +
            "Omit to use the channel configured in ~/.girlfriend/config.toml.",
        },
        chat_id: {
          type: "string",
          description:
            "Override the default chat_id / phone number. Omit to use the one in config.",
        },
      },
      required: ["message"],
    },
  },

  async execute(input) {
    const { message, channel: channelOverride, chat_id: chatIdOverride } =
      input as { message: string; channel?: string; chat_id?: string };

    const cfg = config().notify;
    const channel = channelOverride ?? cfg.channel;
    const chatId  = chatIdOverride  ?? cfg.chat_id;

    const router = getActiveRouter();

    if (!router) {
      // No router available — print to stdout as fallback (useful in tests)
      console.log(`[Notify → ${channel}] ${message}`);
      return { content: "notification printed to stdout (no active router)" };
    }

    if (!chatId) {
      return {
        content: "notify failed: chat_id not configured. Set notify.chat_id in ~/.girlfriend/config.toml or pass chat_id parameter.",
        is_error: true,
      };
    }

    const source = channel as "telegram" | "whatsapp" | "local" | "http";
    await router.sendDirect({ source, externalId: chatId, text: message });
    return { content: `notification sent via ${channel} to ${chatId}` };
  },
};
