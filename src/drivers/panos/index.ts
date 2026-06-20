/**
 * Palo Alto PAN-OS driver (CLAUDE.md §4.3 — the flagship).
 *
 * API model: PAN-OS XML API. We authenticate with `?type=keygen` to obtain an
 * API key, then issue operational commands via `?type=op&cmd=<...>`. Config
 * changes are pushed as `set` CLI (deterministic render), then `commit`-ed.
 *
 * Parsing is done pragmatically with regex (no XML library available in the
 * Worker runtime) and tolerates missing data by filling empty arrays.
 *
 * The IR -> device path contains ZERO AI: render() is pure deterministic
 * templating.
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

export class PanosDriver implements FirewallDriver {
  readonly vendor: Vendor = "panos";
  private readonly creds: Credentials;
  private readonly transport: Transport;
  /** Cached API key obtained from keygen for the duration of the driver. */
  private apiKey?: string;

  constructor(ctx: DriverContext) {
    this.creds = ctx.creds;
    this.transport = ctx.transport;
    // An API key may have been supplied directly (skip keygen if so).
    this.apiKey = ctx.creds.apiKey;
  }

  // ---------- helpers ----------

  /** Extract the first capture group of `re` from `xml`, or undefined. */
  private static pick(xml: string, re: RegExp): string | undefined {
    const m = re.exec(xml);
    return m && m[1] !== undefined ? m[1].trim() : undefined;
  }

  /** Return the inner text of the first <tag>…</tag>, or "". */
  private static section(xml: string, tag: string): string {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
    return m ? m[1] : "";
  }

  /** Iterate the inner text of each top-ish <entry>…</entry> in a section. */
  private static *entries(section: string): Generator<string> {
    const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(section)) !== null) yield m[1];
  }

  /** The `name` attribute of an <entry name="…">, if present. */
  private static entryName(entryOpenTag: string): string | undefined {
    return PanosDriver.pick(entryOpenTag, /\bname="([^"]+)"/i);
  }

  /** Obtain (and cache) a PAN-OS API key via the keygen endpoint. */
  private async ensureApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const user = encodeURIComponent(this.creds.username ?? "");
    const pass = encodeURIComponent(this.creds.password ?? "");
    const req: TransportRequest = {
      method: "GET",
      path: `/api/?type=keygen&user=${user}&password=${pass}`,
    };
    const res = await this.transport.fetch(req);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`PAN-OS keygen failed: HTTP ${res.status}`);
    }
    const key = PanosDriver.pick(res.body, /<key>([^<]+)<\/key>/i);
    if (!key) {
      const msg = PanosDriver.pick(res.body, /<msg>([^<]+)<\/msg>/i);
      throw new Error(`PAN-OS keygen returned no key${msg ? `: ${msg}` : ""}`);
    }
    this.apiKey = key;
    return key;
  }

  /** Run an operational command (`type=op`) and return raw XML body. */
  private async op(cmd: string): Promise<string> {
    const key = await this.ensureApiKey();
    const req: TransportRequest = {
      method: "GET",
      path: `/api/?type=op&cmd=${encodeURIComponent(cmd)}&key=${encodeURIComponent(key)}`,
    };
    const res = await this.transport.fetch(req);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`PAN-OS op command failed: HTTP ${res.status}`);
    }
    return res.body;
  }

  /** Read a running-config subtree via the config API (type=config&action=get). */
  private async configGet(xpath: string): Promise<string> {
    const key = await this.ensureApiKey();
    const req: TransportRequest = {
      method: "GET",
      path: `/api/?type=config&action=get&xpath=${encodeURIComponent(xpath)}&key=${encodeURIComponent(key)}`,
    };
    const res = await this.transport.fetch(req);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`PAN-OS config get failed: HTTP ${res.status}`);
    }
    return res.body;
  }

  // ---------- contract ----------

  async testConnection(): Promise<ConnInfo> {
    try {
      const xml = await this.op("<show><system><info></info></system></show>");
      return {
        reachable: true,
        model: PanosDriver.pick(xml, /<model>([^<]+)<\/model>/i),
        version: PanosDriver.pick(xml, /<sw-version>([^<]+)<\/sw-version>/i),
        serial: PanosDriver.pick(xml, /<serial>([^<]+)<\/serial>/i),
        haState: PanosDriver.pick(xml, /<ha>[\s\S]*?<state>([^<]+)<\/state>/i),
        raw: xml,
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
    let haState: string | undefined;

    // Interfaces + zones. `show interface all` is operational and returns the
    // interface NAME as a child <name> element (not a name= attribute), grouped
    // under <ifnet> (logical, has ip + zone) and <hw> (physical, has state).
    const zoneMembers = new Map<string, string[]>();
    try {
      const xml = await this.op("<show><interface>all</interface></show>");

      // up/down state per interface from the <hw> section.
      const hwState = new Map<string, string>();
      for (const block of PanosDriver.entries(PanosDriver.section(xml, "hw"))) {
        const name = PanosDriver.pick(block, /<name>([^<]+)<\/name>/i);
        const state = PanosDriver.pick(block, /<state>([^<]+)<\/state>/i);
        if (name) hwState.set(name, state ?? "");
      }

      // logical interfaces (name, ip, zone) from <ifnet>.
      for (const block of PanosDriver.entries(PanosDriver.section(xml, "ifnet"))) {
        const name = PanosDriver.pick(block, /<name>([^<]+)<\/name>/i);
        if (!name) continue;
        const ip = PanosDriver.pick(block, /<ip>([^<]+)<\/ip>/i);
        const zone = PanosDriver.pick(block, /<zone>([^<]+)<\/zone>/i);
        const state = hwState.get(name);
        interfaces.push({
          name,
          enabled: state ? /up/i.test(state) : true,
          address: ip && ip !== "N/A" && ip !== "" ? ip : undefined,
          zone: zone && zone !== "N/A" && zone !== "" ? zone : undefined,
        });
        if (zone && zone !== "N/A" && zone !== "") {
          const arr = zoneMembers.get(zone) ?? [];
          if (!arr.includes(name)) arr.push(name);
          zoneMembers.set(zone, arr);
        }
      }
    } catch {
      // tolerate — leave interfaces empty
    }

    // Zones: prefer the configured zone list (covers zones with no live iface);
    // fall back to zones derived from the interface→zone mapping above.
    try {
      const xml = await this.configGet(
        "/config/devices/entry/vsys/entry/zone",
      );
      for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
        const open = xml.slice(m.index, xml.indexOf(">", m.index) + 1);
        const zname = PanosDriver.entryName(open);
        if (!zname) continue;
        const members = [...m[1].matchAll(/<member[^>]*>([^<]+)<\/member>/gi)].map((x) =>
          x[1].trim(),
        );
        zones.push({ name: zname, interfaces: members.length ? members : (zoneMembers.get(zname) ?? []) });
        zoneMembers.delete(zname);
      }
    } catch {
      // tolerate
    }
    // Any zones only seen via interfaces (config read failed / empty).
    for (const [zname, members] of zoneMembers) zones.push({ name: zname, interfaces: members });

    // Routing table: <show><routing><route></route></routing></show>
    try {
      const xml = await this.op(
        "<show><routing><route></route></routing></show>",
      );
      const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
      let m: RegExpExecArray | null;
      while ((m = entryRe.exec(xml)) !== null) {
        const block = m[1];
        const dest = PanosDriver.pick(block, /<destination>([^<]+)<\/destination>/i);
        if (!dest) continue;
        const nh = PanosDriver.pick(block, /<nexthop>([^<]+)<\/nexthop>/i);
        const iface = PanosDriver.pick(block, /<interface>([^<]+)<\/interface>/i);
        const metricStr = PanosDriver.pick(block, /<metric>([^<]+)<\/metric>/i);
        routes.push({
          destination: dest,
          nexthop: nh,
          iface,
          metric: metricStr ? Number(metricStr) : undefined,
        });
      }
    } catch {
      // tolerate
    }

    // Address objects (config): name attr + ip-netmask | ip-range | fqdn.
    try {
      const xml = await this.configGet("/config/devices/entry/vsys/entry/address");
      for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
        const open = xml.slice(m.index, xml.indexOf(">", m.index) + 1);
        const name = PanosDriver.entryName(open);
        if (!name) continue;
        const value =
          PanosDriver.pick(m[1], /<ip-netmask>([^<]+)<\/ip-netmask>/i) ??
          PanosDriver.pick(m[1], /<ip-range>([^<]+)<\/ip-range>/i) ??
          PanosDriver.pick(m[1], /<fqdn>([^<]+)<\/fqdn>/i) ??
          "";
        addressObjects.push({ name, value });
      }
    } catch {
      // tolerate
    }

    // Service objects (config): name attr + protocol/port.
    try {
      const xml = await this.configGet("/config/devices/entry/vsys/entry/service");
      for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
        const open = xml.slice(m.index, xml.indexOf(">", m.index) + 1);
        const name = PanosDriver.entryName(open);
        if (!name) continue;
        const proto = /<tcp>/i.test(m[1]) ? "tcp" : /<udp>/i.test(m[1]) ? "udp" : "";
        const port = PanosDriver.pick(m[1], /<port>([^<]+)<\/port>/i) ?? "";
        serviceObjects.push({ name, value: proto && port ? `${proto}/${port}` : proto || port });
      }
    } catch {
      // tolerate
    }

    // HA state.
    try {
      const xml = await this.op("<show><high-availability><state></state></high-availability></show>");
      haState = PanosDriver.pick(xml, /<state>([^<]+)<\/state>/i);
    } catch {
      // tolerate
    }

    return {
      interfaces,
      zones,
      routes,
      addressObjects,
      serviceObjects,
      haState,
      capturedAt,
    };
  }

  validate(plan: BuildPlan): Promise<Validation> {
    const ir = plan.ir;
    const findings: Validation["findings"] = [];
    const zoneNames = new Set(ir.zones.map((z) => z.name));
    const ifaceNames = new Set(ir.interfaces.map((i) => i.name));

    // Zones must reference interfaces that exist in the plan.
    for (const z of ir.zones) {
      for (const member of z.interfaces) {
        if (!ifaceNames.has(member)) {
          findings.push({
            severity: "warn",
            message: `Zone "${z.name}" references interface "${member}" not defined in the plan.`,
          });
        }
      }
    }

    // Security rules must reference zones that exist.
    for (const rule of ir.security) {
      for (const z of [...rule.sourceZones, ...rule.destZones]) {
        if (!zoneNames.has(z)) {
          findings.push({
            severity: "error",
            message: `Security rule "${rule.name}" references zone "${z}" that does not exist.`,
          });
        }
      }
      // Warn on permissive any/any allow rules.
      const anySrc = rule.sources.length === 0 || rule.sources.includes("any");
      const anyDst =
        rule.destinations.length === 0 || rule.destinations.includes("any");
      if (rule.action === "allow" && anySrc && anyDst) {
        findings.push({
          severity: "warn",
          message: `Security rule "${rule.name}" allows any source to any destination — review before applying.`,
        });
      }
    }

    // NAT rules referencing zones.
    for (const n of ir.nat) {
      for (const z of [n.sourceZone, n.destZone]) {
        if (z && !zoneNames.has(z)) {
          findings.push({
            severity: "warn",
            message: `NAT rule "${n.name}" references zone "${z}" not defined in the plan.`,
          });
        }
      }
    }

    const ok = !findings.some((f) => f.severity === "error");
    return Promise.resolve({ ok, findings });
  }

  render(plan: BuildPlan): Promise<RenderedConfig> {
    const content = renderPanosSet(plan.ir);
    return Promise.resolve({
      format: "set",
      filename: "panos-config.txt",
      content,
    });
  }

  async applyLive(plan: BuildPlan): Promise<ApplyResult> {
    const messages: string[] = [];
    try {
      // 1) Render deterministic `set` CLI commands.
      const rendered = renderPanosSet(plan.ir);
      messages.push("Rendered PAN-OS set commands.");

      // 2) Push as candidate config. PAN-OS accepts `set`-format CLI via the
      //    op endpoint using <set><cli>...</cli></set>-style commands, or via
      //    type=config with set actions. Edits land in the candidate config
      //    implicitly; the commit in step 3 promotes them to running.
      //    (Structure only — no device present in this build.)
      const key = await this.ensureApiKey();

      const pushReq: TransportRequest = {
        method: "POST",
        path: `/api/?type=op&key=${encodeURIComponent(key)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        // The CLI set block is sent as the op command payload.
        body: `cmd=${encodeURIComponent(`<set><cli>${rendered}</cli></set>`)}`,
      };
      const pushRes = await this.transport.fetch(pushReq);
      if (pushRes.status < 200 || pushRes.status >= 300) {
        return {
          ok: false,
          committed: false,
          messages: [
            ...messages,
            `Candidate push failed: HTTP ${pushRes.status}`,
          ],
        };
      }
      messages.push("Candidate configuration staged on device.");

      // 3) Commit.
      const commitReq: TransportRequest = {
        method: "POST",
        path: `/api/?type=commit&key=${encodeURIComponent(key)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `cmd=${encodeURIComponent("<commit></commit>")}`,
      };
      const commitRes = await this.transport.fetch(commitReq);
      if (commitRes.status < 200 || commitRes.status >= 300) {
        return {
          ok: false,
          committed: false,
          messages: [...messages, `Commit failed: HTTP ${commitRes.status}`],
        };
      }

      const status = PanosDriver.pick(commitRes.body, /status="([^"]+)"/i);
      const jobId =
        PanosDriver.pick(commitRes.body, /<job>([^<]+)<\/job>/i) ?? undefined;
      if (status && status.toLowerCase() !== "success") {
        const msg = PanosDriver.pick(commitRes.body, /<msg>([\s\S]*?)<\/msg>/i);
        return {
          ok: false,
          committed: false,
          jobId,
          messages: [
            ...messages,
            `Commit rejected by device${msg ? `: ${msg}` : ""}`,
          ],
        };
      }

      messages.push(`Commit accepted${jobId ? ` (job ${jobId})` : ""}.`);
      return { ok: true, committed: true, jobId, messages };
    } catch (err) {
      // Honest failure — never fabricate a successful apply.
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
// Deterministic PAN-OS `set` CLI renderer (pure function, no AI, no network).
// ---------------------------------------------------------------------------

/** PAN-OS quoting: wrap in double quotes if the token has spaces/special chars. */
function q(value: string): string {
  return /^[A-Za-z0-9._\-/]+$/.test(value) ? value : `"${value}"`;
}

function renderPanosSet(ir: IR): string {
  const lines: string[] = [];
  lines.push("# Bastion — generated PAN-OS set configuration");
  lines.push(`# vendor=${ir.meta.vendor} irVersion=${ir.meta.irVersion}`);
  lines.push("# Deterministic render — review before commit.");
  lines.push("");

  // ----- system: hostname, dns, ntp -----
  const sys = ir.system;
  lines.push("# --- System ---");
  if (sys.hostname) {
    lines.push(`set deviceconfig system hostname ${q(sys.hostname)}`);
  }
  if (sys.timezone) {
    lines.push(`set deviceconfig system timezone ${q(sys.timezone)}`);
  }
  if (sys.dns[0]) {
    lines.push(`set deviceconfig system dns-setting servers primary ${sys.dns[0]}`);
  }
  if (sys.dns[1]) {
    lines.push(`set deviceconfig system dns-setting servers secondary ${sys.dns[1]}`);
  }
  sys.ntp.forEach((server, idx) => {
    const slot = idx === 0 ? "primary-ntp-server" : "secondary-ntp-server";
    lines.push(`set deviceconfig system ntp-servers ${slot} ntp-server-address ${q(server)}`);
    if (idx > 1) {
      lines.push(`# note: PAN-OS supports primary+secondary NTP only; extra server ${q(server)} skipped on device.`);
    }
  });

  // ----- management hardening -----
  const mgmt = sys.management;
  lines.push("");
  lines.push("# --- Management plane hardening ---");
  lines.push(`set deviceconfig system service disable-telnet ${mgmt.telnet ? "no" : "yes"}`);
  lines.push(`set deviceconfig system service disable-http ${mgmt.httpPlain ? "no" : "yes"}`);
  lines.push(`set deviceconfig system service disable-https ${mgmt.https ? "no" : "yes"}`);
  lines.push(`set deviceconfig system service disable-ssh ${mgmt.ssh ? "no" : "yes"}`);
  for (const src of mgmt.allowedSources) {
    lines.push(`set deviceconfig system permitted-ip ${src.split("/")[0]} ${q(src)}`);
  }
  if (mgmt.lockoutThreshold > 0) {
    lines.push(`set mgt-config users admin authentication-profile lockout failed-attempts ${mgmt.lockoutThreshold}`);
  }

  // ----- interfaces -----
  lines.push("");
  lines.push("# --- Interfaces ---");
  for (const iface of ir.interfaces) {
    const base = `set network interface ethernet ${q(iface.name)} layer3`;
    if (iface.addressing.mode === "static") {
      lines.push(`${base} ip ${q(iface.addressing.address)}`);
    } else if (iface.addressing.mode === "dhcp") {
      lines.push(`${base} dhcp-client enable yes`);
    }
    if (iface.mtu) {
      lines.push(`${base} mtu ${iface.mtu}`);
    }
    if (iface.description) {
      lines.push(`set network interface ethernet ${q(iface.name)} comment ${q(iface.description)}`);
    }
    if (!iface.enabled) {
      lines.push(`set network interface ethernet ${q(iface.name)} link-state down`);
    }
  }

  // ----- zones (map interfaces) -----
  lines.push("");
  lines.push("# --- Zones ---");
  for (const zone of ir.zones) {
    for (const member of zone.interfaces) {
      lines.push(
        `set zone ${q(zone.name)} network layer3 ${q(member)}`,
      );
    }
    if (zone.interfaces.length === 0) {
      lines.push(`# zone ${q(zone.name)} has no interfaces mapped`);
    }
  }

  // ----- address objects -----
  lines.push("");
  lines.push("# --- Address objects ---");
  for (const addr of ir.addresses) {
    const kind =
      addr.kind === "fqdn"
        ? "fqdn"
        : addr.kind === "host"
          ? "ip-netmask"
          : "ip-netmask";
    lines.push(`set address ${q(addr.name)} ${kind} ${q(addr.value)}`);
  }

  // ----- service objects -----
  lines.push("");
  lines.push("# --- Service objects ---");
  for (const svc of ir.services) {
    if (svc.protocol !== "tcp" && svc.protocol !== "udp") {
      lines.push(`# service ${q(svc.name)} protocol ${svc.protocol} — not a port-based service object, skipped`);
      continue;
    }
    let portSpec = "";
    if (svc.portRange) {
      portSpec = `${svc.portRange[0]}-${svc.portRange[1]}`;
    } else if (svc.ports.length > 0) {
      portSpec = svc.ports.join(",");
    }
    if (!portSpec) {
      lines.push(`# service ${q(svc.name)} has no ports defined, skipped`);
      continue;
    }
    lines.push(`set service ${q(svc.name)} protocol ${svc.protocol} port ${portSpec}`);
  }

  // ----- NGFW profile groups (security profiles) -----
  lines.push("");
  lines.push("# --- NGFW security profiles ---");
  for (const p of ir.ngfw) {
    // PAN-OS uses individual profiles; here we register a profile-group name
    // referencing built-in best-practice profiles where enabled.
    const parts: string[] = [];
    if (p.ips) parts.push("virus default-and-spyware");
    if (p.antiMalware) parts.push("spyware default");
    if (p.urlFiltering) parts.push("url-filtering default");
    if (p.dnsSecurity) parts.push("spyware dns-security");
    lines.push(
      `# profile-group ${q(p.name)}: ${parts.length ? parts.join(", ") : "no profiles enabled"}`,
    );
    if (p.ips) lines.push(`set profile-group ${q(p.name)} vulnerability default`);
    if (p.antiMalware) lines.push(`set profile-group ${q(p.name)} virus default`);
    if (p.urlFiltering) lines.push(`set profile-group ${q(p.name)} url-filtering default`);
  }

  // ----- security rules -----
  lines.push("");
  lines.push("# --- Security policy ---");
  for (const rule of ir.security) {
    const base = `set rulebase security rules ${q(rule.name)}`;
    const list = (vals: string[]): string =>
      vals.length ? vals.map(q).join(" ") : "any";
    lines.push(`${base} from [ ${list(rule.sourceZones)} ]`);
    lines.push(`${base} to [ ${list(rule.destZones)} ]`);
    lines.push(`${base} source [ ${list(rule.sources)} ]`);
    lines.push(`${base} destination [ ${list(rule.destinations)} ]`);
    lines.push(`${base} service [ ${list(rule.services)} ]`);
    if (rule.applications.length) {
      lines.push(`${base} application [ ${rule.applications.map(q).join(" ")} ]`);
    } else {
      lines.push(`${base} application any`);
    }
    // PAN-OS action vocabulary: allow / deny / drop / reset-client(reject).
    const action =
      rule.action === "reject" ? "reset-client" : rule.action;
    lines.push(`${base} action ${action}`);
    lines.push(`${base} log-end ${rule.log ? "yes" : "no"}`);
    if (rule.disabled) lines.push(`${base} disabled yes`);
    for (const prof of rule.profiles) {
      lines.push(`${base} profile-setting group ${q(prof)}`);
    }
    if (rule.description) lines.push(`${base} description ${q(rule.description)}`);
  }

  // ----- NAT rules -----
  lines.push("");
  lines.push("# --- NAT policy ---");
  for (const nat of ir.nat) {
    const base = `set rulebase nat rules ${q(nat.name)}`;
    if (nat.sourceZone) lines.push(`${base} from ${q(nat.sourceZone)}`);
    if (nat.destZone) lines.push(`${base} to ${q(nat.destZone)}`);
    lines.push(
      `${base} source [ ${nat.originalSource.length ? nat.originalSource.map(q).join(" ") : "any"} ]`,
    );
    lines.push(
      `${base} destination [ ${nat.originalDest.length ? nat.originalDest.map(q).join(" ") : "any"} ]`,
    );
    if (nat.service) lines.push(`${base} service ${q(nat.service)}`);
    else lines.push(`${base} service any`);

    if (nat.type === "source" && nat.translatedSource) {
      lines.push(
        `${base} source-translation dynamic-ip-and-port translated-address ${q(nat.translatedSource)}`,
      );
    }
    if (nat.type === "destination" && nat.translatedDest) {
      lines.push(`${base} destination-translation translated-address ${q(nat.translatedDest)}`);
      if (nat.translatedPort) {
        lines.push(`${base} destination-translation translated-port ${nat.translatedPort}`);
      }
    }
    if (nat.type === "static" && nat.translatedSource) {
      lines.push(
        `${base} source-translation static-ip translated-address ${q(nat.translatedSource)}`,
      );
      if (nat.bidirectional) {
        lines.push(`${base} source-translation static-ip bi-directional yes`);
      }
    }
    if (nat.disabled) lines.push(`${base} disabled yes`);
    if (nat.description) lines.push(`${base} description ${q(nat.description)}`);
  }

  // ----- VPN (skeleton; PSK supplied out-of-band by reference) -----
  if (ir.vpn.length) {
    lines.push("");
    lines.push("# --- VPN (IKE/IPSec skeleton) ---");
    for (const tun of ir.vpn) {
      lines.push(`# tunnel ${q(tun.name)} (${tun.kind}, ${tun.ikeVersion})`);
      if (tun.peerAddress) {
        lines.push(`set network ike gateway ${q(tun.name)} peer-address ip ${q(tun.peerAddress)}`);
      }
      lines.push(`set network ike gateway ${q(tun.name)} protocol-common version ${tun.ikeVersion}`);
      lines.push(
        `# phase1: enc=${tun.phase1.encryption.join("/")} hash=${tun.phase1.hash.join("/")} dh=${tun.phase1.dhGroup.join("/")}`,
      );
      lines.push(
        `# phase2: enc=${tun.phase2.encryption.join("/")} hash=${tun.phase2.hash.join("/")}`,
      );
      lines.push(`# PSK supplied by reference: ${tun.pskRef ?? "(none)"} — never rendered in plaintext`);
    }
  }

  lines.push("");
  lines.push("# End of generated configuration.");
  return lines.join("\n");
}
