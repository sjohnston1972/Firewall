/**
 * Wire shapes for the Bastion SPA.
 *
 * These mirror the IR (schema/ir.ts) *conceptually* — the frontend builds a
 * partial desired state (the "Design") and renders diffs the backend produces.
 * They are intentionally loose where the backend is the source of truth (e.g.
 * discovery inventory, plan diffs) so the UI degrades gracefully against a
 * backend that is still under construction.
 */

// ---------- vendor / transport ----------
export type Vendor = "panos" | "fortios" | "ftd" | "asa" | "meraki";

export interface VendorMeta {
  id: Vendor;
  label: string;
  blurb: string;
  applyModel: string;
  cloudManaged: boolean; // Meraki — hides IP/transport, shows API fields
}

export const VENDORS: VendorMeta[] = [
  {
    id: "panos",
    label: "Palo Alto",
    blurb: "PAN-OS · XML / REST API",
    applyModel: "Candidate config → commit",
    cloudManaged: false,
  },
  {
    id: "fortios",
    label: "Fortinet",
    blurb: "FortiOS · REST (cmdb)",
    applyModel: "Direct object writes",
    cloudManaged: false,
  },
  {
    id: "ftd",
    label: "Cisco FTD",
    blurb: "FMC / FDM REST",
    applyModel: "Staged deploy → push",
    cloudManaged: false,
  },
  {
    id: "asa",
    label: "Cisco ASA",
    blurb: "ASA REST · SSH fallback",
    applyModel: "running-config → startup",
    cloudManaged: false,
  },
  {
    id: "meraki",
    label: "Meraki MX",
    blurb: "Dashboard API · cloud",
    applyModel: "Direct API writes (no commit)",
    cloudManaged: true,
  },
];

export type Transport = "direct" | "tunnel" | "relay" | "container";

export interface TransportMeta {
  id: Transport;
  label: string;
  blurb: string;
}

export const TRANSPORTS: TransportMeta[] = [
  { id: "direct", label: "Direct", blurb: "Public mgmt IP with a trusted cert" },
  { id: "container", label: "Cloud proxy", blurb: "Ephemeral CF container · handles self-signed certs" },
  { id: "tunnel", label: "Cloudflare Tunnel", blurb: "cloudflared exposes the mgmt endpoint" },
  { id: "relay", label: "Relay agent", blurb: "On-site agent for private networks" },
];

// ---------- credentials / target ----------
export interface Credentials {
  // device-managed vendors
  host?: string;
  username?: string;
  password?: string;
  // meraki (cloud)
  apiKey?: string;
  orgId?: string;
  networkId?: string;
}

export interface TargetConfig {
  vendor: Vendor;
  transport: Transport;
  tunnelHostname?: string;
  relayToken?: string;
  credentials: Credentials;
}

export interface ConnInfo {
  ok: boolean;
  model?: string;
  version?: string;
  serial?: string;
  license?: string;
  haState?: string;
  message?: string;
}

// ---------- discovery ----------
export interface DiscoveredInterface {
  name: string;
  enabled: boolean;
  address?: string;
  zone?: string;
  description?: string;
  link?: "up" | "down";
  hwType?: string;
}

export interface DiscoveredZone {
  name: string;
  type?: string;
  interfaces: string[];
}

export interface DiscoveredRoute {
  destination: string;
  nexthop: string;
  iface?: string;
  metric?: number;
}

export interface DeviceInventory {
  interfaces: DiscoveredInterface[];
  zones: DiscoveredZone[];
  routes: DiscoveredRoute[];
  objectCount?: number;
  haState?: string;
  backupRef?: string; // R2 ref of the running-config backup
}

// ---------- design (partial IR the GUI builds) ----------
export interface ZoneDesign {
  name: string;
  type: "trust" | "untrust" | "dmz" | "guest" | "custom";
  interfaces: string[];
}

export type IfaceMode = "none" | "dhcp" | "static";
export interface IfaceAddr {
  mode: IfaceMode;
  address?: string; // CIDR when mode === "static"
}

export interface Design {
  hostname?: string;
  zones: ZoneDesign[];
  /** per-interface L3 addressing, keyed by interface name */
  interfaceAddrs?: Record<string, IfaceAddr>;
  dns: string[];
  ntp: string[];
  timezone?: string;
  management?: {
    allowedSources: string[];
    https: boolean;
    ssh: boolean;
    telnet: boolean;
    httpPlain: boolean;
  };
}

// ---------- imports (the only AI step) ----------
export type ImportFormat =
  | "panos-cli"
  | "fortios-cli"
  | "asa-cli"
  | "ios-acl"
  | "csv"
  | "freetext";

export interface ImportFormatMeta {
  id: ImportFormat;
  label: string;
}

export const IMPORT_FORMATS: ImportFormatMeta[] = [
  { id: "panos-cli", label: "PAN-OS set CLI" },
  { id: "fortios-cli", label: "FortiOS config" },
  { id: "asa-cli", label: "Cisco ASA CLI" },
  { id: "ios-acl", label: "IOS access-list" },
  { id: "csv", label: "CSV / spreadsheet" },
  { id: "freetext", label: "Free text" },
];

export interface ImportWarning {
  item: string;
  reason: string;
  severity: "info" | "warn" | "danger";
}

export interface ImportResult {
  id: string;
  format: ImportFormat;
  before: string; // raw source
  after: string; // pretty-printed normalised IR fragment
  warnings: ImportWarning[];
  accepted: boolean;
  model?: string; // which model normalised it (provenance)
}

// ---------- policy packs ----------
export type PackCategory = "connectivity" | "security" | "access" | "management";

export interface PolicyPack {
  id: string;
  name: string;
  category: PackCategory;
  description: string;
  enabled: boolean;
}

// ---------- ngfw / protection toggles ----------
export interface NgfwSettings {
  ips: boolean;
  antiMalware: boolean;
  sandboxing: boolean;
  urlFiltering: boolean;
  dnsSecurity: boolean;
  tlsDecryption: boolean;
}

export interface ProtectionSettings {
  floodProtection: boolean;
  reconProtection: boolean;
  packetBasedAttackProtection: boolean;
  antiSpoofing: boolean;
  bogonFiltering: boolean;
  rfc1918EgressFilter: boolean;
}

// ---------- plan / diff ----------
export type DiffOp = "add" | "modify" | "remove" | "keep";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

export interface PlanSection {
  key: string; // e.g. "security", "nat", "system"
  title: string;
  added: number;
  modified: number;
  removed: number;
  lines: DiffLine[];
}

export interface PlanDiff {
  version: number;
  sections: PlanSection[];
  totalChanges: number;
}

// ---------- validate ----------
export interface ValidationFinding {
  severity: "info" | "warn" | "error";
  message: string;
  path?: string;
}

export interface Validation {
  ok: boolean;
  findings: ValidationFinding[];
}

// ---------- apply ----------
// staged: render a downloadable bundle · push: write candidate (commit on-box) · live: write + commit
export type ApplyMode = "staged" | "push" | "live";

export interface ApplyResult {
  ok: boolean;
  mode: ApplyMode;
  bundleRef?: string; // for staged
  commitId?: string; // commit job id (live)
  committed?: boolean;
  message?: string;
  messages?: string[];
}

// ---------- verify ----------
export interface VerifyRow {
  item: string;
  expected: string;
  actual: string;
  match: boolean;
}

export interface VerifyResult {
  ok: boolean;
  rows: VerifyRow[];
}

// ---------- session ----------
export interface Session {
  id: string;
  vendor: Vendor;
  status: string;
  createdAt: string;
}

/** A saved session as shown in the "Sessions" list. */
export interface SessionSummary {
  id: string;
  name: string;
  vendor: Vendor;
  status: string;
  createdAt: string;
  updatedAt: string;
}
