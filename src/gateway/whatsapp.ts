// WhatsApp gateway — uses Baileys (unofficial, QR-based auth).
// Auth state persisted at ~/.girlfriend/whatsapp-auth/.
// Message filtering is configured in ~/.girlfriend/config.toml [whatsapp].

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import { mkdirSync } from "fs";
import { join } from "path";
import qrcodeTerminal from "qrcode-terminal";
import { log } from "../daemon-log.ts";
import type { Gateway, IncomingMessage, OutgoingMessage } from "./types.ts";
import { loadConfig } from "../config.ts";

const AUTH_DIR = join(process.env.HOME ?? ".", ".girlfriend", "whatsapp-auth");

// Per-JID rate limiting: 20 requests per minute
const _waRateLimits = new Map<string, { count: number; resetAt: number }>();
function isWaRateLimited(jid: string): boolean {
  const now = Date.now();
  const entry = _waRateLimits.get(jid);
  if (!entry || now >= entry.resetAt) {
    _waRateLimits.set(jid, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  if (entry.count >= 20) return true;
  entry.count++;
  return false;
}

/** Normalise a Baileys JID to just the numeric part (strips :device and @domain). */
function jidNumber(jid: string): string {
  return jid.split(":")[0]!.split("@")[0]!;
}

/** Recursively unwrap ephemeral/viewOnce/document-with-caption wrappers. */
function extractText(msg: proto.IMessage | null | undefined): string | null {
  if (!msg) return null;

  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;

  if (msg.imageMessage?.caption)    return msg.imageMessage.caption;
  if (msg.videoMessage?.caption)    return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;

  if (msg.buttonsResponseMessage?.selectedDisplayText)
    return msg.buttonsResponseMessage.selectedDisplayText;
  if (msg.listResponseMessage?.title)
    return msg.listResponseMessage.title;
  if (msg.templateButtonReplyMessage?.selectedDisplayText)
    return msg.templateButtonReplyMessage.selectedDisplayText;

  if (msg.ephemeralMessage?.message)  return extractText(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage?.message)   return extractText(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2?.message) return extractText(msg.viewOnceMessageV2.message);

  return null;
}

/** Serialize anything the Baileys logger might pass to a readable string. */
function serialize(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export class WhatsAppGateway implements Gateway {
  readonly source = "whatsapp" as const;
  private sock: WASocket | null = null;
  private onMessage: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private stopping = false;
  private reconnecting = false;
  private ownNumber: string | null = null; // phone number from sock.user.id
  private ownLid: string | null = null;    // linked identity ID from sock.user.lid (@lid JIDs)
  // Track IDs of messages we sent so we don't process our own replies
  private sentIds = new Set<string>();

  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      logger: {
        level:  "silent",
        trace:  () => {},
        debug:  () => {},
        info:   () => {},
        warn:   (v: unknown) => log("warn",  serialize(v)),
        error:  (v: unknown) => log("error", serialize(v)),
        fatal:  (v: unknown) => log("error", serialize(v)),
        child:  () => ({
          level: "silent",
          trace: () => {}, debug: () => {}, info: () => {},
          warn:  (v: unknown) => log("warn",  serialize(v)),
          error: (v: unknown) => log("error", serialize(v)),
          fatal: (v: unknown) => log("error", serialize(v)),
          child: () => ({} as never),
        }),
      } as never,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        console.log("\n── Scan this QR code with WhatsApp ──\n");
        qrcodeTerminal.generate(qr, { small: true });
        log("info", "WhatsApp QR ready — scan to authenticate");
      }

      if (connection === "open") {
        this.reconnecting = false;
        this.ownNumber = this.sock?.user?.id ? jidNumber(this.sock.user.id) : null;
        const userAny = this.sock?.user as Record<string, unknown> | undefined;
        this.ownLid = userAny?.lid ? jidNumber(String(userAny.lid)) : null;
        log("info", "WhatsApp connected", { ownNumber: this.ownNumber, ownLid: this.ownLid });
      }

      if (connection === "close" && !this.stopping) {
        this.reconnecting = false;
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        log("warn", "WhatsApp disconnected", { code, reconnecting: shouldReconnect });
        if (shouldReconnect) {
          setTimeout(() => this.connect(), 5_000);
        } else {
          log("error", "WhatsApp logged out — delete ~/.girlfriend/whatsapp-auth and restart");
        }
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      const cfg = loadConfig().whatsapp;

      for (const msg of messages) {
        const jid = msg.key.remoteJid ?? "";

        // Skip our own sent bot replies
        if (msg.key.id && this.sentIds.has(msg.key.id)) {
          this.sentIds.delete(msg.key.id);
          continue;
        }

        if (!jid || jid.endsWith("@g.us")) continue; // skip groups

        const jidNum = jidNumber(jid);
        const fromMe = msg.key.fromMe === true;

        // Check: saved messages (you → yourself)
        const isSavedMessages = cfg.allow_saved_messages && fromMe && (
          (this.ownNumber != null && jidNum === this.ownNumber) ||
          (this.ownLid    != null && jidNum === this.ownLid)
        );

        // Check: allowed external contacts
        const isAllowedContact = !fromMe && cfg.allowed_numbers.length > 0 &&
          cfg.allowed_numbers.some((n) => jidNum === n.replace(/\D/g, ""));

        if (!isSavedMessages && !isAllowedContact) {
          log("info", "WhatsApp message ignored", { jid, fromMe });
          continue;
        }

        const text = extractText(msg.message);
        if (!text?.trim()) {
          log("info", "WhatsApp message ignored (no text)", { jid });
          continue;
        }

        if (isWaRateLimited(jid)) {
          log("warn", "WhatsApp rate limit exceeded", { jid });
          try { await this.sock?.sendMessage(jid, { text: "Too many requests — please wait a minute." }); } catch { /* non-fatal */ }
          continue;
        }

        log("info", "WhatsApp message received", { jid, fromMe, text: text.slice(0, 80) });

        try { await this.sock?.readMessages([msg.key]); } catch { /* non-fatal */ }
        try { await this.sock?.sendPresenceUpdate("composing", jid); } catch { /* non-fatal */ }
        try { await this.sock?.sendMessage(jid, { react: { text: "👀", key: msg.key } }); } catch { /* non-fatal */ }

        let success = false;
        try {
          await this.onMessage?.({
            source: "whatsapp",
            externalId: jid,
            senderName: msg.pushName ?? undefined,
            text: text.trim(),
          });
          success = true;
        } finally {
          try { await this.sock?.sendPresenceUpdate("paused", jid); } catch { /* non-fatal */ }
          try { await this.sock?.sendMessage(jid, { react: { text: success ? "✅" : "❌", key: msg.key } }); } catch { /* non-fatal */ }
        }
      }
    });
  }

  async send(msg: OutgoingMessage): Promise<void> {
    if (!this.sock) return;
    const jid = msg.externalId.includes("@")
      ? msg.externalId
      : `${msg.externalId}@s.whatsapp.net`;
    const result = await this.sock.sendMessage(jid, { text: msg.text });
    if (result?.key?.id) {
      this.sentIds.add(result.key.id);
      setTimeout(() => this.sentIds.delete(result.key.id!), 30_000);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.reconnecting = false;
    await this.sock?.end(undefined);
    this.sock = null;
  }
}
