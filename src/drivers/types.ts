/**
 * Vendor driver contract (CLAUDE.md §4.3). Every platform implements this so the
 * rest of the app stays vendor-neutral. The IR→device path has ZERO AI in it.
 */
import type { IR } from "../../schema/ir";
import type { Credentials, Vendor } from "../types";
import type { Transport } from "../transport/types";

export interface ConnInfo {
  reachable: boolean;
  model?: string;
  version?: string;
  serial?: string;
  licenses?: string[];
  haState?: string;
  raw?: unknown;
}

export interface DiscoveredInterface {
  name: string;
  enabled: boolean;
  address?: string;
  zone?: string;
  description?: string;
}

export interface RouteEntry {
  destination: string;
  nexthop?: string;
  iface?: string;
  metric?: number;
}

export interface DeviceInventory {
  interfaces: DiscoveredInterface[];
  zones: { name: string; interfaces: string[] }[];
  routes: RouteEntry[];
  addressObjects: { name: string; value: string }[];
  serviceObjects: { name: string; value: string }[];
  haState?: string;
  capturedAt: string;
  raw?: unknown;
}

export interface Validation {
  ok: boolean;
  findings: { severity: "info" | "warn" | "error"; message: string }[];
}

export interface RenderedConfig {
  /** vendor-native config text/commands ready for staged download */
  format: "xml" | "cli" | "json" | "set";
  filename: string;
  content: string;
}

export interface ApplyResult {
  ok: boolean;
  committed: boolean;
  jobId?: string;
  messages: string[];
}

/** A BuildPlan is a versioned IR plus a human-readable diff summary. */
export interface BuildPlan {
  version: number;
  ir: IR;
}

export interface FirewallDriver {
  readonly vendor: Vendor;
  testConnection(): Promise<ConnInfo>;
  discover(): Promise<DeviceInventory>;
  validate(plan: BuildPlan): Promise<Validation>;
  render(plan: BuildPlan): Promise<RenderedConfig>;
  applyLive(plan: BuildPlan): Promise<ApplyResult>;
  readback(): Promise<DeviceInventory>;
}

export interface DriverContext {
  vendor: Vendor;
  creds: Credentials;
  transport: Transport;
}

export type DriverFactory = (ctx: DriverContext) => FirewallDriver;
