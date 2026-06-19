/**
 * Cisco ASA driver (CLAUDE.md §4.3).
 *
 * API model: ASA REST API (/api/...), with SSH/CLI as a documented fallback
 * (not implemented in this build). Auth is HTTP Basic. Live apply writes to the
 * running-config and copies to startup.
 *
 * render() emits deterministic ASA CLI (object network / access-list / nat /
 * etc.) for staged download. The IR -> device path contains ZERO AI.
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

export class AsaDriver implements FirewallDriver {
  readonly vendor: Vendor = "asa";
  private readonly creds: Credentials;
  private readonly transport: Transport;

  constructor(ctx: DriverContext) {
    this.creds = ctx.creds;
    this.transport = ctx.transport;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const user = this.creds.username ?? "";
    const pass = this.creds.password ?? "";
    return {
      authorization: `Basic ${btoa(`${user}:${pass}`)}`,
      accept: "application/json",
      ...extra,
    };
  }

  private async getJson(path: string): Promise<unknown> {
    const req: TransportRequest = {
      method: "GET",
      path,
      headers: this.authHeaders(),
    };
    const res = await this.transport.fetch(req);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`ASA GET ${path} failed: HTTP ${res.status}`);
    }
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new Error(`ASA GET ${path} returned non-JSON body`);
    }
  }

  async testConnection(): Promise<ConnInfo> {
    try {
      // /api/monitoring/device/components/version returns model/version.
      const data = (await this.getJson(
        "/api/monitoring/device/components/version",
      )) as {
        asaVersion?: string;
        deviceType?: string;
        serialNumber?: string;
      };
      return {
        reachable: true,
        model: data.deviceType ?? "Cisco ASA",
        version: data.asaVersion,
        serial: data.serialNumber,
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

    // Physical interfaces.
    try {
      const data = (await this.getJson(
        "/api/interfaces/physical",
      )) as {
        items?: Array<{
          hardwareID?: string;
          interfaceDesc?: string;
          shutdown?: boolean;
          ipAddress?: { ip?: { value?: string } };
          nameif?: string;
        }>;
      };
      for (const it of data.items ?? []) {
        const name = it.hardwareID ?? it.nameif;
        if (!name) continue;
        interfaces.push({
          name,
          enabled: it.shutdown !== true,
          address: it.ipAddress?.ip?.value,
          zone: it.nameif, // ASA "nameif" is its closest analogue to a zone.
          description: it.interfaceDesc,
        });
        // ASA security model uses nameif as a logical security domain.
        if (it.nameif) {
          zones.push({ name: it.nameif, interfaces: [name] });
        }
      }
    } catch {
      // tolerate
    }

    // Network objects.
    try {
      const data = (await this.getJson("/api/objects/networkobjects")) as {
        items?: Array<{ name?: string; host?: { value?: string }; value?: string }>;
      };
      for (const o of data.items ?? []) {
        if (!o.name) continue;
        addressObjects.push({ name: o.name, value: o.host?.value ?? o.value ?? "" });
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

    for (const rule of ir.security) {
      const anySrc = rule.sources.length === 0 || rule.sources.includes("any");
      const anyDst =
        rule.destinations.length === 0 || rule.destinations.includes("any");
      if (rule.action === "allow" && anySrc && anyDst) {
        findings.push({
          severity: "warn",
          message: `ACL "${rule.name}" permits any to any — review before applying.`,
        });
      }
      // ASA ACLs are bound to an interface (nameif); warn if no source zone set.
      if (rule.sourceZones.length === 0) {
        findings.push({
          severity: "info",
          message: `ACL "${rule.name}" has no source zone; on ASA an access-group must bind it to an interface.`,
        });
      }
    }

    const ok = !findings.some((f) => f.severity === "error");
    return Promise.resolve({ ok, findings });
  }

  render(plan: BuildPlan): Promise<RenderedConfig> {
    return Promise.resolve({
      format: "cli",
      filename: "asa-config.txt",
      content: renderAsaCli(plan.ir),
    });
  }

  async applyLive(plan: BuildPlan): Promise<ApplyResult> {
    const messages: string[] = [];
    try {
      // ASA REST supports a CLI passthrough: POST /api/cli with an array of
      // running-config commands. We render the config and submit it, then save
      // to startup with "write memory".
      const cli = renderAsaCli(plan.ir)
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("!"));

      const res = await this.transport.fetch({
        method: "POST",
        path: "/api/cli",
        headers: this.authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ commands: cli }),
      });
      if (res.status < 200 || res.status >= 300) {
        return {
          ok: false,
          committed: false,
          messages: [...messages, `Running-config write failed: HTTP ${res.status}`],
        };
      }
      messages.push(`Applied ${cli.length} CLI line(s) to running-config.`);

      // Save to startup.
      const saveRes = await this.transport.fetch({
        method: "POST",
        path: "/api/cli",
        headers: this.authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ commands: ["write memory"] }),
      });
      if (saveRes.status < 200 || saveRes.status >= 300) {
        return {
          ok: false,
          // Running-config changed but startup save failed — be honest.
          committed: false,
          messages: [
            ...messages,
            `"write memory" failed: HTTP ${saveRes.status} (running-config changed but not saved to startup)`,
          ],
        };
      }

      messages.push("Saved running-config to startup-config.");
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
// Deterministic ASA CLI renderer.
// ---------------------------------------------------------------------------

function renderAsaCli(ir: IR): string {
  const lines: string[] = [];
  lines.push("! Bastion — generated Cisco ASA configuration");
  lines.push(`! vendor=${ir.meta.vendor} irVersion=${ir.meta.irVersion}`);
  lines.push("!");

  // ----- system: hostname / dns / ntp -----
  if (ir.system.hostname) lines.push(`hostname ${ir.system.hostname}`);
  if (ir.system.dns.length) {
    lines.push("dns domain-lookup");
    lines.push("dns server-group DefaultDNS");
    lines.push(` name-server ${ir.system.dns.join(" ")}`);
  }
  for (const ntp of ir.system.ntp) {
    lines.push(`ntp server ${ntp}`);
  }
  lines.push("!");

  // ----- interfaces -----
  for (const iface of ir.interfaces) {
    lines.push(`interface ${iface.name}`);
    // nameif: use the mapped zone as the security domain name where available.
    if (iface.zone) lines.push(` nameif ${iface.zone}`);
    if (iface.description) lines.push(` description ${iface.description}`);
    if (iface.addressing.mode === "static") {
      const [ip, mask] = cidrToIpMaskPair(iface.addressing.address);
      lines.push(` ip address ${ip} ${mask}`);
    } else if (iface.addressing.mode === "dhcp") {
      lines.push(" ip address dhcp");
    }
    if (iface.mtu) lines.push(` mtu ${iface.name} ${iface.mtu}`);
    lines.push(iface.enabled ? " no shutdown" : " shutdown");
    lines.push("!");
  }

  // ----- network objects -----
  for (const addr of ir.addresses) {
    lines.push(`object network ${addr.name}`);
    if (addr.kind === "fqdn") {
      lines.push(` fqdn ${addr.value}`);
    } else if (addr.kind === "host") {
      lines.push(` host ${addr.value.split("/")[0]}`);
    } else {
      const [ip, mask] = cidrToIpMaskPair(addr.value);
      lines.push(` subnet ${ip} ${mask}`);
    }
  }
  if (ir.addresses.length) lines.push("!");

  // ----- service objects -----
  for (const svc of ir.services) {
    if (svc.protocol !== "tcp" && svc.protocol !== "udp") continue;
    lines.push(`object service ${svc.name}`);
    const portSpec = svc.portRange
      ? `range ${svc.portRange[0]} ${svc.portRange[1]}`
      : svc.ports.length
        ? `eq ${svc.ports[0]}`
        : "";
    if (portSpec) lines.push(` service ${svc.protocol} destination ${portSpec}`);
  }
  if (ir.services.length) lines.push("!");

  // ----- access-lists + access-groups -----
  for (const rule of ir.security) {
    const aclName = sanitize(rule.name);
    const action = rule.action === "allow" ? "permit" : "deny";
    const srcs = rule.sources.length ? rule.sources : ["any"];
    const dsts = rule.destinations.length ? rule.destinations : ["any"];
    const svcs = rule.services.length ? rule.services : ["ip"];
    for (const s of srcs) {
      for (const d of dsts) {
        for (const svc of svcs) {
          const proto = svc === "any" || svc === "ip" ? "ip" : svc;
          lines.push(
            `access-list ${aclName} extended ${action} ${proto} ${asaAddr(s)} ${asaAddr(d)}${rule.log ? " log" : ""}`,
          );
        }
      }
    }
    // Bind to the first source zone's interface where present.
    if (rule.sourceZones[0]) {
      lines.push(`access-group ${aclName} in interface ${rule.sourceZones[0]}`);
    }
  }
  if (ir.security.length) lines.push("!");

  // ----- NAT -----
  for (const nat of ir.nat) {
    if (nat.type === "source" && nat.originalSource[0] && nat.translatedSource) {
      // object-based dynamic PAT.
      lines.push(`object network ${sanitize(nat.name)}-src`);
      lines.push(` nat (${nat.sourceZone ?? "inside"},${nat.destZone ?? "outside"}) dynamic ${nat.translatedSource}`);
    } else if (
      nat.type === "destination" &&
      nat.originalDest[0] &&
      nat.translatedDest
    ) {
      lines.push(`object network ${sanitize(nat.name)}-dst`);
      const portClause = nat.translatedPort
        ? ` service tcp ${nat.translatedPort} ${nat.translatedPort}`
        : "";
      lines.push(
        ` nat (${nat.destZone ?? "outside"},${nat.sourceZone ?? "inside"}) static ${nat.translatedDest}${portClause}`,
      );
    } else if (nat.type === "static" && nat.originalSource[0] && nat.translatedSource) {
      lines.push(`object network ${sanitize(nat.name)}-static`);
      lines.push(
        ` nat (${nat.sourceZone ?? "inside"},${nat.destZone ?? "outside"}) static ${nat.translatedSource}`,
      );
    } else {
      lines.push(`! NAT ${nat.name}: insufficient data to render (type=${nat.type})`);
    }
  }
  if (ir.nat.length) lines.push("!");

  // ----- management hardening -----
  const mgmt = ir.system.management;
  for (const src of mgmt.allowedSources) {
    const [ip, mask] = cidrToIpMaskPair(src);
    if (mgmt.ssh) lines.push(`ssh ${ip} ${mask} management`);
    if (mgmt.https) lines.push(`http ${ip} ${mask} management`);
  }
  if (!mgmt.telnet) lines.push("! telnet intentionally not enabled (hardening)");
  lines.push("!");

  lines.push("! End of generated configuration.");
  return lines.join("\n");
}

/** ASA address token: "any" stays "any"; CIDR -> "ip mask"; host -> "host ip". */
function asaAddr(value: string): string {
  if (value === "any" || value === "any4") return "any";
  if (value.includes("/")) {
    const [ip, mask] = cidrToIpMaskPair(value);
    return `${ip} ${mask}`;
  }
  // Bare IP -> host; otherwise treat as an object name.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return `host ${value}`;
  return `object ${value}`;
}

function cidrToIpMaskPair(value: string): [string, string] {
  const slash = value.indexOf("/");
  if (slash === -1) return [value, "255.255.255.255"];
  const ip = value.slice(0, slash);
  const prefix = Number(value.slice(slash + 1));
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
    return [ip, "255.255.255.255"];
  }
  const maskNum = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const mask = [
    (maskNum >>> 24) & 0xff,
    (maskNum >>> 16) & 0xff,
    (maskNum >>> 8) & 0xff,
    maskNum & 0xff,
  ].join(".");
  return [ip, mask];
}

/** ASA object/ACL names can't contain spaces. */
function sanitize(name: string): string {
  return name.replace(/\s+/g, "_");
}
