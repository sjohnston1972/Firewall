import type { StepProps } from "../App";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { ToggleCard } from "../components/Toggle";
import type { NgfwSettings, ProtectionSettings } from "../types";

const NGFW_FIELDS: { key: keyof NgfwSettings; title: string; desc: string; tag?: string }[] = [
  { key: "ips", title: "IPS / IDS", desc: "Intrusion prevention with best-practice signature set.", tag: "recommended" },
  { key: "antiMalware", title: "Anti-malware", desc: "Inline anti-virus and file-based malware blocking.", tag: "recommended" },
  { key: "sandboxing", title: "Sandboxing", desc: "Detonate unknown files (WildFire / FortiSandbox / Threat Grid)." },
  { key: "urlFiltering", title: "URL filtering", desc: "Category-based web filtering with safe-search.", tag: "recommended" },
  { key: "dnsSecurity", title: "DNS security", desc: "Block known-malicious and DGA domains at resolution.", tag: "recommended" },
  { key: "tlsDecryption", title: "TLS decryption", desc: "Inspect encrypted traffic. Requires a trusted CA on endpoints.", tag: "advanced" },
];

const PROTECTION_FIELDS: {
  key: keyof ProtectionSettings;
  title: string;
  desc: string;
}[] = [
  { key: "floodProtection", title: "Flood protection", desc: "SYN/UDP/ICMP flood thresholds per zone." },
  { key: "reconProtection", title: "Reconnaissance protection", desc: "Detect and block port and host sweeps." },
  { key: "packetBasedAttackProtection", title: "Packet-based attack protection", desc: "Drop malformed and spoofed packets." },
  { key: "antiSpoofing", title: "Anti-spoofing", desc: "Reverse-path checks on ingress interfaces." },
  { key: "bogonFiltering", title: "Bogon filtering", desc: "Drop unallocated and martian source ranges." },
  { key: "rfc1918EgressFilter", title: "RFC1918 egress filter", desc: "Prevent private ranges leaking to the internet." },
];

export function NgfwStep({ state, patch, onNext, onBack, step, total }: StepProps) {
  const setNgfw = (key: keyof NgfwSettings, v: boolean) =>
    patch({ ngfw: { ...state.ngfw, [key]: v } });
  const setProt = (key: keyof ProtectionSettings, v: boolean) =>
    patch({ protection: { ...state.protection, [key]: v } });

  return (
    <StepShell
      step={step}
      total={total}
      eyebrow="Next-gen & hardening"
      title="Inspection and zone protection"
      intro="Turn on deterministic best-practice security profiles and management-plane hardening. These attach to the security rules built from your packs and imports."
      onBack={onBack}
      onNext={onNext}
    >
      <Card>
        <CardHeader
          eyebrow="Security profiles"
          title="Next-gen inspection"
          description="Applied as a named NGFW profile per vendor."
        />
        <CardBody>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {NGFW_FIELDS.map((f) => (
              <ToggleCard
                key={f.key}
                title={f.title}
                description={f.desc}
                tag={f.tag}
                checked={state.ngfw[f.key]}
                onChange={(v) => setNgfw(f.key, v)}
              />
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Zone protection / hardening"
          title="Protect the device and zones"
          description="Flood, recon and packet-based attack protection, plus egress hygiene."
        />
        <CardBody>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {PROTECTION_FIELDS.map((f) => (
              <ToggleCard
                key={f.key}
                title={f.title}
                description={f.desc}
                checked={state.protection[f.key]}
                onChange={(v) => setProt(f.key, v)}
              />
            ))}
          </div>
        </CardBody>
      </Card>
    </StepShell>
  );
}
