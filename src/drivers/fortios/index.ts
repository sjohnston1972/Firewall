/**
 * Fortinet FortiOS driver (CLAUDE.md §4.3).
 *
 * API model: FortiOS REST API (cmdb for config, monitor for status). Auth is via
 * an API token sent as a Bearer header (creds.apiKey), or session-based login.
 * Config is written via direct object writes; FortiOS has no global commit step.
 *
 * render() emits deterministic FortiOS CLI `config ... set ... end` blocks for
 * staged download. The IR -> device path contains ZERO AI.
 */
import type { IR } from "../../../schema/ir";
import type { Credentials, Vendor } from "../../types";
import type { Transport, TransportRequest } from "../../transport/types";
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

export class FortiosDriver implements FirewallDriver {
  readonly vendor: Vendor = "fortios";
  private readonly creds: Credentials;
  private readonly transport: Transport;

  constructor(ctx: DriverContext) {
    this.creds = ctx.creds;
    this.transport = ctx.transport;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.creds.apiKey) {
      headers["authorization"] = `Bearer ${this.creds.apiKey}`;
    }
    return headers;
  }

  /** GET a FortiOS REST path and parse JSON, tolerating non-JSON/errors. */
  private async getJson(path: string): Promise<unknown> {
    const req: TransportRequest = {
      method: "GET",
      path,
      headers: this.authHeaders(),
    };
    const res = await this.transport.fetch(req);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`FortiOS GET ${path} failed: HTTP ${res.status}`);
    }
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new Error(`FortiOS GET ${path} returned non-JSON body`);
    }
  }

  async testConnection(): Promise<ConnInfo> {
    try {
      // monitor/system/status returns version/serial/model in `results`.
      const data = (await this.getJson("/api/v2/monitor/system/status")) as {
        version?: string;
        serial?: string;
        results?: { model_name?: string; model?: string; version?: string };
      };
      const results = data.results ?? {};
      return {
        reachable: true,
        model: results.model_name ?? results.model,
        version: data.version ?? results.version,
        serial: data.serial,
        raw: data,
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

    // Interfaces (cmdb).
    try {
      const data = (await this.getJson("/api/v2/cmdb/system/interface")) as {
        results?: Array<{
          name?: string;
          ip?: string;
          status?: string;
          description?: string;
        }>;
      };
      for (const it of data.results ?? []) {
        if (!it.name) continue;
        interfaces.push({
          name: it.name,
          enabled: it.status ? /up/i.test(it.status) : true,
          address: it.ip && it.ip !== "0.0.0.0 0.0.0.0" ? it.ip : undefined,
          description: it.description,
        });
      }
    } catch {
      // tolerate
    }

    // Zones (cmdb).
    try {
      const data = (await this.getJson("/api/v2/cmdb/system/zone")) as {
        results?: Array<{ name?: string; interface?: Array<{ "interface-name"?: string }> }>;
      };
      for (const z of data.results ?? []) {
        if (!z.name) continue;
        zones.push({
          name: z.name,
          interfaces: (z.interface ?? [])
            .map((i) => i["interface-name"])
            .filter((x): x is string => typeof x === "string"),
        });
      }
    } catch {
      // tolerate
    }

    // Routing table (monitor).
    try {
      const data = (await this.getJson("/api/v2/monitor/router/ipv4")) as {
        results?: Array<{
          ip_mask?: string;
          gateway?: string;
          interface?: string;
        }>;
      };
      for (const r of data.results ?? []) {
        if (!r.ip_mask) continue;
        routes.push({
          destination: r.ip_mask,
          nexthop: r.gateway,
          iface: r.interface,
        });
      }
    } catch {
      // tolerate
    }

    // Address objects (cmdb).
    try {
      const data = (await this.getJson("/api/v2/cmdb/firewall/address")) as {
        results?: Array<{ name?: string; subnet?: string; fqdn?: string }>;
      };
      for (const a of data.results ?? []) {
        if (!a.name) continue;
        addressObjects.push({ name: a.name, value: a.subnet ?? a.fqdn ?? "" });
      }
    } catch {
      // tolerate
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
    const zoneNames = new Set(ir.zones.map((z) => z.name));
    const ifaceNames = new Set(ir.interfaces.map((i) => i.name));

    for (const z of ir.zones) {
      for (const member of z.interfaces) {
        if (!ifaceNames.has(member)) {
          findings.push({
            severity: "warn",
            message: `Zone "${z.name}" references interface "${member}" not in plan.`,
          });
        }
      }
    }
    for (const rule of ir.security) {
      for (const z of [...rule.sourceZones, ...rule.destZones]) {
        if (!zoneNames.has(z) && !ifaceNames.has(z)) {
          findings.push({
            severity: "warn",
            message: `Policy "${rule.name}" references srcintf/dstintf "${z}" not defined as a zone or interface.`,
          });
        }
      }
      const anySrc = rule.sources.length === 0 || rule.sources.includes("any");
      const anyDst =
        rule.destinations.length === 0 || rule.destinations.includes("any");
      if (rule.action === "allow" && anySrc && anyDst) {
        findings.push({
          severity: "warn",
          message: `Policy "${rule.name}" is any->any accept — review before applying.`,
        });
      }
    }

    const ok = !findings.some((f) => f.severity === "error");
    return Promise.resolve({ ok, findings });
  }

  render(plan: BuildPlan): Promise<RenderedConfig> {
    return Promise.resolve({
      format: "cli",
      filename: "fortios-config.conf",
      content: renderFortiosCli(plan.ir),
    });
  }

  async applyLive(plan: BuildPlan): Promise<ApplyResult> {
    const messages: string[] = [];
    try {
      // FortiOS applies via direct cmdb object writes (no global commit).
      // We POST address objects then firewall policies. Structure only — wrap
      // each call and report honestly; do not fabricate success.
      let writes = 0;

      for (const addr of plan.ir.addresses) {
        const body = JSON.stringify({
          name: addr.name,
          subnet: addr.kind === "fqdn" ? undefined : addr.value,
          fqdn: addr.kind === "fqdn" ? addr.value : undefined,
          type: addr.kind === "fqdn" ? "fqdn" : "ipmask",
        });
        const res = await this.transport.fetch({
          method: "POST",
          path: "/api/v2/cmdb/firewall/address",
          headers: { ...this.authHeaders(), "content-type": "application/json" },
          body,
        });
        if (res.status < 200 || res.status >= 300) {
          return {
            ok: false,
            committed: false,
            messages: [
              ...messages,
              `Address "${addr.name}" write failed: HTTP ${res.status}`,
            ],
          };
        }
        writes++;
      }

      for (const rule of plan.ir.security) {
        const body = JSON.stringify({
          name: rule.name,
          srcintf: rule.sourceZones.map((z) => ({ name: z })),
          dstintf: rule.destZones.map((z) => ({ name: z })),
          srcaddr: (rule.sources.length ? rule.sources : ["all"]).map((s) => ({
            name: s === "any" ? "all" : s,
          })),
          dstaddr: (rule.destinations.length ? rule.destinations : ["all"]).map(
            (d) => ({ name: d === "any" ? "all" : d }),
          ),
          service: (rule.services.length ? rule.services : ["ALL"]).map((s) => ({
            name: s === "any" ? "ALL" : s,
          })),
          action: rule.action === "allow" ? "accept" : "deny",
          logtraffic: rule.log ? "all" : "disable",
          status: rule.disabled ? "disable" : "enable",
        });
        const res = await this.transport.fetch({
          method: "POST",
          path: "/api/v2/cmdb/firewall/policy",
          headers: { ...this.authHeaders(), "content-type": "application/json" },
          body,
        });
        if (res.status < 200 || res.status >= 300) {
          return {
            ok: false,
            committed: false,
            messages: [
              ...messages,
              `Policy "${rule.name}" write failed: HTTP ${res.status}`,
            ],
          };
        }
        writes++;
      }

      messages.push(`Applied ${writes} object(s) via FortiOS cmdb.`);
      // FortiOS has no commit phase: a successful write IS the commit.
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
// Deterministic FortiOS CLI renderer.
// ---------------------------------------------------------------------------

function renderFortiosCli(ir: IR): string {
  const lines: string[] = [];
  lines.push("# Bastion — generated FortiOS configuration");
  lines.push(`# vendor=${ir.meta.vendor} irVersion=${ir.meta.irVersion}`);
  lines.push("");

  // ----- system global / dns / ntp -----
  if (ir.system.hostname) {
    lines.push("config system global");
    lines.push(`    set hostname "${ir.system.hostname}"`);
    if (ir.system.timezone) lines.push(`    set timezone "${ir.system.timezone}"`);
    lines.push("end");
    lines.push("");
  }
  if (ir.system.dns.length) {
    lines.push("config system dns");
    if (ir.system.dns[0]) lines.push(`    set primary ${ir.system.dns[0]}`);
    if (ir.system.dns[1]) lines.push(`    set secondary ${ir.system.dns[1]}`);
    lines.push("end");
    lines.push("");
  }
  if (ir.system.ntp.length) {
    lines.push("config system ntp");
    lines.push("    set ntpsync enable");
    lines.push("    set type custom");
    lines.push("    config ntpserver");
    ir.system.ntp.forEach((server, idx) => {
      lines.push(`        edit ${idx + 1}`);
      lines.push(`            set server "${server}"`);
      lines.push("        next");
    });
    lines.push("    end");
    lines.push("end");
    lines.push("");
  }

  // ----- management hardening (admin access on interfaces) -----
  const mgmt = ir.system.management;
  const allowAccess: string[] = [];
  if (mgmt.https) allowAccess.push("https");
  if (mgmt.ssh) allowAccess.push("ssh");
  if (mgmt.httpPlain) allowAccess.push("http");
  if (mgmt.telnet) allowAccess.push("telnet");

  // ----- interfaces -----
  if (ir.interfaces.length) {
    lines.push("config system interface");
    for (const iface of ir.interfaces) {
      lines.push(`    edit "${iface.name}"`);
      lines.push(`        set status ${iface.enabled ? "up" : "down"}`);
      if (iface.addressing.mode === "static") {
        // FortiOS expects "ip netmask"; convert CIDR -> ip + mask.
        lines.push(`        set mode static`);
        lines.push(`        set ip ${cidrToIpMask(iface.addressing.address)}`);
      } else if (iface.addressing.mode === "dhcp") {
        lines.push("        set mode dhcp");
      }
      if (allowAccess.length) {
        lines.push(`        set allowaccess ${allowAccess.join(" ")}`);
      }
      if (iface.description) lines.push(`        set description "${iface.description}"`);
      if (iface.mtu) {
        lines.push("        set mtu-override enable");
        lines.push(`        set mtu ${iface.mtu}`);
      }
      lines.push("    next");
    }
    lines.push("end");
    lines.push("");
  }

  // ----- zones -----
  if (ir.zones.length) {
    lines.push("config system zone");
    for (const zone of ir.zones) {
      lines.push(`    edit "${zone.name}"`);
      if (zone.interfaces.length) {
        lines.push(
          `        set interface ${zone.interfaces.map((i) => `"${i}"`).join(" ")}`,
        );
      }
      lines.push("    next");
    }
    lines.push("end");
    lines.push("");
  }

  // ----- address objects -----
  if (ir.addresses.length) {
    lines.push("config firewall address");
    for (const addr of ir.addresses) {
      lines.push(`    edit "${addr.name}"`);
      if (addr.kind === "fqdn") {
        lines.push("        set type fqdn");
        lines.push(`        set fqdn "${addr.value}"`);
      } else {
        lines.push(`        set subnet ${cidrToIpMask(addr.value)}`);
      }
      lines.push("    next");
    }
    lines.push("end");
    lines.push("");
  }

  // ----- service objects -----
  if (ir.services.length) {
    lines.push("config firewall service custom");
    for (const svc of ir.services) {
      lines.push(`    edit "${svc.name}"`);
      const portSpec = svc.portRange
        ? `${svc.portRange[0]}-${svc.portRange[1]}`
        : svc.ports.join(" ");
      if (svc.protocol === "tcp" && portSpec) {
        lines.push(`        set tcp-portrange ${portSpec}`);
      } else if (svc.protocol === "udp" && portSpec) {
        lines.push(`        set udp-portrange ${portSpec}`);
      } else if (svc.protocol === "icmp") {
        lines.push("        set protocol ICMP");
      }
      lines.push("    next");
    }
    lines.push("end");
    lines.push("");
  }

  // ----- firewall policy -----
  if (ir.security.length) {
    lines.push("config firewall policy");
    ir.security.forEach((rule, idx) => {
      lines.push(`    edit ${idx + 1}`);
      lines.push(`        set name "${rule.name}"`);
      lines.push(
        `        set srcintf ${(rule.sourceZones.length ? rule.sourceZones : ["any"]).map((z) => `"${z}"`).join(" ")}`,
      );
      lines.push(
        `        set dstintf ${(rule.destZones.length ? rule.destZones : ["any"]).map((z) => `"${z}"`).join(" ")}`,
      );
      lines.push(
        `        set srcaddr ${(rule.sources.length ? rule.sources : ["all"]).map((s) => `"${s === "any" ? "all" : s}"`).join(" ")}`,
      );
      lines.push(
        `        set dstaddr ${(rule.destinations.length ? rule.destinations : ["all"]).map((d) => `"${d === "any" ? "all" : d}"`).join(" ")}`,
      );
      lines.push(
        `        set service ${(rule.services.length ? rule.services : ["ALL"]).map((s) => `"${s === "any" ? "ALL" : s}"`).join(" ")}`,
      );
      lines.push("        set schedule \"always\"");
      lines.push(`        set action ${rule.action === "allow" ? "accept" : "deny"}`);
      lines.push(`        set logtraffic ${rule.log ? "all" : "disable"}`);
      if (rule.action === "allow") lines.push("        set nat enable");
      if (rule.disabled) lines.push("        set status disable");
      if (rule.profiles.length) {
        lines.push("        set utm-status enable");
        lines.push(`        # NGFW profiles: ${rule.profiles.join(", ")}`);
      }
      lines.push("    next");
    });
    lines.push("end");
    lines.push("");
  }

  // ----- central NAT -----
  if (ir.nat.length) {
    lines.push("config firewall central-snat-map");
    ir.nat.forEach((nat, idx) => {
      if (nat.type !== "source") {
        lines.push(`    # ${nat.name}: ${nat.type} NAT — see VIP/DNAT section`);
        return;
      }
      lines.push(`    edit ${idx + 1}`);
      if (nat.sourceZone) lines.push(`        set srcintf "${nat.sourceZone}"`);
      if (nat.destZone) lines.push(`        set dstintf "${nat.destZone}"`);
      lines.push(
        `        set orig-addr ${(nat.originalSource.length ? nat.originalSource : ["all"]).map((s) => `"${s}"`).join(" ")}`,
      );
      lines.push(
        `        set dst-addr ${(nat.originalDest.length ? nat.originalDest : ["all"]).map((d) => `"${d}"`).join(" ")}`,
      );
      if (nat.translatedSource) {
        lines.push("        set nat-ippool disable");
        lines.push(`        # translated source: ${nat.translatedSource}`);
      }
      lines.push("    next");
    });
    lines.push("end");
    lines.push("");
  }

  lines.push("# End of generated configuration.");
  return lines.join("\n");
}

/** Convert "10.0.0.0/24" to "10.0.0.0 255.255.255.0". Pass through if no /. */
function cidrToIpMask(value: string): string {
  const slash = value.indexOf("/");
  if (slash === -1) return value;
  const ip = value.slice(0, slash);
  const prefix = Number(value.slice(slash + 1));
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return value;
  const maskNum = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const mask = [
    (maskNum >>> 24) & 0xff,
    (maskNum >>> 16) & 0xff,
    (maskNum >>> 8) & 0xff,
    maskNum & 0xff,
  ].join(".");
  return `${ip} ${mask}`;
}
