import { useEffect, useState } from "react";
import type { StepProps } from "../App";
import { api } from "../api";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { ToggleCard } from "../components/Toggle";
import { StatusBadge } from "../components/StatusBadge";
import type { PackCategory, PolicyPack } from "../types";

/** Fallback catalogue (CLAUDE.md §7) used when the API isn't reachable. */
const FALLBACK_PACKS: PolicyPack[] = [
  // connectivity
  { id: "outbound-baseline", name: "Outbound internet baseline", category: "connectivity", description: "HTTP/HTTPS/QUIC, DNS, NTP — with logging.", enabled: true },
  { id: "o365", name: "Microsoft 365 / Teams", category: "connectivity", description: "Built from Microsoft's published O365 endpoint list.", enabled: false },
  { id: "webex", name: "Webex", category: "connectivity", description: "From Cisco's published Webex media + signalling requirements.", enabled: false },
  { id: "zoom", name: "Zoom", category: "connectivity", description: "Zoom media and signalling ranges.", enabled: false },
  { id: "google-meet", name: "Google Workspace / Meet", category: "connectivity", description: "Workspace and Meet endpoints.", enabled: false },
  { id: "os-updates", name: "Software & OS updates", category: "connectivity", description: "Windows Update, Apple, common vendor update servers.", enabled: false },
  { id: "cert-validation", name: "Certificate validation", category: "connectivity", description: "OCSP / CRL access for cert checking.", enabled: true },
  // security
  { id: "anti-spoof", name: "Anti-spoofing / bogon egress", category: "security", description: "RFC1918 and bogon egress filtering.", enabled: true },
  { id: "geo-block", name: "Geo-blocking", category: "security", description: "Block high-risk source countries inbound.", enabled: false },
  { id: "rogue-doh", name: "Rogue DoH control", category: "security", description: "Block unsanctioned DNS-over-HTTPS.", enabled: false },
  { id: "cloud-services", name: "Firewall cloud-services allow", category: "security", description: "Reach WildFire / FortiGuard / Talos update clouds.", enabled: true },
  { id: "siem-egress", name: "Logging / SIEM egress", category: "security", description: "Syslog to a defined collector.", enabled: false },
  { id: "internal-services", name: "Internal services", category: "security", description: "DNS, DHCP relay, NTP, AAA/RADIUS, SNMP to defined hosts.", enabled: false },
  // access
  { id: "ra-vpn", name: "Remote-access VPN baseline", category: "access", description: "GlobalProtect / FortiClient / AnyConnect skeleton.", enabled: false },
  { id: "s2s-vpn", name: "Site-to-site VPN baseline", category: "access", description: "Strong crypto defaults, named tunnels.", enabled: false },
  { id: "guest-isolation", name: "Guest / DMZ isolation", category: "access", description: "Segment with no lateral access to trust.", enabled: false },
  // management
  { id: "mgmt-lockdown", name: "Mgmt plane lockdown", category: "management", description: "Restrict admin to named subnets; HTTPS/SSH only; no Telnet/HTTP.", enabled: true },
];

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
        if (!cancelled) patch({ packs: res.packs?.length ? res.packs : FALLBACK_PACKS });
        if (!cancelled && !res.packs?.length) setUsingFallback(true);
      } catch {
        if (!cancelled) {
          patch({ packs: FALLBACK_PACKS });
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
                  <div className="grid gap-2.5 lg:grid-cols-2">
                    {packs.map((p) => (
                      <ToggleCard
                        key={p.id}
                        title={p.name}
                        description={p.description}
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
