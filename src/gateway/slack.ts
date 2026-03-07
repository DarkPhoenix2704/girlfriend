// Slack gateway — uses @slack/bolt with Socket Mode (no public URL required).
// Set SLACK_BOT_TOKEN (xoxb-...) and SLACK_APP_TOKEN (xapp-...) in env.
// Enable Socket Mode + subscribe to message.im and app_mention events in Slack app settings.

import { App } from "@slack/bolt";
import { log } from "../daemon-log.ts";
import type { Gateway, IncomingMessage, OutgoingMessage } from "./types.ts";
import { splitMessage } from "./router.ts";

// Per-user rate limiting: 20 requests per minute
const _slackRateLimits = new Map<string, { count: number; resetAt: number }>();
function isSlackRateLimited(userId: string): boolean {
  const now = Date.now();
  const entry = _slackRateLimits.get(userId);
  if (!entry || now >= entry.resetAt) {
    _slackRateLimits.set(userId, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  if (entry.count >= 20) return true;
  entry.count++;
  return false;
}

export class SlackGateway implements Gateway {
  readonly source = "slack" as const;
  private app: App | null = null;
  // userId → channel to reply in (populated on first message from each user)
  private userChannels = new Map<string, string>();
  // userId → display name cache
  private userNames = new Map<string, string>();

  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    const botToken = process.env.SLACK_BOT_TOKEN;
    const appToken = process.env.SLACK_APP_TOKEN;
    if (!botToken || !appToken) {
      log("warn", "SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set — Slack gateway disabled");
      return;
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      // Suppress Bolt's own console logging; we use daemon-log
      logger: {
        debug: () => {},
        info:  () => {},
        warn:  (msg: string) => log("warn",  `slack: ${msg}`),
        error: (msg: string) => log("error", `slack: ${msg}`),
        setLevel: () => {},
        setName:  () => {},
        getLevel: () => "error" as never,
      },
    });

    // Direct messages
    this.app.message(async ({ message, client }) => {
      // Only handle plain user messages (no subtypes like bot_message, message_changed, etc.)
      if (message.subtype !== undefined) return;
      // Narrow: only messages with text and user
      const msg = message as { text?: string; user?: string; channel: string };
      if (!msg.text?.trim() || !msg.user) return;

      const userId = msg.user;

      if (isSlackRateLimited(userId)) {
        log("warn", "Slack rate limit exceeded", { userId });
        await client.chat.postMessage({ channel: msg.channel, text: "Too many requests — please wait a minute." });
        return;
      }

      this.userChannels.set(userId, msg.channel);
      const senderName = await this.resolveDisplayName(client, userId);

      log("info", "Slack DM received", { userId, text: msg.text.slice(0, 80) });

      await onMessage({
        source: "slack",
        externalId: userId,
        senderName,
        text: msg.text.trim(),
      });
    });

    // Channel mentions (@bot)
    this.app.event("app_mention", async ({ event, client }) => {
      const userId = event.user;
      if (!userId) return;

      if (isSlackRateLimited(userId)) {
        log("warn", "Slack rate limit exceeded", { userId });
        await client.chat.postMessage({ channel: event.channel, text: "Too many requests — please wait a minute." });
        return;
      }

      this.userChannels.set(userId, event.channel);
      const senderName = await this.resolveDisplayName(client, userId);

      // Strip the @mention prefix from text
      const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!text) return;

      log("info", "Slack mention received", { userId, channel: event.channel, text: text.slice(0, 80) });

      await onMessage({
        source: "slack",
        externalId: userId,
        senderName,
        text,
      });
    });

    this.app.error(async (err) => {
      log("error", "slack app error", { error: String(err) });
    });

    await this.app.start();
    log("info", "Slack gateway connected via Socket Mode");
  }

  async send(msg: OutgoingMessage): Promise<void> {
    if (!this.app) return;
    const channel = this.userChannels.get(msg.externalId) ?? msg.externalId;
    for (const chunk of splitMessage(msg.text, 3000)) {
      await this.app.client.chat.postMessage({ channel, text: chunk });
    }
  }

  async stop(): Promise<void> {
    await this.app?.stop();
    this.app = null;
  }

  private async resolveDisplayName(client: InstanceType<typeof App>["client"], userId: string): Promise<string | undefined> {
    const cached = this.userNames.get(userId);
    if (cached) return cached;
    try {
      const res = await client.users.info({ user: userId });
      const name = (res.user as { profile?: { display_name?: string; real_name?: string } } | undefined)
        ?.profile?.display_name
        || (res.user as { real_name?: string } | undefined)?.real_name
        || userId;
      this.userNames.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }
}
