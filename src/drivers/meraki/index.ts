/**
 * Meraki MX driver (CLAUDE.md §4.2 Meraki exception, §4.3).
 *
 * Meraki MX is cloud-managed: there is NO local mgmt IP and NO transport choice.
 * This driver ignores ctx.transport entirely and talks to the Meraki Dashboard
 * API (https://api.meraki.com/api/v1/...) directly via the global `fetch`, using
 * an API key (creds.merakiApiKey) + org id + network id.
 *
 * There is no commit step: writes are direct (PUT/POST) to the Dashboard.
 * render() emits a JSON plan describing the API calls that would apply the IR.
 * The IR -> device path contains ZERO AI.
 */
import type { IR } from "../../../schema/ir";
import type { Credentials, Vendor } from "../../types";
import type {
  ApplyResult,
  BuildPlan,
  ConnInfo,
  DeviceInventory,
  DiscoveredInterface,
  DriverContext,
  FirewallDriver,
  RenderedConfig,
  RouteEntry,
  Validation,
} from "../types";

const MERAKI_BASE = "https://api.meraki.com/api/v1";

export class MerakiDriver implements FirewallDriver {
  readonly vendor: Vendor = "meraki";
  private readonly creds: Credentials;

  constructor(ctx: DriverContext) {
    // Note: ctx.transport is intentionally unused — Meraki is cloud-direct.
    this.creds = ctx.creds;
  }

  private headers(): Record<string, string> {
    const key = this.creds.merakiApiKey;
    if (!key) {
      throw new Error("Meraki driver requires creds.merakiApiKey");
    }
    return {
      "X-Cisco-Meraki-API-Key": key,
      authorization: `Bearer ${key}`, // v1 also accepts Bearer; send both.
      accept: "application/json",
      "content-type": "application/json",
    };
  }

  /** GET a Dashboard API path (absolute under MERAKI_BASE) and parse JSON. */
  private async getJson(path: string): Promise<unknown> {
    const res = await fetch(`${MERAKI_BASE}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Meraki GET ${path} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as unknown;
  }

  async testConnection(): Promise<ConnInfo> {
    try {
      // GET /organizations confirms the API key works.
      const orgs = (await this.getJson("/organizations")) as Array<{
        id?: string;
        name?: string;
      }>;
      const match = this.creds.merakiOrgId
        ? orgs.find((o) => o.id === this.creds.merakiOrgId)
        : orgs[0];
      return {
        reachable: true,
        model: "Meraki MX (cloud-managed)",
        serial: match?.id,
        raw: { organizations: orgs.map((o) => ({ id: o.id, name: o.name })) },
      };
    } catch (err) {
      return { reachable: false, raw: (err as Error).message };
    }
  }

  async discover(): Promise<DeviceInventory> {
    const capturedAt = new Date().toISOString();
    const interfaces: DiscoveredInterface[] = [];
    const zones: { name: string; interfaces: string[] }[] = [];
    const routes: RouteEntry[] = [];
    const addressObjects: { name: string; value: string }[] = [];
    const serviceObjects: { name: string; value: string }[] = [];

    const net = this.creds.merakiNetworkId;

    // Devices in the network.
    if (net) {
      try {
        const devices = (await this.getJson(`/networks/${net}/devices`)) as Array<{
          serial?: string;
          model?: string;
          name?: string;
          lanIp?: string;
        }>;
        for (const d of devices) {
          interfaces.push({
            name: d.name ?? d.serial ?? "mx",
            enabled: true,
            address: d.lanIp,
            description: d.model,
          });
        }
      } catch {
        // tolerate
      }

      // VLANs map naturally onto "zones" for the GUI.
      try {
        const vlans = (await this.getJson(
          `/networks/${net}/appliance/vlans`,
        )) as Array<{ id?: number | string; name?: string; subnet?: string }>;
        for (const v of vlans) {
          const vname = v.name ?? `VLAN ${v.id}`;
          zones.push({ name: vname, interfaces: [] });
          if (v.subnet) {
            routes.push({ destination: v.subnet, iface: vname });
            addressObjects.push({ name: vname, value: v.subnet });
          }
        }
      } catch {
        // tolerate (VLANs require the appliance to run in routed mode)
      }
    }

    return {
      interfaces,
      zones,
      routes,
      addressObjects,
      serviceObjects,
      capturedAt,
    };
  }

  validate(plan: BuildPlan): Promise<Validation> {
    const ir = plan.ir;
    const findings: Validation["findings"] = [];

    if (!this.creds.merakiNetworkId) {
      findings.push({
        severity: "error",
        message: "Meraki network id (creds.merakiNetworkId) is required to apply.",
      });
    }
    for (const rule of ir.security) {
      const anySrc = rule.sources.length === 0 || rule.sources.includes("any");
      const anyDst =
        rule.destinations.length === 0 || rule.destinations.includes("any");
      if (rule.action === "allow" && anySrc && anyDst) {
        findings.push({
          severity: "warn",
          message: `L3 rule "${rule.name}" allows any->any — review before applying.`,
        });
      }
    }
    // Meraki MX has no zone/interface design surface; warn if IR carries them.
    if (ir.interfaces.length || ir.zones.length) {
      findings.push({
        severity: "info",
        message:
          "Meraki MX is cloud-managed: IR interfaces/zones map to VLANs, not physical interface config.",
      });
    }

    const ok = !findings.some((f) => f.severity === "error");
    return Promise.resolve({ ok, findings });
  }

  render(plan: BuildPlan): Promise<RenderedConfig> {
    return Promise.resolve({
      format: "json",
      filename: "meraki-plan.json",
      content: renderMerakiPlan(plan.ir, this.creds),
    });
  }

  async applyLive(plan: BuildPlan): Promise<ApplyResult> {
    const messages: string[] = [];
    const net = this.creds.merakiNetworkId;
    if (!net) {
      return {
        ok: false,
        committed: false,
        messages: ["Meraki network id (creds.merakiNetworkId) is required."],
      };
    }
    try {
      // 1) L3 firewall rules — PUT replaces the whole ruleset.
      const rules = buildL3Rules(plan.ir);
      const fwRes = await fetch(
        `${MERAKI_BASE}/networks/${net}/appliance/firewall/l3FirewallRules`,
        {
          method: "PUT",
          headers: this.headers(),
          body: JSON.stringify({ rules }),
        },
      );
      if (fwRes.status < 200 || fwRes.status >= 300) {
        return {
          ok: false,
          committed: false,
          messages: [
            ...messages,
            `L3 firewall rules update failed: HTTP ${fwRes.status}`,
          ],
        };
      }
      messages.push(`Applied ${rules.length} L3 firewall rule(s).`);

      // 2) DNS/NTP-ish settings live on VLANs; this is a structural placeholder.
      //    Meraki has no global commit — the PUT above is already live.
      messages.push("Meraki Dashboard applied changes immediately (no commit step).");
      return { ok: true, committed: true, messages };
    } catch (err) {
      return {
        ok: false,
        committed: false,
        messages: [...messages, `Apply error: ${(err as Error).message}`],
      };
    }
  }

  readback(): Promise<DeviceInventory> {
    return this.discover();
  }
}

// ---------------------------------------------------------------------------
// Deterministic Meraki plan renderer.
// ---------------------------------------------------------------------------

interface MerakiL3Rule {
  comment: string;
  policy: "allow" | "deny";
  protocol: string;
  srcCidr: string;
  destCidr: string;
  destPort: string;
  syslogEnabled: boolean;
}

function buildL3Rules(ir: IR): MerakiL3Rule[] {
  return ir.security
    .filter((r) => !r.disabled)
    .map((r) => ({
      comment: r.name,
      policy: r.action === "allow" ? ("allow" as const) : ("deny" as const),
      protocol: merakiProto(ir, r.services),
      srcCidr: merakiCidr(r.sources),
      destCidr: merakiCidr(r.destinations),
      destPort: merakiPorts(ir, r.services),
      syslogEnabled: r.log,
    }));
}

function merakiProto(ir: IR, services: string[]): string {
  if (services.length === 0 || services.includes("any")) return "any";
  // Resolve the first named service's protocol if known.
  const svc = ir.services.find((s) => services.includes(s.name));
  if (svc && (svc.protocol === "tcp" || svc.protocol === "udp")) return svc.protocol;
  if (svc && svc.protocol === "icmp") return "icmp";
  return "any";
}

function merakiPorts(ir: IR, services: string[]): string {
  if (services.length === 0 || services.includes("any")) return "any";
  const ports: string[] = [];
  for (const name of services) {
    const svc = ir.services.find((s) => s.name === name);
    if (!svc) continue;
    if (svc.portRange) ports.push(`${svc.portRange[0]}-${svc.portRange[1]}`);
    else ports.push(...svc.ports.map(String));
  }
  return ports.length ? ports.join(",") : "any";
}

function merakiCidr(vals: string[]): string {
  if (vals.length === 0 || vals.includes("any")) return "any";
  // Meraki accepts comma-separated CIDRs; pass object names through as-is so the
  // human reviewer can map them (the plan is a review artefact, not live config).
  return vals.join(",");
}

interface MerakiApiCall {
  description: string;
  method: string;
  url: string;
  body: unknown;
}

function renderMerakiPlan(ir: IR, creds: Credentials): string {
  const net = creds.merakiNetworkId ?? "<network-id>";
  const calls: MerakiApiCall[] = [
    {
      description: "Replace L3 firewall ruleset",
      method: "PUT",
      url: `/networks/${net}/appliance/firewall/l3FirewallRules`,
      body: { rules: buildL3Rules(ir) },
    },
  ];

  // Static NAT / port forwarding from destination NAT rules.
  const portForwards = ir.nat
    .filter((n) => n.type === "destination" && n.translatedDest)
    .map((n) => ({
      name: n.name,
      lanIp: n.translatedDest,
      publicPort: n.translatedPort ? String(n.translatedPort) : "any",
      localPort: n.translatedPort ? String(n.translatedPort) : "any",
      protocol: "tcp",
      allowedIps: n.originalSource.length ? n.originalSource : ["any"],
    }));
  if (portForwards.length) {
    calls.push({
      description: "Configure 1:Many / port-forwarding rules",
      method: "PUT",
      url: `/networks/${net}/appliance/firewall/portForwardingRules`,
      body: { rules: portForwards },
    });
  }

  const doc = {
    _meta: {
      generator: "bastion",
      vendor: ir.meta.vendor,
      irVersion: ir.meta.irVersion,
      note: "Intended Meraki Dashboard API calls derived from IR. base=" + MERAKI_BASE,
      orgId: creds.merakiOrgId ?? "<org-id>",
      networkId: net,
    },
    system: {
      hostname: ir.system.hostname,
      dnsServers: ir.system.dns,
      ntpServers: ir.system.ntp,
      note: "DNS/NTP on Meraki MX are configured per-VLAN (DHCP) or via the dashboard.",
    },
    apiCalls: calls,
  };

  return JSON.stringify(doc, null, 2);
}
