// Local gateway — used when running in TUI/interactive mode.
// The TUI dispatches directly via router.dispatch(); this gateway is a no-op stub
// so the router can route "local" source messages correctly.

import type { Gateway, IncomingMessage, OutgoingMessage } from "./types.ts";

export class LocalGateway implements Gateway {
  readonly source = "local" as const;

  async start(_onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    // TUI drives messages manually via router.dispatch() — no polling loop needed.
  }

  async send(_msg: OutgoingMessage): Promise<void> {
    // TUI receives output via streaming callbacks — send() is never called for local.
  }

  async stop(): Promise<void> {}
}
