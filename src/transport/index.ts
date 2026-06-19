/**
 * Transport factory (CLAUDE.md §4.2).
 * Selects a transport implementation based on the target's chosen transport.
 *
 * Meraki note: Meraki MX is cloud-managed, so transport is irrelevant — the
 * driver talks to the Meraki Dashboard API directly with global fetch. We still
 * return a (Direct) transport so the driver contract's `transport` field is
 * always populated; the Meraki driver simply never uses it.
 */
import type { Transport, TransportContext } from "./types";
import { DirectTransport } from "./direct";
import { TunnelTransport } from "./tunnel";
import { RelayTransport } from "./relay";

export { DirectTransport } from "./direct";
export { TunnelTransport } from "./tunnel";
export { RelayTransport } from "./relay";

export function makeTransport(ctx: TransportContext): Transport {
  switch (ctx.target.transport) {
    case "direct":
      return new DirectTransport(ctx);
    case "tunnel":
      return new TunnelTransport(ctx);
    case "relay":
      return new RelayTransport(ctx);
    default: {
      // Exhaustiveness guard: if a new TransportKind is added, this errors.
      const _exhaustive: never = ctx.target.transport;
      throw new Error(`Unsupported transport: ${String(_exhaustive)}`);
    }
  }
}
