/**
 * Direct transport (CLAUDE.md §4.2).
 * Used when the device's management IP is internet-reachable: the Worker calls
 * the vendor API directly over HTTPS using the global `fetch`.
 */
import type { Credentials, TargetConfig } from "../types";
import type {
  Transport,
  TransportContext,
  TransportRequest,
  TransportResponse,
} from "./types";

export class DirectTransport implements Transport {
  readonly kind: TargetConfig["transport"] = "direct";
  private readonly creds: Credentials;

  constructor(ctx: TransportContext) {
    this.creds = ctx.creds;
  }

  /** Build the device base URL from creds.host (+ optional creds.port). */
  private baseUrl(): string {
    const host = this.creds.host;
    if (!host) {
      throw new Error("DirectTransport requires creds.host (mgmt IP/hostname)");
    }
    // If the host already carries a scheme, respect it; otherwise default HTTPS.
    const hasScheme = /^https?:\/\//i.test(host);
    const authority = this.creds.port ? `${host}:${this.creds.port}` : host;
    return hasScheme ? host : `https://${authority}`;
  }

  async fetch(req: TransportRequest): Promise<TransportResponse> {
    const base = this.baseUrl();
    // `path` is "+query" relative to the device base; URL resolves it cleanly.
    const url = new URL(req.path, base.endsWith("/") ? base : base + "/").toString();

    // NOTE: creds.verifyTls is honoured at the API level only. Cloudflare
    // Workers' fetch performs TLS verification and provides NO supported way to
    // disable certificate validation, so a `verifyTls: false` request cannot
    // actually relax verification here. We document the intent; for devices
    // with self-signed certs the recommended path is the relay agent transport.
    void this.creds.verifyTls; // referenced for intent; not enforceable here.

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
