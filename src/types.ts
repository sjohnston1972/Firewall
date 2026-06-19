/** Shared backend types: Worker environment bindings and common shapes. */
import type { IR } from "../schema/ir";

export interface Env {
  // Bindings (wrangler.toml)
  ASSETS: Fetcher;
  SESSION: DurableObjectNamespace;
  DB: D1Database;
  R2: R2Bucket;

  // Vars
  ALLOWED_EMAIL: string;
  NORMALISER_MODEL: string;
  NORMALISER_MODEL_HARD: string;
  ENVIRONMENT: string;

  // Secrets
  ANTHROPIC_API_KEY: string;
}

export type Vendor = IR["meta"]["vendor"];
export const VENDORS: Vendor[] = ["panos", "fortios", "ftd", "asa", "meraki"];

export type TransportKind = "direct" | "tunnel" | "relay";

/** Credentials live only in DO memory (CLAUDE.md §5/§12). */
export interface Credentials {
  // Generic device auth
  host?: string; // mgmt IP or hostname
  username?: string;
  password?: string;
  apiKey?: string;
  port?: number;
  verifyTls?: boolean;

  // Meraki-specific
  merakiApiKey?: string;
  merakiOrgId?: string;
  merakiNetworkId?: string;

  // FMC-managed FTD
  fmcDomain?: string;
}

export interface TargetConfig {
  vendor: Vendor;
  transport: TransportKind;
  // tunnel hostname or relay token, depending on transport
  tunnelHostname?: string;
  relayToken?: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
