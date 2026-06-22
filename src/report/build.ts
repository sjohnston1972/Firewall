/**
 * End-of-run summary report (CLAUDE.md §13 "Build report").
 *
 * Deterministically audits a completed run: how each part of the brief, each
 * enabled policy pack, and each NGFW/hardening feature was met; which values are
 * PLACEHOLDERS; and what needs follow-up configuration. Pure — no network, no AI.
 */
import type { IR } from "../../schema/ir";
import { PACKS } from "../packs/catalogue";

export interface ReportRow {
  item: string;
  status: "deployed" | "placeholder" | "skipped" | "follow-up";
  detail: string;
}
export interface ReportSection {
  title: string;
  rows: ReportRow[];
}
export interface RunReport {
  hostname: string;
  vendor: string;
  committed: boolean;
  generatedAt: string;
  sections: ReportSection[];
  placeholders: string[];
  followUps: string[];
}

// PLACEHOLDER / documentation ranges (RFC 5737 / 3849) — treated as placeholders.
const isPlaceholderIp = (s?: string): boolean =>
  !!s && /^(198\.51\.100\.|203\.0\.113\.|192\.0\.2\.)/.test(s);

export function buildReport(input: {
  ir: IR;
  enabledPacks: string[];
  committed: boolean;
  generatedAt: string;
}): RunReport {
  const { ir, enabledPacks, committed, generatedAt } = input;
  const placeholders: string[] = [];
  const followUps: string[] = [];
  const sections: ReportSection[] = [];

  // ---- Interfaces & addressing (brief: zones/addressing/LACP) ----
  const ifRows: ReportRow[] = [];
  for (const z of ir.zones) {
    for (const ifaceName of z.interfaces) {
      const i = ir.interfaces.find((x) => x.name === ifaceName);
      const members = ir.interfaces.filter((x) => x.aggregateGroup === ifaceName).map((x) => x.name);
      const addr =
        i?.addressing.mode === "static"
          ? i.addressing.address
          : i?.addressing.mode === "dhcp"
            ? "DHCP"
            : "no IP";
      const lacp = members.length ? ` · LACP bundle of ${members.length} ports (${members.join(", ")})` : "";
      const dhcp = i?.dhcpServer ? ` · DHCP server ${i.dhcpServer.poolStart}-${i.dhcpServer.poolEnd}` : "";
      ifRows.push({
        item: `${z.name} → ${ifaceName}`,
        status: "deployed",
        detail: `${z.type} zone, ${addr}${lacp}${dhcp}`,
      });
    }
  }
  sections.push({ title: "Zones, interfaces & addressing", rows: ifRows });

  // ---- NAT (brief: outbound/inbound NAT) ----
  sections.push({
    title: "NAT",
    rows: ir.nat.map((n) => {
      const t =
        n.type === "source"
          ? `source-NAT ${n.sourceZone}→${n.destZone} to ${n.translatedSource === "interface" ? "egress interface address" : n.translatedSource}`
          : `static/dest-NAT ${n.originalDest.join(",")} → ${n.translatedDest}${n.translatedPort ? ":" + n.translatedPort : ""}`;
      return { item: n.name, status: "deployed" as const, detail: t };
    }),
  });

  // ---- Security / segmentation (brief: outbound allow, inbound, denies, default-deny) ----
  const allow = ir.security.filter((r) => r.action === "allow").length;
  const deny = ir.security.filter((r) => r.action !== "allow").length;
  sections.push({
    title: "Security policy & segmentation",
    rows: [
      { item: "Security rules", status: "deployed", detail: `${ir.security.length} rules (${allow} allow, ${deny} deny/drop)` },
      {
        item: "NGFW inspection on allow rules",
        status: "deployed",
        detail: `profile-group "bastion-ngfw" attached to every allow rule`,
      },
      ...ir.security
        .filter((r) => r.action !== "allow")
        .map((r) => ({
          item: r.name,
          status: "deployed" as const,
          detail: `${r.action} ${r.sourceZones.join(",")}→${r.destZones.join(",")}${r.log ? " (logged)" : ""}`,
        })),
    ],
  });

  // ---- Routing (brief: print-server, default, VPN routes) ----
  sections.push({
    title: "Routing",
    rows: ir.routes.map((r) => ({
      item: r.name,
      status: "deployed" as const,
      detail: `${r.destination} via ${r.nexthop ?? r.interface ?? "?"}`,
    })),
  });

  // ---- VPN (placeholders flagged) ----
  const vpnRows: ReportRow[] = [];
  for (const v of ir.vpn) {
    if (v.kind === "site-to-site") {
      const ph = isPlaceholderIp(v.peerAddress) || !v.peerAddress;
      if (ph) {
        placeholders.push(`VPN "${v.name}": placeholder peer ${v.peerAddress ?? "(none)"} + placeholder PSK`);
        followUps.push(`VPN "${v.name}": set the real peer address and pre-shared key.`);
      }
      vpnRows.push({
        item: `${v.name} (IPSec site-to-site)`,
        status: ph ? "placeholder" : "deployed",
        detail: `IKE/IPSec crypto + IKE gateway + IPSec tunnel; peer ${v.peerAddress ?? "(unset)"}${ph ? " [PLACEHOLDER]" : ""}`,
      });
    } else {
      placeholders.push(`GlobalProtect "${v.name}": self-signed cert (bastion-gp) + local user vpnuser / BastionGP-ChangeMe1!`);
      followUps.push(`GlobalProtect "${v.name}": install a real server certificate and configure real authentication (replace the placeholder local user).`);
      vpnRows.push({
        item: `${v.name} (GlobalProtect remote-access)`,
        status: "placeholder",
        detail: `GP gateway + portal, ssl-tls profile, local-database auth [self-signed cert + placeholder user]`,
      });
    }
  }
  if (vpnRows.length) sections.push({ title: "VPN", rows: vpnRows });

  // ---- DHCP ----
  const dhcpIfaces = ir.interfaces.filter((i) => i.dhcpServer);
  if (dhcpIfaces.length) {
    sections.push({
      title: "DHCP services",
      rows: dhcpIfaces.map((i) => ({
        item: i.name,
        status: "deployed" as const,
        detail: `pool ${i.dhcpServer!.poolStart}-${i.dhcpServer!.poolEnd}, gateway ${i.dhcpServer!.gateway ?? "(iface)"}`,
      })),
    });
  }

  // ---- NGFW & hardening (wizard) ----
  const ng = ir.ngfw[0];
  const ngRows: ReportRow[] = [];
  if (ng) {
    const feat = (on: boolean | undefined, name: string, note: string) =>
      ngRows.push({ item: name, status: on ? "deployed" : "follow-up", detail: on ? note : `not enabled` });
    feat(ng.ips, "IPS / vulnerability protection", "predefined strict vulnerability profile");
    feat(ng.antiMalware, "Anti-malware / antivirus", "predefined virus profile");
    feat(ng.urlFiltering, "URL filtering", "predefined url-filtering profile");
    feat(ng.dnsSecurity, "DNS security / anti-spyware", "predefined strict anti-spyware profile");
    feat(ng.sandboxing, "Sandboxing (WildFire)", "predefined wildfire-analysis profile");
    if (!ng.tlsDecryption) {
      ngRows.push({ item: "TLS decryption", status: "follow-up", detail: "not enabled — requires a forward-trust certificate" });
      followUps.push("TLS decryption: import a forward-trust certificate, then enable it.");
    } else {
      ngRows.push({ item: "TLS decryption", status: "deployed", detail: "decryption profile applied" });
    }
  }
  const p = ir.protection;
  const pr = (on: boolean, name: string) => (on ? `${name} ✓` : null);
  const protAttrs = [
    pr(p.floodProtection, "flood"),
    pr(p.packetBasedAttackProtection, "packet-based attack"),
    pr(p.reconProtection, "reconnaissance"),
    pr(p.antiSpoofing, "anti-spoofing"),
  ].filter(Boolean);
  ngRows.push({
    item: "Zone protection",
    status: "deployed",
    detail: `profile "bastion-zp" attached to zones (${protAttrs.join(", ") || "baseline"})`,
  });
  sections.push({ title: "NGFW & hardening", rows: ngRows });

  // ---- Coloured tags (default on) ----
  const ZONE_COLOR_NAME: Record<string, string> = {
    trust: "green",
    untrust: "red",
    dmz: "orange",
    guest: "yellow",
    custom: "blue",
  };
  const tagRows: ReportRow[] = ir.zones.map((z) => ({
    item: z.name,
    status: "deployed" as const,
    detail: `zone tag — ${ZONE_COLOR_NAME[z.type] ?? "blue"}; applied to every policy that uses this zone`,
  }));
  const customTags = new Set<string>();
  for (const r of ir.security) for (const t of r.tags ?? []) customTags.add(t);
  for (const a of ir.addresses) for (const t of a.tags ?? []) customTags.add(t);
  for (const t of customTags) tagRows.push({ item: t, status: "deployed", detail: "custom keyword tag (auto-coloured)" });
  if (ir.vpn.length) tagRows.push({ item: "vpn", status: "deployed", detail: "zone tag — purple" });
  sections.push({ title: "Coloured tags", rows: tagRows });

  // ---- Policy packs ----
  sections.push({
    title: "Policy packs",
    rows: enabledPacks.map((id) => {
      const meta = PACKS.find((x) => x.id === id);
      return {
        item: meta?.name ?? id,
        status: "deployed" as const,
        detail: meta?.description ?? "applied",
      };
    }),
  });

  // Management hardening placeholder note
  if (ir.system.management?.allowedSources?.length) {
    followUps.push(
      "Management access is restricted to RFC1918 sources — narrow this to your real admin subnet(s).",
    );
  }

  return {
    hostname: ir.system.hostname ?? "(unset)",
    vendor: ir.meta.vendor,
    committed,
    generatedAt,
    sections,
    placeholders,
    followUps,
  };
}

/** Render a RunReport as Markdown. */
export function renderReportMarkdown(r: RunReport): string {
  const L: string[] = [];
  L.push(`# Bastion build report — ${r.hostname}`);
  L.push("");
  L.push(`- Vendor: ${r.vendor}`);
  L.push(`- Result: ${r.committed ? "✅ committed without errors" : "⚠️ not committed"}`);
  L.push(`- Generated: ${r.generatedAt}`);
  L.push("");
  for (const s of r.sections) {
    L.push(`## ${s.title}`);
    for (const row of s.rows) {
      const mark =
        row.status === "deployed"
          ? "✓"
          : row.status === "placeholder"
            ? "⚠ (placeholder)"
            : row.status === "skipped"
              ? "✗"
              : "→ (follow-up)";
      L.push(`- ${mark} **${row.item}** — ${row.detail}`);
    }
    L.push("");
  }
  if (r.placeholders.length) {
    L.push("## Placeholder values used");
    for (const x of r.placeholders) L.push(`- ${x}`);
    L.push("");
  }
  if (r.followUps.length) {
    L.push("## Follow-up configuration needed");
    for (const x of r.followUps) L.push(`- ${x}`);
    L.push("");
  }
  return L.join("\n");
}
