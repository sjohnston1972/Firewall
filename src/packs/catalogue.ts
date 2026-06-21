/**
 * Policy-pack catalogue (CLAUDE.md §7) — deterministic, idempotent best-practice
 * rule packs the engineer toggles on. Each pack contributes well-formed
 * SecurityRules (and any AddressObject/ServiceObject they reference) to the IR,
 * plus, where relevant, tightens scalar settings (system.management, protection).
 *
 * DETERMINISM (CLAUDE.md §2): there is no AI here. applyPacks() merges each
 * enabled pack's contribution into the IR and is idempotent — every generated
 * rule is tagged `origin: "pack:<id>"`, and re-applying first strips the existing
 * rules whose origin matches the packs being applied, so re-running yields an
 * identical IR. A new IR object is always returned (input is never mutated) and
 * the result is parsed through the IR zod schema so defaults are applied.
 */
import {
  IR,
  type AddressObject,
  type ServiceObject,
  type SecurityRule,
  type VpnTunnel,
} from "../../schema/ir";

export interface PolicyPack {
  id: string; // kebab-case stable id
  name: string;
  description: string; // one line (shown on toggle card)
  category: "connectivity" | "security" | "access" | "management";
}

/**
 * What a pack contributes to the IR. Scalar mutators receive a draft IR and may
 * tighten system/protection in place (the draft is a private copy made by
 * applyPacks). Object/rule arrays are merged + deduped by name.
 */
interface PackContribution {
  addresses?: AddressObject[];
  services?: ServiceObject[];
  security?: SecurityRule[];
  vpn?: VpnTunnel[];
  /** mutate scalar sections (system.management, protection). */
  scalars?: (ir: IR) => void;
}

interface PackDef extends PolicyPack {
  build(): PackContribution;
}

// ---------- reusable service objects ----------
const svc = (name: string, protocol: ServiceObject["protocol"], ports: number[]): ServiceObject => ({
  name,
  protocol,
  ports,
});

const SVC_HTTP = svc("svc-http", "tcp", [80]);
const SVC_HTTPS = svc("svc-https", "tcp", [443]);
const SVC_QUIC = svc("svc-quic", "udp", [443]);
const SVC_DNS_UDP = svc("svc-dns-udp", "udp", [53]);
const SVC_DNS_TCP = svc("svc-dns-tcp", "tcp", [53]);
const SVC_NTP = svc("svc-ntp", "udp", [123]);
const SVC_DOT = svc("svc-dns-over-tls", "tcp", [853]);
const SVC_SYSLOG_UDP = svc("svc-syslog-udp", "udp", [514]);
const SVC_SYSLOG_TCP = svc("svc-syslog-tcp", "tcp", [6514]);
const SVC_OCSP = SVC_HTTP; // OCSP/CRL ride over HTTP

// High-risk source countries (ISO-3166 alpha-2). Firewalls match geo by country
// code directly in the rule source — verified accepted by PAN-OS.
const GEO_HIGH_RISK = ["KP", "RU", "IR", "SY", "CU"];

// well-known public DoH resolver endpoints (sample set; real builds refresh).
const DOH_PROVIDERS: AddressObject[] = [
  { name: "doh-cloudflare", value: "1.1.1.1", kind: "host" },
  { name: "doh-google", value: "8.8.8.8", kind: "host" },
  { name: "doh-quad9", value: "9.9.9.9", kind: "host" },
];

// ---------- pack definitions ----------
const PACK_DEFS: PackDef[] = [
  // ===================== CONNECTIVITY =====================
  {
    id: "outbound-internet-baseline",
    name: "Outbound internet baseline",
    description: "Allow trust→untrust web, DNS and NTP (HTTP/HTTPS/QUIC) with logging.",
    category: "connectivity",
    build: () => ({
      services: [SVC_HTTP, SVC_HTTPS, SVC_QUIC, SVC_DNS_UDP, SVC_DNS_TCP, SVC_NTP],
      security: [
        {
          name: "outbound-web",
          action: "allow",
          sourceZones: ["trust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: ["any"],
          services: ["svc-http", "svc-https", "svc-quic"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Outbound web (HTTP/HTTPS/QUIC).",
        },
        {
          name: "outbound-dns",
          action: "allow",
          sourceZones: ["trust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: ["any"],
          services: ["svc-dns-udp", "svc-dns-tcp"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Outbound DNS resolution.",
        },
        {
          name: "outbound-ntp",
          action: "allow",
          sourceZones: ["trust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: ["any"],
          services: ["svc-ntp"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Outbound NTP time sync.",
        },
      ],
    }),
  },
  {
    id: "microsoft-365",
    name: "Microsoft 365 / Teams",
    description: "Allow Exchange, SharePoint and Teams (signalling + media UDP 3478-3481).",
    category: "connectivity",
    build: () => ({
      // NOTE: placeholder FQDN address objects. Real builds pull Microsoft's
      // published O365 IP/URL endpoints API at build time (CLAUDE.md §7).
      addresses: [
        { name: "o365-exchange", value: "outlook.office365.com", kind: "fqdn" },
        { name: "o365-sharepoint", value: "sharepoint.com", kind: "fqdn" },
        { name: "o365-teams", value: "teams.microsoft.com", kind: "fqdn" },
      ],
      services: [SVC_HTTPS, svc("svc-teams-media", "udp", [3478, 3479, 3480, 3481])],
      security: [
        {
          name: "m365-web",
          action: "allow",
          sourceZones: ["trust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: ["o365-exchange", "o365-sharepoint", "o365-teams"],
          services: ["svc-https"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Microsoft 365 web (Exchange/SharePoint/Teams).",
        },
        {
          name: "m365-teams-media",
          action: "allow",
          sourceZones: ["trust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: ["o365-teams"],
          services: ["svc-teams-media"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Teams real-time media (UDP 3478-3481).",
        },
      ],
    }),
  },
  {
    id: "webex",
    name: "Webex",
    description: "Allow Webex media + signalling per Cisco's published requirements.",
    category: "connectivity",
    build: () => ({
      // Placeholder; real builds pull Cisco's published Webex network reqs.
      addresses: [{ name: "webex-cloud", value: "webex.com", kind: "fqdn" }],
      services: [SVC_HTTPS, svc("svc-webex-media", "udp", [9000])],
      security: [
        {
          name: "webex-traffic",
          action: "allow",
          sourceZones: ["trust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: ["webex-cloud"],
          services: ["svc-https", "svc-webex-media"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Webex signalling (TCP 443) + media (UDP 9000).",
        },
      ],
    }),
  },
  {
    id: "certificate-validation",
    name: "Certificate validation (OCSP/CRL)",
    description: "Allow outbound OCSP/CRL so certificate revocation checks succeed.",
    category: "connectivity",
    build: () => ({
      services: [SVC_OCSP, SVC_HTTP],
      security: [
        {
          name: "ocsp-crl",
          action: "allow",
          sourceZones: ["trust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: ["any"],
          services: ["svc-http"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "OCSP/CRL revocation checks (HTTP).",
        },
      ],
    }),
  },

  // ===================== SECURITY =====================
  {
    id: "anti-spoofing-bogon",
    name: "Anti-spoofing / bogon filtering",
    description: "Enable anti-spoofing + bogon filtering and drop RFC1918 egress.",
    category: "security",
    build: () => ({
      addresses: [
        { name: "rfc1918-10", value: "10.0.0.0/8", kind: "subnet" },
        { name: "rfc1918-172", value: "172.16.0.0/12", kind: "subnet" },
        { name: "rfc1918-192", value: "192.168.0.0/16", kind: "subnet" },
      ],
      security: [
        {
          name: "deny-rfc1918-egress",
          action: "deny",
          sourceZones: ["trust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: ["rfc1918-10", "rfc1918-172", "rfc1918-192"],
          services: ["any"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Block private (RFC1918) destinations leaking to the internet.",
        },
      ],
      scalars: (ir) => {
        ir.protection.antiSpoofing = true;
        ir.protection.bogonFiltering = true;
        ir.protection.rfc1918EgressFilter = true;
      },
    }),
  },
  {
    id: "geo-blocking",
    name: "Geo-blocking (high-risk countries)",
    description: "Block inbound traffic from a sample set of high-risk source countries.",
    category: "security",
    build: () => ({
      security: [
        {
          name: "geo-block-inbound",
          action: "drop",
          sourceZones: ["untrust"],
          destZones: ["trust", "dmz"],
          // Vendor firewalls match geo by ISO-3166 country code directly in the
          // source field (verified accepted by PAN-OS). Not a placeholder string.
          sources: GEO_HIGH_RISK,
          destinations: ["any"],
          services: ["any"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Drop inbound from high-risk source countries.",
        },
      ],
      scalars: (ir) => {
        ir.protection.geoBlock = GEO_HIGH_RISK;
      },
    }),
  },
  {
    id: "rogue-doh-control",
    name: "Rogue DoH control",
    description: "Block unsanctioned DNS-over-HTTPS/TLS to known public resolvers.",
    category: "security",
    build: () => ({
      addresses: DOH_PROVIDERS,
      services: [SVC_HTTPS, SVC_DOT],
      security: [
        {
          name: "block-rogue-doh",
          action: "deny",
          sourceZones: ["trust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: DOH_PROVIDERS.map((p) => p.name),
          services: ["svc-https", "svc-dns-over-tls"],
          applications: ["dns-over-https", "dns-over-tls"],
          log: true,
          disabled: false,
          profiles: [],
          description: "Block direct DoH/DoT to public resolvers (force internal DNS).",
        },
      ],
    }),
  },
  {
    id: "firewall-cloud-services",
    name: "Firewall cloud-services allow",
    description: "Let the device reach its own threat/update clouds (WildFire/FortiGuard/Talos).",
    category: "security",
    build: () => ({
      addresses: [
        { name: "fw-threat-cloud", value: "updates.example-vendor.net", kind: "fqdn" },
      ],
      services: [SVC_HTTPS],
      security: [
        {
          name: "fw-cloud-services",
          action: "allow",
          sourceZones: ["trust", "untrust"],
          destZones: ["untrust"],
          sources: ["any"],
          destinations: ["fw-threat-cloud"],
          services: ["svc-https"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Allow firewall to reach its threat/update cloud services.",
        },
      ],
    }),
  },
  {
    id: "logging-siem-egress",
    name: "Logging / SIEM egress",
    description: "Allow syslog to a defined collector (UDP 514 / TLS 6514) with logging.",
    category: "security",
    build: () => ({
      addresses: [{ name: "siem-collector", value: "10.10.10.10", kind: "host" }],
      services: [SVC_SYSLOG_UDP, SVC_SYSLOG_TCP],
      security: [
        {
          name: "syslog-egress",
          action: "allow",
          sourceZones: ["trust"],
          destZones: ["trust"],
          sources: ["any"],
          destinations: ["siem-collector"],
          services: ["svc-syslog-udp", "svc-syslog-tcp"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Syslog egress to the SIEM/log collector.",
        },
      ],
    }),
  },

  // ===================== ACCESS =====================
  {
    id: "site-to-site-vpn-baseline",
    name: "Site-to-site VPN baseline",
    description: "Skeleton site-to-site tunnel with strong IKEv2 crypto defaults.",
    category: "access",
    build: () => ({
      vpn: [
        {
          name: "s2s-baseline",
          kind: "site-to-site",
          localSubnets: [],
          remoteSubnets: [],
          ikeVersion: "ikev2",
          phase1: {
            encryption: ["aes-256-gcm"],
            hash: ["sha384"],
            dhGroup: ["20"],
            lifetimeSeconds: 28800,
          },
          phase2: {
            encryption: ["aes-256-gcm"],
            hash: ["sha384"],
            dhGroup: ["20"],
            lifetimeSeconds: 3600,
          },
          // PSK is never stored in the IR — reference only (CLAUDE.md §12).
          pskRef: "s2s-baseline-psk",
          description: "Named site-to-site tunnel skeleton; fill peer + subnets.",
        },
      ],
    }),
  },
  {
    id: "remote-access-vpn-baseline",
    name: "Remote-access VPN baseline",
    description: "GlobalProtect/FortiClient/AnyConnect skeleton with strong crypto.",
    category: "access",
    build: () => ({
      vpn: [
        {
          name: "ra-baseline",
          kind: "remote-access",
          localSubnets: [],
          remoteSubnets: [],
          ikeVersion: "ikev2",
          phase1: {
            encryption: ["aes-256-gcm"],
            hash: ["sha384"],
            dhGroup: ["20"],
            lifetimeSeconds: 28800,
          },
          phase2: {
            encryption: ["aes-256-gcm"],
            hash: ["sha384"],
            dhGroup: ["20"],
            lifetimeSeconds: 3600,
          },
          pskRef: "ra-baseline-psk",
          description: "Remote-access VPN skeleton (client gateway).",
        },
      ],
    }),
  },
  {
    id: "guest-dmz-isolation",
    name: "Guest / DMZ isolation",
    description: "Segment guest/DMZ so they cannot move laterally into trust.",
    category: "access",
    build: () => ({
      security: [
        {
          name: "guest-deny-to-trust",
          action: "deny",
          sourceZones: ["guest"],
          destZones: ["trust"],
          sources: ["any"],
          destinations: ["any"],
          services: ["any"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Block guest network from reaching the trust zone.",
        },
        {
          name: "dmz-deny-to-trust",
          action: "deny",
          sourceZones: ["dmz"],
          destZones: ["trust"],
          sources: ["any"],
          destinations: ["any"],
          services: ["any"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Block DMZ from initiating into the trust zone.",
        },
      ],
    }),
  },

  // ===================== MANAGEMENT =====================
  {
    id: "mgmt-plane-lockdown",
    name: "Management plane lockdown",
    description: "Restrict admin to named subnets, HTTPS/SSH only, disable Telnet/HTTP.",
    category: "management",
    build: () => ({
      security: [
        {
          name: "mgmt-deny-untrust",
          action: "drop",
          sourceZones: ["untrust"],
          destZones: ["trust"],
          sources: ["any"],
          destinations: ["any"],
          services: ["svc-mgmt-https", "svc-mgmt-ssh"],
          applications: [],
          log: true,
          disabled: false,
          profiles: [],
          description: "Drop management protocols arriving from untrust.",
        },
      ],
      services: [svc("svc-mgmt-https", "tcp", [443]), svc("svc-mgmt-ssh", "tcp", [22])],
      scalars: (ir) => {
        const mgmt = ir.system.management;
        mgmt.https = true;
        mgmt.ssh = true;
        mgmt.telnet = false;
        mgmt.httpPlain = false;
        mgmt.lockoutThreshold = mgmt.lockoutThreshold > 0 ? mgmt.lockoutThreshold : 5;
        // Default to RFC1918 admin subnets if none configured yet.
        if (mgmt.allowedSources.length === 0) {
          mgmt.allowedSources = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
        }
      },
    }),
  },
];

/** Public catalogue (CLAUDE.md §7) — the toggle cards shown in the GUI. */
export const PACKS: PolicyPack[] = PACK_DEFS.map((p) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  category: p.category,
}));

/** Merge by `name`, later entries win, stable insertion order preserved. */
function mergeByName<T extends { name: string }>(existing: T[], incoming: T[]): T[] {
  const out: T[] = [];
  const index = new Map<string, number>();
  for (const item of [...existing, ...incoming]) {
    const at = index.get(item.name);
    if (at === undefined) {
      index.set(item.name, out.length);
      out.push(item);
    } else {
      out[at] = item; // later source wins, keeps original position
    }
  }
  return out;
}

/**
 * Apply the enabled packs to the IR deterministically and idempotently.
 * Returns a NEW IR (input untouched), parsed through the IR schema so defaults
 * are applied. Unknown pack ids are ignored.
 */
export function applyPacks(ir: IR, enabledIds: string[]): IR {
  // Stable, de-duplicated list of the packs we actually know about. Iterating
  // PACK_DEFS (not enabledIds) makes ordering deterministic regardless of the
  // order the caller passes ids in.
  const ordered = PACK_DEFS.filter((p) => enabledIds.includes(p.id));

  // Deep copy via schema parse so we never mutate the caller's IR.
  const draft: IR = IR.parse(structuredClone(ir));

  // Idempotency + correctness: strip ALL rules previously emitted by any pack,
  // then re-add only the currently-enabled ones. So disabling a pack removes its
  // rules, and re-applying the same set yields an identical IR.
  draft.security = draft.security.filter(
    (r) => !(r.origin !== undefined && r.origin.startsWith("pack:")),
  );

  for (const pack of ordered) {
    const c = pack.build();
    if (c.addresses) draft.addresses = mergeByName(draft.addresses, c.addresses);
    if (c.services) draft.services = mergeByName(draft.services, c.services);
    if (c.vpn) draft.vpn = mergeByName(draft.vpn, c.vpn);
    if (c.security) {
      const tagged = c.security.map((r) => ({ ...r, origin: `pack:${pack.id}` }));
      draft.security = mergeByName(draft.security, tagged);
    }
    c.scalars?.(draft);
  }

  // Re-parse so any added objects pick up schema defaults and stay canonical.
  return IR.parse(draft);
}
