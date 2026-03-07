// Gateway interface — every channel (Telegram, WhatsApp, HTTP) implements this.

export type GatewaySource = "telegram" | "whatsapp" | "http";

export interface IncomingMessage {
  /** Which gateway delivered this message */
  source: GatewaySource;
  /** Unique identifier within the source (chat_id, phone number, etc.) */
  externalId: string;
  /** Display name of the sender (optional) */
  senderName?: string;
  /** The text content */
  text: string;
}

export interface OutgoingMessage {
  source: GatewaySource;
  externalId: string;
  text: string;
}

export interface Gateway {
  readonly source: GatewaySource;
  /** Start listening for messages. Call onMessage for each one received. */
  start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void>;
  /** Send a message back to a user */
  send(msg: OutgoingMessage): Promise<void>;
  /** Graceful shutdown */
  stop(): Promise<void>;
}
