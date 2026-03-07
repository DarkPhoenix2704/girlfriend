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

function extractText(msg: proto.IMessage | null | undefined): string | null {
  if (!msg) return null;
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    null
  );
}

export class WhatsAppGateway implements Gateway {
  readonly source = "whatsapp" as const;
  private sock: WASocket | null = null;
  private onMessage: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private stopping = false;

  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    mkdirSync(AUTH_DIR, { recursive: true });
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // we handle QR ourselves
      logger: {
        // Silence noisy Baileys logger
        level: "silent",
        trace: () => {}, debug: () => {}, info: () => {},
        warn: (msg: unknown) => log("warn", String(msg)),
        error: (msg: unknown) => log("error", String(msg)),
        fatal: (msg: unknown) => log("error", String(msg)),
        child: () => ({ level: "silent", trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({} as any) }),
      } as any,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        // Print QR code to terminal for initial auth
        console.log("\n── Scan this QR code with WhatsApp ──\n");
        qrcodeTerminal.generate(qr, { small: true });
        // Also log the raw QR for headless setups
        log("info", "WhatsApp QR ready — scan to authenticate", { qr: qr.slice(0, 40) + "…" });
      }

      if (connection === "open") {
        log("info", "WhatsApp connected");
      }

      if (connection === "close" && !this.stopping) {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        log("warn", "WhatsApp disconnected", { code, reconnecting: shouldReconnect });
        if (shouldReconnect) {
          setTimeout(() => this.connect(), 5_000);
        } else {
          log("error", "WhatsApp logged out — delete auth dir and restart");
        }
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue; // ignore our own messages
        const jid = msg.key.remoteJid ?? "";
        if (!jid || jid.endsWith("@g.us")) continue; // skip groups for now

        const text = extractText(msg.message);
        if (!text?.trim()) continue;

        if (!isAllowed(jid)) {
          await this.sock?.sendMessage(jid, { text: "Sorry, you're not authorised." });
          continue;
        }

        const number = jid.split("@")[0] ?? jid;
        await this.onMessage?.({
          source: "whatsapp",
          externalId: number,
          senderName: msg.pushName ?? undefined,
          text: text.trim(),
        });
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
    await this.sock?.end(undefined);
    this.sock = null;
  }
}
