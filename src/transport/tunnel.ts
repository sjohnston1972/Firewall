/**
 * Cloudflare Tunnel transport (CLAUDE.md §4.2).
 * Used when a `cloudflared` tunnel already exposes the device's mgmt endpoint.
 * Identical to Direct, except the base URL is the tunnel hostname rather than
 * the raw mgmt IP. The Worker calls a public tunnel hostname which Cloudflare
 * routes back to the on-prem device.
 */
import type { Credentials, TargetConfig } from "../types";
import type {
  Transport,
  TransportContext,
  TransportRequest,
  TransportResponse,
} from "./types";

export class TunnelTransport implements Transport {
  readonly kind: TargetConfig["transport"] = "tunnel";
  private readonly target: TargetConfig;
  private readonly creds: Credentials;

  constructor(ctx: TransportContext) {
    this.target = ctx.target;
    this.creds = ctx.creds;
  }

  private baseUrl(): string {
    const host = this.target.tunnelHostname;
    if (!host) {
      throw new Error(
        "TunnelTransport requires target.tunnelHostname (the cloudflared route)",
      );
    }
    const hasScheme = /^https?:\/\//i.test(host);
    return hasScheme ? host : `https://${host}`;
  }

  async fetch(req: TransportRequest): Promise<TransportResponse> {
    const base = this.baseUrl();
    const url = new URL(req.path, base.endsWith("/") ? base : base + "/").toString();

    // verifyTls intent is documented in DirectTransport; the tunnel terminates
    // a valid Cloudflare-managed certificate so verification is a non-issue here.
    void this.creds.verifyTls;

    const res = await fetch(url, {
      method: req.method,
      headers: req.headers ?? {},
      body: req.body ?? undefined,
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: res.status,
      headers,
      body: await res.text(),
    };
  }
}
