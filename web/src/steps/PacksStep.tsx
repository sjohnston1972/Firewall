import { useEffect, useState } from "react";
import type { StepProps } from "../App";
import { api } from "../api";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { ToggleCard } from "../components/Toggle";
import { StatusBadge } from "../components/StatusBadge";
import type { PackCategory, PolicyPack } from "../types";

/** Fallback catalogue (CLAUDE.md §7) used when the API isn't reachable — IDs and
 * names mirror the backend catalogue (src/packs/catalogue.ts). All on by default. */
const FALLBACK_PACKS: PolicyPack[] = [
  { id: "outbound-internet-baseline", name: "Outbound internet baseline", category: "connectivity", description: "Allow trust→untrust web, DNS and NTP (HTTP/HTTPS/QUIC) with logging.", enabled: true },
  { id: "microsoft-365", name: "Microsoft 365 / Teams", category: "connectivity", description: "Allow Exchange, SharePoint and Teams (signalling + media).", enabled: true },
  { id: "webex", name: "Webex", category: "connectivity", description: "Allow Webex media + signalling per Cisco's published requirements.", enabled: true },
  { id: "certificate-validation", name: "Certificate validation (OCSP/CRL)", category: "connectivity", description: "Allow outbound OCSP/CRL so certificate revocation checks succeed.", enabled: true },
  { id: "anti-spoofing-bogon", name: "Anti-spoofing / bogon filtering", category: "security", description: "Anti-spoofing + bogon filtering and drop RFC1918 egress.", enabled: true },
  { id: "geo-blocking", name: "Geo-blocking (high-risk countries)", category: "security", description: "Block inbound from high-risk source countries.", enabled: true },
  { id: "rogue-doh-control", name: "Rogue DoH control", category: "security", description: "Block unsanctioned DNS-over-HTTPS/TLS to public resolvers.", enabled: true },
  { id: "firewall-cloud-services", name: "Firewall cloud-services allow", category: "security", description: "Reach WildFire / FortiGuard / Talos update clouds.", enabled: true },
  { id: "logging-siem-egress", name: "Logging / SIEM egress", category: "security", description: "Allow syslog to a defined collector (UDP 514 / TLS 6514).", enabled: true },
  { id: "site-to-site-vpn-baseline", name: "Site-to-site VPN baseline", category: "access", description: "IKEv2 IPSec tunnel skeleton with strong crypto defaults.", enabled: true },
  { id: "remote-access-vpn-baseline", name: "Remote-access VPN baseline", category: "access", description: "GlobalProtect gateway + portal skeleton.", enabled: true },
  { id: "guest-dmz-isolation", name: "Guest / DMZ isolation", category: "access", description: "Segment guest/DMZ with no lateral access to trust.", enabled: true },
  { id: "mgmt-plane-lockdown", name: "Management plane lockdown", category: "management", description: "Restrict admin to named subnets; HTTPS/SSH only; no Telnet/HTTP.", enabled: true },
];

/** Rich hover detail per pack — what it deploys + any placeholders/follow-ups. */
const PACK_DETAIL: Record<string, string> = {
  "outbound-internet-baseline": "Adds an allow rule from trust to untrust for web-browsing, SSL, QUIC, DNS and NTP, all logged. The baseline that lets internal users reach the internet.",
  "microsoft-365": "Allows the Microsoft 365 App-IDs (Exchange Online, SharePoint, Teams) including Teams media UDP 3478–3481. Built from Microsoft's published endpoint categories.",
  webex: "Allows Webex signalling and media per Cisco's published network requirements so meetings connect with good media quality.",
  "certificate-validation": "Permits outbound OCSP and CRL fetches (HTTP/HTTPS) so TLS certificate revocation checks don't fail closed.",
  "anti-spoofing-bogon": "Enables zone-protection anti-spoofing and drops bogon/RFC1918 source addresses leaving the WAN — basic egress hygiene.",
  "geo-blocking": "Drops inbound connections sourced from a set of high-risk countries (matched by ISO country code on the untrust zone).",
  "rogue-doh-control": "Blocks DNS-over-HTTPS / DNS-over-TLS to well-known public resolvers so clients can't bypass your DNS policy.",
  "firewall-cloud-services": "Allows the firewall to reach its own threat-intel and update clouds (PAN WildFire, FortiGuard, Cisco Talos) so signatures stay current.",
  "logging-siem-egress": "Allows syslog egress to a SIEM collector (UDP 514 / TLS 6514). PLACEHOLDER collector host — set your real SIEM address.",
  "site-to-site-vpn-baseline": "Deploys IKE + IPSec crypto profiles, an IKE gateway and an IPSec tunnel with strong IKEv2 defaults. PLACEHOLDER peer + PSK — replace per site.",
  "remote-access-vpn-baseline": "Deploys a GlobalProtect gateway + portal, an SSL/TLS service profile and local-database auth. PLACEHOLDER self-signed cert + sample user — replace with a real cert and authentication.",
  "guest-dmz-isolation": "Adds deny rules so guest and DMZ zones cannot initiate into trust (lateral-movement containment).",
  "mgmt-plane-lockdown": "Restricts the management plane to named admin subnets, forces HTTPS/SSH only, disables Telnet/HTTP and sets an admin lockout. Narrow the permitted sources to your real admin network.",
};

const CATEGORY_META: { key: PackCategory; label: string; blurb: string }[] = [
  { key: "connectivity", label: "Connectivity / productivity", blurb: "Let known-good traffic through" },
  { key: "security", label: "Security baseline", blurb: "Egress hygiene and threat-cloud reachability" },
  { key: "access", label: "Access", blurb: "VPN skeletons and segmentation" },
  { key: "management", label: "Management hardening", blurb: "Lock down the admin plane" },
];

export function PacksStep({ state, patch, onNext, onBack, step, total }: StepProps) {
  const [loading, setLoading] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);

  useEffect(() => {
    if (state.packs.length > 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        if (!state.sessionId) throw new Error("no session");
        const res = await api.packs(state.sessionId);
        // ALL packs are selected by default — the engineer opts out, not in.
        const list = (res.packs?.length ? res.packs : FALLBACK_PACKS).map((p) => ({ ...p, enabled: true }));
        if (!cancelled) patch({ packs: list });
        if (!cancelled && !res.packs?.length) setUsingFallback(true);
      } catch {
        if (!cancelled) {
          patch({ packs: FALLBACK_PACKS.map((p) => ({ ...p, enabled: true })) });
          setUsingFallback(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string, enabled: boolean) =>
    patch({ packs: state.packs.map((p) => (p.id === id ? { ...p, enabled } : p)) });

  const enabledCount = state.packs.filter((p) => p.enabled).length;

  return (
    <StepShell
      step={step}
      total={total}
      eyebrow="Boilerplate policy packs"
      title="Apply best-practice baselines"
      intro="Toggle deterministic rule packs. Each is a vetted bundle of rules; packs that depend on vendor endpoint lists (O365, Webex) pull current published ranges at build time."
      onBack={onBack}
      onNext={onNext}
      footerNote={`${enabledCount} pack${enabledCount === 1 ? "" : "s"} enabled`}
    >
      {loading && state.packs.length === 0 ? (
        <p className="text-sm text-ink-500">Loading catalogue…</p>
      ) : (
        <>
          {usingFallback && (
            <div className="flex items-center gap-2">
              <StatusBadge tone="warn" dot>
                offline catalogue
              </StatusBadge>
              <span className="text-xs text-ink-500">
                Showing the built-in pack list — backend not reachable.
              </span>
            </div>
          )}
          {CATEGORY_META.map((cat) => {
            const packs = state.packs.filter((p) => p.category === cat.key);
            if (packs.length === 0) return null;
            return (
              <Card key={cat.key}>
                <CardHeader eyebrow={cat.blurb} title={cat.label} />
                <CardBody>
                  <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                    {packs.map((p) => (
                      <ToggleCard
                        key={p.id}
                        title={p.name}
                        description={p.description}
                        detail={PACK_DETAIL[p.id]}
                        checked={p.enabled}
                        onChange={(v) => toggle(p.id, v)}
                      />
                    ))}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </>
      )}
    </StepShell>
  );
}
