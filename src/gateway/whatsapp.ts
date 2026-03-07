// WhatsApp gateway — uses Baileys (unofficial, QR-based auth).
// Auth state persisted at ~/.girlfriend/whatsapp-auth/.
// Set WHATSAPP_ALLOWED_NUMBERS (comma-separated) to restrict access.

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

const AUTH_DIR = join(process.env.HOME ?? ".", ".girlfriend", "whatsapp-auth");
const ALLOWED_NUMBERS: Set<string> = new Set(
  (process.env.WHATSAPP_ALLOWED_NUMBERS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean)
);

function isAllowed(jid: string): boolean {
  if (ALLOWED_NUMBERS.size === 0) return true;
  const number = jid.split("@")[0] ?? "";
  return ALLOWED_NUMBERS.has(number);
}

/** Recursively unwrap ephemeral/viewOnce/document-with-caption wrappers. */
function extractText(msg: proto.IMessage | null | undefined): string | null {
  if (!msg) return null;

  // Plain text
  if (msg.conversation) return msg.conversation;

  // Text with link preview
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;

  // Image / video / document captions
  if (msg.imageMessage?.caption)    return msg.imageMessage.caption;
  if (msg.videoMessage?.caption)    return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;

  // Button / list responses
  if (msg.buttonsResponseMessage?.selectedDisplayText)
    return msg.buttonsResponseMessage.selectedDisplayText;
  if (msg.listResponseMessage?.title)
    return msg.listResponseMessage.title;
  if (msg.templateButtonReplyMessage?.selectedDisplayText)
    return msg.templateButtonReplyMessage.selectedDisplayText;

  // Disappearing / view-once wrappers — unwrap recursively
  if (msg.ephemeralMessage?.message)
    return extractText(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage?.message)
    return extractText(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2?.message)
    return extractText(msg.viewOnceMessageV2.message);

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

  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    mkdirSync(AUTH_DIR, { recursive: true });
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.reconnecting) return; // prevent double-connect
    this.reconnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
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
        log("info", "WhatsApp QR ready — scan to authenticate", { qr: qr.slice(0, 40) + "…" });
      }

      if (connection === "open") {
        this.reconnecting = false;
        log("info", "WhatsApp connected");
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

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid ?? "";
        if (!jid || jid.endsWith("@g.us")) continue; // skip groups

        const text = extractText(msg.message);
        if (!text?.trim()) continue;

        if (!isAllowed(jid)) {
          await this.sock?.sendMessage(jid, { text: "Sorry, you're not authorised." });
          continue;
        }

        // Mark as read so the user sees a blue tick
        try {
          await this.sock?.readMessages([msg.key]);
        } catch { /* non-fatal */ }

        // Show typing indicator while agent processes
        try {
          await this.sock?.sendPresenceUpdate("composing", jid);
        } catch { /* non-fatal */ }

        const number = jid.split("@")[0] ?? jid;
        try {
          await this.onMessage?.({
            source: "whatsapp",
            externalId: number,
            senderName: msg.pushName ?? undefined,
            text: text.trim(),
          });
        } finally {
          // Clear typing indicator when done (whether success or error)
          try { await this.sock?.sendPresenceUpdate("paused", jid); } catch { /* non-fatal */ }
        }
      }
    });
  }

  async send(msg: OutgoingMessage): Promise<void> {
    if (!this.sock) return;
    const jid = `${msg.externalId}@s.whatsapp.net`;
    await this.sock.sendMessage(jid, { text: msg.text });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.reconnecting = false;
    await this.sock?.end(undefined);
    this.sock = null;
  }
}
