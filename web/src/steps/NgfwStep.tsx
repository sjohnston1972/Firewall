import type { StepProps } from "../App";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { ToggleCard } from "../components/Toggle";
import type { NgfwSettings, ProtectionSettings } from "../types";

const NGFW_FIELDS: { key: keyof NgfwSettings; title: string; desc: string; tag?: string; detail: string }[] = [
  { key: "ips", title: "IPS / IDS", desc: "Intrusion prevention with best-practice signature set.", tag: "recommended", detail: "Attaches the predefined strict Vulnerability Protection profile to every allow rule (via the bastion-ngfw profile-group). Blocks known exploits and CVEs inline." },
  { key: "antiMalware", title: "Anti-malware", desc: "Inline anti-virus and file-based malware blocking.", tag: "recommended", detail: "Attaches the predefined Antivirus profile — inline AV across HTTP/SMTP/FTP/SMB so known malware is blocked at the gateway." },
  { key: "sandboxing", title: "Sandboxing", desc: "Detonate unknown files (WildFire / FortiSandbox / Threat Grid).", tag: "recommended", detail: "Adds WildFire analysis — unknown files are uploaded and detonated; verdicts feed new signatures back to every firewall within minutes." },
  { key: "urlFiltering", title: "URL filtering", desc: "Category-based web filtering with safe-search.", tag: "recommended", detail: "Attaches the predefined URL-filtering profile — blocks malicious/inappropriate site categories and logs browsing by category." },
  { key: "dnsSecurity", title: "DNS security", desc: "Block known-malicious and DGA domains at resolution.", tag: "recommended", detail: "Adds the strict Anti-Spyware / DNS-Security profile — sinkholes C2 and DGA domains at resolution time, catching infected hosts." },
  { key: "tlsDecryption", title: "TLS decryption", desc: "Off by default — needs a forward-trust certificate.", tag: "needs cert", detail: "Inspects encrypted traffic via SSL forward-proxy. OFF by default because it requires a forward-trust CA certificate imported on the firewall and trusted on endpoints. Import the cert, then enable." },
];

const PROTECTION_FIELDS: {
  key: keyof ProtectionSettings;
  title: string;
  desc: string;
  detail: string;
}[] = [
  { key: "floodProtection", title: "Flood protection", desc: "SYN/UDP/ICMP flood thresholds per zone.", detail: "Zone-protection flood profile (bastion-zp) — SYN-cookie, UDP, ICMP, ICMPv6 and other-IP flood thresholds protect the dataplane from volumetric floods." },
  { key: "reconProtection", title: "Reconnaissance protection", desc: "Detect and block port and host sweeps.", detail: "Detects TCP/UDP port scans and host sweeps and blocks the source — slows down attackers mapping your network." },
  { key: "packetBasedAttackProtection", title: "Packet-based attack protection", desc: "Drop malformed and spoofed packets.", detail: "Drops malformed packets, spoofed/overlapping TCP segments and discards mismatched options at the zone edge." },
  { key: "antiSpoofing", title: "Anti-spoofing", desc: "Reverse-path checks on ingress interfaces.", detail: "Reverse-path-forwarding checks ensure source IPs are plausible for the ingress interface — drops spoofed source addresses." },
  { key: "bogonFiltering", title: "Bogon filtering", desc: "Drop unallocated and martian source ranges.", detail: "Drops traffic from unallocated/reserved (bogon) source ranges that should never appear on the internet." },
  { key: "rfc1918EgressFilter", title: "RFC1918 egress filter", desc: "Prevent private ranges leaking to the internet.", detail: "Blocks RFC1918 private source addresses from leaving via the WAN — stops leaks and misconfigured hosts from exposing internal addressing." },
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
                detail={f.detail}
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
                detail={f.detail}
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
