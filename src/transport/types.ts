/**
 * Transport layer (CLAUDE.md §4.2). A Worker can't dial a private mgmt IP, so
 * reachability is pluggable. A Transport is just an HTTP client the driver uses;
 * the driver never knows whether bytes go direct, via a CF Tunnel hostname, or
 * across a relay agent's outbound WebSocket.
 */
import type { Credentials, TargetConfig } from "../types";

export interface TransportRequest {
  method: string;
  /** path + query, relative to the device base, e.g. "/api/?type=op&cmd=..." */
  path: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | null;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  readonly kind: TargetConfig["transport"];
  fetch(req: TransportRequest): Promise<TransportResponse>;
}

/** Envelope sent to the cloud-proxy container (full target URL + request). */
export interface ContainerProxyRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | null;
}

export interface TransportContext {
  target: TargetConfig;
  creds: Credentials;
  /** For relay transport: send a request frame across the DO-held WSS link. */
  relaySend?: (req: TransportRequest) => Promise<TransportResponse>;
  /** For container transport: forward a request via the per-session container. */
  containerSend?: (req: ContainerProxyRequest) => Promise<TransportResponse>;
}
