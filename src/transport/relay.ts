/**
 * Relay agent transport (CLAUDE.md §4.2).
 * Used when the firewall is deep in a private network with no tunnel. A small
 * on-site agent dials *outbound* to the session's Durable Object over WSS; the
 * DO holds that socket open. This transport simply hands each request frame to
 * `ctx.relaySend`, which the DO implements by shuttling it across that link.
 *
 * The relay transport itself performs no `fetch`: it has no direct reachability
 * to the device — that's the whole point of the pattern.
 */
import type { TargetConfig } from "../types";
import type {
  Transport,
  TransportContext,
  TransportRequest,
  TransportResponse,
} from "./types";

export class RelayTransport implements Transport {
  readonly kind: TargetConfig["transport"] = "relay";
  private readonly relaySend?: (req: TransportRequest) => Promise<TransportResponse>;

  constructor(ctx: TransportContext) {
    this.relaySend = ctx.relaySend;
  }

  async fetch(req: TransportRequest): Promise<TransportResponse> {
    if (!this.relaySend) {
      throw new Error(
        "RelayTransport has no relaySend handler: the session Durable Object " +
          "must supply relaySend (the WSS link to the on-site relay agent) " +
          "before any driver request can be made.",
      );
    }
    return this.relaySend(req);
  }
}
