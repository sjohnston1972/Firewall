/**
 * Bastion Intermediate Representation (IR)
 * ----------------------------------------
 * The single vendor-neutral description of the *desired* firewall state.
 * Everything funnels through this:
 *   - the GUI builds IR
 *   - the AI normaliser emits IR *fragments* (imports only)
 *   - each driver's render() turns IR into vendor-native config deterministically
 *
 * This file is the single source of truth (CLAUDE.md §15). It is defined with
 * Zod so we get both a runtime validator AND static TypeScript types. A static
 * JSON Schema mirror lives in schema/ir.json for documentation / external tools.
 */
import { z } from "zod";

export const IR_VERSION = "1.0.0" as const;

// ---------- primitives ----------
const ipv4 = z
  .string()
  .regex(
    /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/,
    "must be a dotted-quad IPv4 address",
  );

const cidr = z
  .string()
  .regex(
    /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(3[0-2]|[12]?\d)$/,
    "must be IPv4 CIDR (e.g. 10.0.0.0/24)",
  );

const hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9._-]+$/, "invalid hostname/identifier");

const name = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[A-Za-z0-9_.\-/ ]+$/,
    "name may contain letters, digits, _.-/ and spaces",
  );

const port = z.number().int().min(0).max(65535);

export const Protocol = z.enum(["tcp", "udp", "icmp", "ip", "any"]);
export type Protocol = z.infer<typeof Protocol>;

// ---------- interfaces ----------
export const Interface = z.object({
  name: name, // logical name, e.g. "ethernet1/1" / "port1" / "GigabitEthernet0/0"
  enabled: z.boolean().default(true),
  description: z.string().max(255).optional(),
  zone: name.optional(),
  addressing: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("dhcp") }),
      z.object({ mode: z.literal("static"), address: cidr }),
      z.object({ mode: z.literal("none") }),
    ])
    .default({ mode: "none" }),
  mtu: z.number().int().min(576).max(9216).optional(),
  /** LACP: this ethernet is a member of the named aggregate (ae<n>). */
  aggregateGroup: name.optional(),
  /** DHCP server handed out on this interface's subnet (interface must be static). */
  dhcpServer: z
    .object({
      poolStart: ipv4,
      poolEnd: ipv4,
      gateway: ipv4.optional(),
      dns: z.array(ipv4).default([]),
    })
    .optional(),
});
export type Interface = z.infer<typeof Interface>;

// ---------- zones ----------
export const ZoneType = z.enum(["trust", "untrust", "dmz", "guest", "custom"]);
export type ZoneType = z.infer<typeof ZoneType>;

export const Zone = z.object({
  name: name,
  type: ZoneType.default("custom"),
  interfaces: z.array(name).default([]),
  description: z.string().max(255).optional(),
});
export type Zone = z.infer<typeof Zone>;

// ---------- system (dns/ntp/mgmt) ----------
export const Management = z.object({
  // Sources permitted to reach the management plane (hardening §5.9).
  allowedSources: z.array(cidr).default([]),
  https: z.boolean().default(true),
  ssh: z.boolean().default(true),
  telnet: z.boolean().default(false),
  httpPlain: z.boolean().default(false),
  lockoutThreshold: z.number().int().min(0).max(20).default(5),
});
export type Management = z.infer<typeof Management>;

export const System = z.object({
  hostname: hostname.optional(),
  dns: z.array(ipv4).max(4).default([]),
  ntp: z.array(hostname).max(4).default([]),
  timezone: z.string().max(64).optional(),
  management: Management.default({}),
});
export type System = z.infer<typeof System>;

// ---------- address / service objects ----------
export const AddressObject = z.object({
  name: name,
  value: z.union([ipv4, cidr, hostname]),
  kind: z.enum(["host", "subnet", "fqdn"]).default("subnet"),
  // coloured administrative tags (zone names or custom keywords)
  tags: z.array(name).optional(),
});
export type AddressObject = z.infer<typeof AddressObject>;

export const ServiceObject = z.object({
  name: name,
  protocol: Protocol,
  ports: z.array(port).default([]), // empty for icmp/ip/any
  portRange: z.tuple([port, port]).optional(),
});
export type ServiceObject = z.infer<typeof ServiceObject>;

// ---------- NAT ----------
export const NatRule = z.object({
  name: name,
  type: z.enum(["source", "destination", "static"]),
  sourceZone: name.optional(),
  destZone: name.optional(),
  originalSource: z.array(z.string()).default([]), // address-object names or literals
  originalDest: z.array(z.string()).default([]),
  service: z.string().optional(), // service-object name or literal
  translatedSource: z.string().optional(),
  translatedDest: z.string().optional(),
  translatedPort: port.optional(),
  bidirectional: z.boolean().default(false),
  disabled: z.boolean().default(false),
  description: z.string().max(255).optional(),
});
export type NatRule = z.infer<typeof NatRule>;

// ---------- security / ACL rules ----------
export const RuleAction = z.enum(["allow", "deny", "drop", "reject"]);
export type RuleAction = z.infer<typeof RuleAction>;

export const SecurityRule = z.object({
  name: name,
  action: RuleAction.default("allow"),
  sourceZones: z.array(name).default([]),
  destZones: z.array(name).default([]),
  sources: z.array(z.string()).default(["any"]), // object names or literals
  destinations: z.array(z.string()).default(["any"]),
  services: z.array(z.string()).default(["any"]),
  applications: z.array(z.string()).default([]), // L7 app-ids where supported
  log: z.boolean().default(true),
  disabled: z.boolean().default(false),
  // attach NGFW profiles (see ngfw) by name
  profiles: z.array(z.string()).default([]),
  // coloured administrative tags (custom keywords); zone tags are auto-added
  tags: z.array(name).optional(),
  description: z.string().max(255).optional(),
  // provenance: which policy pack / import produced this rule
  origin: z.string().optional(),
});
export type SecurityRule = z.infer<typeof SecurityRule>;

// ---------- VPN ----------
export const IkeProposal = z.object({
  encryption: z.array(z.enum(["aes-128", "aes-256", "aes-256-gcm", "3des"])).default(["aes-256"]),
  hash: z.array(z.enum(["sha1", "sha256", "sha384", "sha512"])).default(["sha256"]),
  dhGroup: z.array(z.enum(["2", "5", "14", "19", "20", "21"])).default(["14"]),
  lifetimeSeconds: z.number().int().min(600).max(86400).default(28800),
});

export const VpnTunnel = z.object({
  name: name,
  kind: z.enum(["site-to-site", "remote-access"]),
  peerAddress: z.union([ipv4, hostname]).optional(),
  localSubnets: z.array(cidr).default([]),
  remoteSubnets: z.array(cidr).default([]),
  ikeVersion: z.enum(["ikev1", "ikev2"]).default("ikev2"),
   phase1: IkeProposal.default({}),
  phase2: IkeProposal.default({}),
  // PSK is NEVER stored in the IR/plan in plaintext — only a reference id.
  pskRef: z.string().optional(),
  // remote-access (GlobalProtect): address pool handed to VPN clients.
  clientIpPool: z.string().optional(),
  description: z.string().max(255).optional(),
});
export type VpnTunnel = z.infer<typeof VpnTunnel>;

// ---------- static routes ----------
export const StaticRoute = z.object({
  name: name,
  destination: cidr, // e.g. 172.16.12.1/32
  nexthop: z.union([ipv4, hostname]).optional(), // gateway IP
  interface: name.optional(),
  metric: z.number().int().min(1).max(65535).optional(),
  description: z.string().max(255).optional(),
});
export type StaticRoute = z.infer<typeof StaticRoute>;

// ---------- NGFW profiles ----------
export const NgfwProfile = z.object({
  name: name,
  ips: z.boolean().default(false),
  antiMalware: z.boolean().default(false),
  urlFiltering: z.boolean().default(false),
  dnsSecurity: z.boolean().default(false),
  tlsDecryption: z.boolean().default(false),
  sandboxing: z.boolean().default(false),
  description: z.string().max(255).optional(),
});
export type NgfwProfile = z.infer<typeof NgfwProfile>;

// ---------- zone protection / hardening ----------
export const Protection = z.object({
  floodProtection: z.boolean().default(true),
  reconProtection: z.boolean().default(true),
  packetBasedAttackProtection: z.boolean().default(true),
  // egress/ingress hygiene
  antiSpoofing: z.boolean().default(true),
  bogonFiltering: z.boolean().default(true),
  rfc1918EgressFilter: z.boolean().default(false),
  geoBlock: z.array(z.string().length(2)).default([]), // ISO country codes
});
export type Protection = z.infer<typeof Protection>;

// ---------- meta ----------
export const IRMeta = z.object({
  vendor: z.enum(["panos", "fortios", "ftd", "asa", "meraki"]),
  irVersion: z.literal(IR_VERSION).default(IR_VERSION),
  generatedBy: z.string().default("bastion"),
  note: z.string().optional(),
});
export type IRMeta = z.infer<typeof IRMeta>;

// ---------- the IR ----------
export const IR = z.object({
  meta: IRMeta,
  interfaces: z.array(Interface).default([]),
  zones: z.array(Zone).default([]),
  system: System.default({}),
  addresses: z.array(AddressObject).default([]),
  services: z.array(ServiceObject).default([]),
  nat: z.array(NatRule).default([]),
  security: z.array(SecurityRule).default([]),
  vpn: z.array(VpnTunnel).default([]),
  routes: z.array(StaticRoute).default([]),
  ngfw: z.array(NgfwProfile).default([]),
  protection: Protection.default({}),
});
export type IR = z.infer<typeof IR>;

/**
 * IR fragment — what the AI normaliser is allowed to emit (imports only).
 * It can only contribute NAT / ACL / VPN plus the objects they reference.
 * It can NEVER set system/protection/ngfw/interfaces/zones.
 */
export const IRFragment = z.object({
  addresses: z.array(AddressObject).default([]),
  services: z.array(ServiceObject).default([]),
  nat: z.array(NatRule).default([]),
  security: z.array(SecurityRule).default([]),
  vpn: z.array(VpnTunnel).default([]),
  routes: z.array(StaticRoute).default([]),
  // Full-build brief mode: the brief carries per-zone IP addressing + DHCP that
  // the engine applies onto the engineer's zone↔interface mapping. Each entry's
  // `name` is a ZONE name (e.g. "trust") or an interface name; `zone` may also be
  // set. Empty for ordinary NAT/ACL imports. Human-reviewed before it joins a plan.
  interfaces: z.array(Interface).default([]),
  // items the normaliser couldn't confidently convert — surfaced to the human
  warnings: z
    .array(
      z.object({
        item: z.string(),
        reason: z.string(),
        severity: z.enum(["info", "warn", "danger"]).default("warn"),
      }),
    )
    .default([]),
});
export type IRFragment = z.infer<typeof IRFragment>;

// ---------- helpers ----------
export function emptyIR(vendor: IRMeta["vendor"]): IR {
  return IR.parse({ meta: { vendor } });
}

export type IRValidation =
  | { ok: true; ir: IR }
  | { ok: false; errors: { path: string; message: string }[] };

export function validateIR(input: unknown): IRValidation {
  const result = IR.safeParse(input);
  if (result.success) return { ok: true, ir: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

export type FragmentValidation =
  | { ok: true; fragment: IRFragment }
  | { ok: false; errors: { path: string; message: string }[] };

export function validateFragment(input: unknown): FragmentValidation {
  const result = IRFragment.safeParse(input);
  if (result.success) return { ok: true, fragment: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}
