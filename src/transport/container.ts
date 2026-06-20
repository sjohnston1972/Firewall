/**
 * Container transport (CLAUDE.md §4.2 — "Cloud proxy").
 * Routes device API calls through a per-session Cloudflare Container that CAN
 * disable TLS verification, so the Worker can reach firewalls with self-signed
 * management certificates without an on-site agent. Target must be reachable
 * from Cloudflare's network (public mgmt IP).
 */
import type { Credentials, TargetConfig } from "../types";
import type {
  ContainerProxyRequest,
  Transport,
  TransportContext,
  TransportRequest,
  TransportResponse,
} from "./types";

export class ContainerTransport implements Transport {
  readonly kind: TargetConfig["transport"] = "container";
  private readonly creds: Credentials;
  private readonly send?: (req: ContainerProxyRequest) => Promise<TransportResponse>;

  constructor(ctx: TransportContext) {
    this.creds = ctx.creds;
    this.send = ctx.containerSend;
  }

  private baseUrl(): string {
    const host = this.creds.host;
    if (!host) throw new Error("Cloud proxy requires creds.host (mgmt IP/hostname)");
    const hasScheme = /^https?:\/\//i.test(host);
    const authority = this.creds.port ? `${host}:${this.creds.port}` : host;
    return hasScheme ? host : `https://${authority}`;
  }

  async fetch(req: TransportRequest): Promise<TransportResponse> {
    if (!this.send) {
      throw new Error("Cloud proxy transport not available (no container binding)");
    }
    const base = this.baseUrl();
    const url = new URL(req.path, base.endsWith("/") ? base : base + "/").toString();
    return this.send({ method: req.method, url, headers: req.headers, body: req.body ?? null });
  }
}
