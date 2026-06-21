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
  ApplyOptions,
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

  /**
   * Parse the `sw.dev.runtime.ifmon.port-states` system-state value, which lists
   * every PHYSICAL port the platform exposes (what the GUI shows even when the
   * port is unconfigured). Format:
   *   { 'ethernet1/1': { 'link': Down, 'type': RJ45, ... }, 'ethernet1/2': {...} }
   */
  private static parsePortStates(
    text: string,
  ): { name: string; link?: "up" | "down"; type?: string }[] {
    const out: { name: string; link?: "up" | "down"; type?: string }[] = [];
    const re = /'((?:ethernet|ae)[\d/]+)':\s*\{([^}]*)\}/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const body = m[2];
      const link = /'link':\s*Up/i.test(body)
        ? "up"
        : /'link':\s*Down/i.test(body)
          ? "down"
          : undefined;
      const type = PanosDriver.pick(body, /'type':\s*([A-Za-z0-9-]+)/i);
      out.push({ name: m[1], link, type });
    }
    return out;
  }

  /** Natural sort so ethernet1/2 precedes ethernet1/10. */
  private static ifaceSort(a: string, b: string): number {
    const na = a.match(/\d+/g)?.map(Number) ?? [];
    const nb = b.match(/\d+/g)?.map(Number) ?? [];
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      const d = (na[i] ?? 0) - (nb[i] ?? 0);
      if (d !== 0) return d;
    }
    return a.localeCompare(b);
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

  /** Push a config element via the config API (type=config&action=set). Edits
   *  land in the CANDIDATE config; the commit promotes them to running. */
  private async configSet(xpath: string, element: string): Promise<string> {
    const key = await this.ensureApiKey();
    const body =
      `type=config&action=set` +
      `&xpath=${encodeURIComponent(xpath)}` +
      `&element=${encodeURIComponent(element)}` +
      `&key=${encodeURIComponent(key)}`;
    const res = await this.transport.fetch({
      method: "POST",
      path: "/api/",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`PAN-OS set failed: HTTP ${res.status}`);
    }
    return res.body;
  }

  /** The config device-entry name (usually localhost.localdomain). */
  private async deviceName(): Promise<string> {
    try {
      const xml = await this.configGet("/config/devices/entry");
      return PanosDriver.pick(xml, /<entry\b[^>]*\bname="([^"]+)"/i) ?? "localhost.localdomain";
    } catch {
      return "localhost.localdomain";
    }
  }

  /** Cache of App-ID existence checks against the device's predefined catalogue. */
  private appCache = new Map<string, boolean>();

  /** Is `id` a real PAN-OS App-ID on this device? (cached predefined lookup) */
  private async appValid(id: string): Promise<boolean> {
    if (id === "any" || id === "application-default") return true;
    const cached = this.appCache.get(id);
    if (cached !== undefined) return cached;
    try {
      const xml = await this.op(
        `<show><predefined><xpath>/predefined/application/entry[@name='${id}']</xpath></predefined></show>`,
      );
      const ok = new RegExp(`name="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(xml);
      this.appCache.set(id, ok);
      return ok;
    } catch {
      // If we can't check, keep it — the device's commit will be the final judge.
      return true;
    }
  }

  /** Map + validate a rule's applications to real App-IDs; drop unknowns. */
  private async resolveApps(apps: string[]): Promise<{ apps: string[]; dropped: string[] }> {
    const out: string[] = [];
    const dropped: string[] = [];
    for (const raw of apps) {
      const id = aliasApp(raw);
      if (id === "any") return { apps: ["any"], dropped };
      if (await this.appValid(id)) out.push(id);
      else dropped.push(raw);
    }
    return { apps: out.length ? [...new Set(out)] : ["any"], dropped };
  }

  /**
   * Make an IR safe to commit on this device:
   *  - skip security/NAT rules that reference a zone not defined in the plan
   *    (so e.g. a guest-isolation pack without a guest zone still commits);
   *  - map/validate each rule's L7 applications to real App-IDs, dropping unknowns.
   * Everything skipped/changed is surfaced in `notes`.
   */
  private async sanitizeForDevice(ir: IR): Promise<{ ir: IR; notes: string[] }> {
    const notes: string[] = [];
    const zoneSet = new Set<string>([...ir.zones.map((z) => z.name), "any"]);

    const security = [];
    for (const r of ir.security) {
      const badZones = [...new Set([...r.sourceZones, ...r.destZones])].filter(
        (z) => !zoneSet.has(z),
      );
      if (badZones.length) {
        notes.push(`Rule "${r.name}": skipped — undefined zone(s) ${badZones.join(", ")}.`);
        continue;
      }
      if (!r.applications?.length) {
        security.push(r);
        continue;
      }
      const { apps, dropped } = await this.resolveApps(r.applications);
      if (dropped.length) {
        notes.push(
          `Rule "${r.name}": dropped invalid App-ID(s) ${dropped.join(", ")} → using ${apps.join(", ")}.`,
        );
      }
      security.push({ ...r, applications: apps });
    }

    const zoneIface = new Map<string, string>();
    for (const z of ir.zones) if (z.interfaces[0]) zoneIface.set(z.name, z.interfaces[0]);
    const ifaceHasIp = new Map<string, boolean>();
    for (const i of ir.interfaces) ifaceHasIp.set(i.name, i.addressing.mode !== "none");

    const nat = [];
    for (const n of ir.nat) {
      const badZones = [n.sourceZone, n.destZone].filter(
        (z): z is string => !!z && !zoneSet.has(z),
      );
      if (badZones.length) {
        notes.push(`NAT "${n.name}": skipped — undefined zone(s) ${badZones.join(", ")}.`);
        continue;
      }
      // Interface-based source-NAT needs the egress interface to carry an IP, or
      // the commit fails ("interface has no IP for source translation").
      if (n.type === "source" && n.translatedSource && isIfaceRef(n.translatedSource)) {
        const egress = isIfaceName(n.translatedSource)
          ? n.translatedSource
          : n.destZone
            ? zoneIface.get(n.destZone)
            : undefined;
        if (egress && ifaceHasIp.get(egress) === false) {
          notes.push(
            `NAT "${n.name}": skipped — egress interface ${egress} has no IP. Set DHCP or a static IP on the WAN (Design) to enable source-NAT.`,
          );
          continue;
        }
      }
      nat.push(n);
    }

    // VPN tunnels: the renderer only deploys NAT/ACL/objects/routes/hardening.
    // Flag VPN so it's transparent they need peer/PSK/tunnel-interface to apply.
    for (const v of ir.vpn) {
      notes.push(
        `VPN "${v.name}" (${v.kind}): not auto-deployed — provide peer address, PSK and a tunnel interface/zone to apply.`,
      );
    }

    return { ir: { ...ir, security, nat }, notes };
  }

  /** Commit the candidate config. Returns the raw XML (job id / status). */
  private async commitConfig(): Promise<string> {
    const key = await this.ensureApiKey();
    const body = `type=commit&cmd=${encodeURIComponent("<commit></commit>")}&key=${encodeURIComponent(key)}`;
    const res = await this.transport.fetch({
      method: "POST",
      path: "/api/",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`PAN-OS commit failed: HTTP ${res.status}`);
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
          link: state ? (/up/i.test(state) ? "up" : "down") : undefined,
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

    // Configured interfaces (config API). On freshly-built devices the ports
    // exist in the config (and show in the GUI) but aren't yet instantiated in
    // the dataplane, so `show interface all` returns 0. Read them from config and
    // merge so discovery reflects what the GUI shows.
    try {
      const xml = await this.configGet("/config/devices/entry/network/interface");
      const seen = new Set(interfaces.map((i) => i.name));
      const ethSection =
        PanosDriver.section(xml, "ethernet") +
        PanosDriver.section(xml, "aggregate-ethernet");
      // Find the opening tag of each physical/aggregate interface entry; the
      // block runs until the next such opening (subinterface/ip entries nest
      // inside and are skipped because their names don't match this pattern).
      const openRe = /<entry\b[^>]*\bname="(ethernet[\d/]+|ae\d+)"[^>]*>/gi;
      const opens: { name: string; openEnd: number; start: number }[] = [];
      let om: RegExpExecArray | null;
      while ((om = openRe.exec(ethSection)) !== null) {
        opens.push({ name: om[1], openEnd: openRe.lastIndex, start: om.index });
      }
      for (let i = 0; i < opens.length; i++) {
        const name = opens[i].name;
        if (seen.has(name)) continue;
        const blockEnd = i + 1 < opens.length ? opens[i + 1].start : ethSection.length;
        const block = ethSection.slice(opens[i].openEnd, blockEnd);
        const ip = PanosDriver.pick(block, /<ip>\s*<entry\b[^>]*\bname="([^"/]+\/\d+|[^"]+)"/i);
        const disabled = /<disabled>yes<\/disabled>/i.test(block);
        interfaces.push({
          name,
          enabled: !disabled,
          address: ip && ip !== "" ? ip : undefined,
          zone: undefined,
        });
        seen.add(name);
      }
    } catch {
      // tolerate
    }

    // Physical ports (system state). On a PA-VM the dataplane may not instantiate
    // ports (so `show interface all` is empty) yet the platform still exposes the
    // slots — this is exactly what the GUI lists. Merge any not already seen so
    // the engineer can design zones onto them.
    try {
      const xml = await this.op(
        "<show><system><state><filter>sw.dev.runtime.ifmon.port-states</filter></state></system></show>",
      );
      const seen = new Set(interfaces.map((i) => i.name));
      for (const p of PanosDriver.parsePortStates(xml)) {
        if (seen.has(p.name)) continue;
        interfaces.push({
          name: p.name,
          enabled: p.link === "up",
          link: p.link,
          hwType: p.type,
        });
        seen.add(p.name);
      }
    } catch {
      // tolerate
    }

    interfaces.sort((a, b) => PanosDriver.ifaceSort(a.name, b.name));

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

  async validate(plan: BuildPlan): Promise<Validation> {
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
        if (z !== "any" && !zoneNames.has(z)) {
          findings.push({
            severity: "warn",
            message: `Security rule "${rule.name}" references zone "${z}" not in the plan — it will be skipped on apply.`,
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

    // Validate L7 App-IDs against the device's predefined catalogue (best effort
    // — only when reachable). Flags app names the AI emitted that PAN won't accept.
    try {
      for (const rule of ir.security) {
        if (!rule.applications?.length) continue;
        const { dropped, apps } = await this.resolveApps(rule.applications);
        if (dropped.length) {
          findings.push({
            severity: "warn",
            message: `Security rule "${rule.name}": App-ID(s) ${dropped.join(", ")} are not valid on this device — they'll be mapped/dropped to ${apps.join(", ")} on apply.`,
          });
        }
      }
    } catch {
      // device unreachable for app validation — skip (apply still sanitizes)
    }

    const ok = !findings.some((f) => f.severity === "error");
    return { ok, findings };
  }

  render(plan: BuildPlan): Promise<RenderedConfig> {
    const content = renderPanosSet(plan.ir);
    return Promise.resolve({
      format: "set",
      filename: "panos-config.txt",
      content,
    });
  }

  async applyLive(plan: BuildPlan, opts?: ApplyOptions): Promise<ApplyResult> {
    const commit = opts?.commit !== false; // default: push + commit
    const messages: string[] = [];
    try {
      await this.ensureApiKey();
      const dev = await this.deviceName();

      // Make the IR safe to commit: drop rules with undefined zones, and
      // validate/repair L7 App-IDs against the device (the AI's app names are
      // intent, not gospel — e.g. "office365" -> "ms-office365-base").
      const sani = await this.sanitizeForDevice(plan.ir);
      sani.notes.forEach((n) => messages.push(n));

      // Push each config section via the config API (action=set). These land in
      // the CANDIDATE config; the commit (if requested) promotes them to running.
      const ops = renderPanosElements(sani.ir, dev);
      if (ops.length === 0) {
        return { ok: false, committed: false, messages: ["Nothing to push — the plan is empty."] };
      }
      for (const op of ops) {
        const res = await this.configSet(op.xpath, op.element);
        const status = PanosDriver.pick(res, /status="([^"]+)"/i);
        if (!status || status.toLowerCase() !== "success") {
          const msg = PanosDriver.pick(res, /<msg>([\s\S]*?)<\/msg>/i) ?? res.slice(0, 200);
          return {
            ok: false,
            committed: false,
            messages: [...messages, `Push of ${op.label} failed: ${msg}`],
          };
        }
        messages.push(`Pushed ${op.label}.`);
      }

      // Push-only mode: leave the candidate for the engineer to commit on-box.
      if (!commit) {
        return {
          ok: true,
          committed: false,
          messages: [
            ...messages,
            "Candidate configuration staged on the device. Review and commit on the firewall to activate.",
          ],
        };
      }

      // Commit.
      const commitRes = await this.commitConfig();
      const cStatus = PanosDriver.pick(commitRes, /status="([^"]+)"/i);
      const jobId = PanosDriver.pick(commitRes, /<job>([^<]+)<\/job>/i);
      const cMsg = PanosDriver.pick(commitRes, /<msg>([\s\S]*?)<\/msg>/i);
      // PAN returns a <job> id on accepted commits; "no changes" returns a msg, no job.
      if (!jobId) {
        if (cMsg && /no changes/i.test(cMsg)) {
          return { ok: true, committed: true, messages: [...messages, "No changes to commit."] };
        }
        return {
          ok: false,
          committed: false,
          messages: [...messages, `Commit rejected${cMsg ? `: ${cMsg}` : ""}`],
        };
      }
      if (cStatus && cStatus.toLowerCase() !== "success") {
        return {
          ok: false,
          committed: false,
          jobId,
          messages: [...messages, `Commit rejected${cMsg ? `: ${cMsg}` : ""}`],
        };
      }
      messages.push(`Commit submitted (job ${jobId}).`);
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

// ---------------------------------------------------------------------------
// Config-API element renderer — turns the IR into (xpath, element) set ops that
// PAN-OS accepts via type=config&action=set. This is the LIVE push path (the
// `set` CLI block above is for the staged/download bundle only). Verified
// against PAN-OS 11.2 — action=set merges these into the candidate config.
// ---------------------------------------------------------------------------

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** PAN member list; defaults to `any` when empty. */
function members(arr: string[]): string {
  const list = arr.length ? arr : ["any"];
  return list.map((m) => `<member>${xmlEsc(m)}</member>`).join("");
}

/**
 * Free-text / loose application names -> verified PAN-OS App-IDs. The AI can't be
 * trusted to emit exact App-IDs (it produced "office365", which PAN rejects), so
 * we map the common ones deterministically. All targets below were verified to
 * exist on PAN-OS 11.2. Anything not aliased is validated live against the device
 * (see PanosDriver.resolveApps) and dropped if unknown.
 */
const APP_ALIASES: Record<string, string> = {
  http: "web-browsing", web: "web-browsing", "web-browsing": "web-browsing", browsing: "web-browsing",
  https: "ssl", ssl: "ssl", tls: "ssl",
  dns: "dns-base", "dns-base": "dns-base",
  ntp: "ntp-base", "ntp-base": "ntp-base",
  quic: "quic-base", "quic-base": "quic-base",
  ssh: "ssh", ping: "ping", icmp: "ping",
  ldap: "ldap", kerberos: "kerberos", radius: "radius",
  o365: "ms-office365-base", office365: "ms-office365-base", "ms-office365": "ms-office365-base",
  microsoft365: "ms-office365-base", m365: "ms-office365-base", "ms-office365-base": "ms-office365-base",
  teams: "ms-teams", "ms-teams": "ms-teams", "microsoft-teams": "ms-teams", "ms teams": "ms-teams",
  webex: "webex-base", "webex-base": "webex-base", "webex-meeting": "webex-base",
  zoom: "zoom-meeting", "zoom-meeting": "zoom-meeting",
  sharepoint: "sharepoint-online", "sharepoint-online": "sharepoint-online",
  outlook: "outlook-web-online", onedrive: "ms-onedrive-base",
};

/** Alias a single app name (pure; lowercased lookup, identity if unknown). */
function aliasApp(name: string): string {
  return APP_ALIASES[name.toLowerCase().trim()] ?? name.toLowerCase().trim();
}

/** Does this translated-source value mean "the egress interface address"? */
function isIfaceRef(s: string): boolean {
  return (
    s.toLowerCase() === "interface" ||
    /interface/i.test(s) ||
    /^(ethernet|ae|vlan|tunnel|loopback)[\d./]*$/i.test(s)
  );
}
/** A literal interface name (ethernet1/1, ae1, tunnel.1…). */
function isIfaceName(s: string): boolean {
  return /^(ethernet|ae|vlan|tunnel|loopback)[\d./]*$/i.test(s);
}

export interface PanosSetOp {
  label: string;
  xpath: string;
  element: string;
}

export function renderPanosElements(ir: IR, dev: string): PanosSetOp[] {
  const D = `/config/devices/entry[@name='${dev}']`;
  const V = `${D}/vsys/entry[@name='vsys1']`;
  const ops: PanosSetOp[] = [];

  // ----- system: hostname / dns / ntp -----
  const sys = ir.system;
  const sysParts: string[] = [];
  if (sys.hostname) sysParts.push(`<hostname>${xmlEsc(sys.hostname)}</hostname>`);
  if (sys.timezone) sysParts.push(`<timezone>${xmlEsc(sys.timezone)}</timezone>`);
  if (sys.dns.length) {
    const s = [
      sys.dns[0] ? `<primary>${xmlEsc(sys.dns[0])}</primary>` : "",
      sys.dns[1] ? `<secondary>${xmlEsc(sys.dns[1])}</secondary>` : "",
    ].join("");
    sysParts.push(`<dns-setting><servers>${s}</servers></dns-setting>`);
  }
  if (sys.ntp.length) {
    const ntp = (slot: string, addr: string) =>
      `<${slot}><ntp-server-address>${xmlEsc(addr)}</ntp-server-address></${slot}>`;
    let n = "";
    if (sys.ntp[0]) n += ntp("primary-ntp-server", sys.ntp[0]);
    if (sys.ntp[1]) n += ntp("secondary-ntp-server", sys.ntp[1]);
    sysParts.push(`<ntp-servers>${n}</ntp-servers>`);
  }
  if (sysParts.length) {
    ops.push({ label: "system", xpath: `${D}/deviceconfig/system`, element: sysParts.join("") });
  }

  // ----- management-plane hardening -----
  const mgmt = sys.management;
  ops.push({
    label: "mgmt service hardening",
    xpath: `${D}/deviceconfig/system/service`,
    element:
      `<disable-telnet>${mgmt.telnet ? "no" : "yes"}</disable-telnet>` +
      `<disable-http>${mgmt.httpPlain ? "no" : "yes"}</disable-http>` +
      `<disable-https>${mgmt.https ? "no" : "yes"}</disable-https>` +
      `<disable-ssh>${mgmt.ssh ? "no" : "yes"}</disable-ssh>`,
  });
  if (mgmt.allowedSources.length) {
    ops.push({
      label: "mgmt permitted-ip",
      xpath: `${D}/deviceconfig/system/permitted-ip`,
      element: mgmt.allowedSources.map((s) => `<entry name="${xmlEsc(s)}"/>`).join(""),
    });
  }
  if (mgmt.lockoutThreshold > 0) {
    ops.push({
      label: "admin lockout",
      xpath: `${D}/deviceconfig/setting/management`,
      element: `<admin-lockout><failed-attempts>${mgmt.lockoutThreshold}</failed-attempts><lockout-time>30</lockout-time></admin-lockout>`,
    });
  }

  // ----- interfaces (ethernet, layer3) -----
  const eth = ir.interfaces
    .filter((i) => /^ethernet/i.test(i.name))
    .map((i) => {
      let l3 = "";
      if (i.addressing.mode === "static") {
        l3 = `<ip><entry name="${xmlEsc(i.addressing.address)}"/></ip>`;
      } else if (i.addressing.mode === "dhcp") {
        l3 = "<dhcp-client><enable>yes</enable></dhcp-client>";
      }
      const comment = i.description ? `<comment>${xmlEsc(i.description)}</comment>` : "";
      return `<entry name="${xmlEsc(i.name)}"><layer3>${l3}</layer3>${comment}</entry>`;
    })
    .join("");
  if (eth) {
    ops.push({ label: "interfaces", xpath: `${D}/network/interface/ethernet`, element: eth });
  }

  // Default virtual-router — L3 interfaces are useless without one (commit warns
  // "interface has no virtual-router"). Bind every ethernet interface we configure
  // to a "default" VR. action=set merges, so an existing "default" VR is reused.
  const ethL3 = ir.interfaces.filter((i) => /^ethernet/i.test(i.name)).map((i) => i.name);
  if (ethL3.length) {
    const vrMembers = ethL3.map((n) => `<member>${xmlEsc(n)}</member>`).join("");
    ops.push({
      label: "virtual-router (default)",
      xpath: `${D}/network/virtual-router`,
      element: `<entry name="default"><interface>${vrMembers}</interface></entry>`,
    });
  }

  // ----- static routes (under the default VR) -----
  const routes = ir.routes
    .map((r) => {
      const nh = r.nexthop ? `<nexthop><ip-address>${xmlEsc(r.nexthop)}</ip-address></nexthop>` : "";
      const intf = r.interface ? `<interface>${xmlEsc(r.interface)}</interface>` : "";
      const metric = r.metric ? `<metric>${r.metric}</metric>` : "";
      return `<entry name="${xmlEsc(r.name)}"><destination>${xmlEsc(r.destination)}</destination>${nh}${intf}${metric}</entry>`;
    })
    .join("");
  if (routes) {
    ops.push({
      label: "static routes",
      xpath: `${D}/network/virtual-router/entry[@name='default']/routing-table/ip/static-route`,
      element: routes,
    });
  }

  // ----- address objects -----
  const addr = ir.addresses
    .map((a) => {
      const v =
        a.kind === "fqdn"
          ? `<fqdn>${xmlEsc(a.value)}</fqdn>`
          : `<ip-netmask>${xmlEsc(a.value)}</ip-netmask>`;
      return `<entry name="${xmlEsc(a.name)}">${v}</entry>`;
    })
    .join("");
  if (addr) ops.push({ label: "address objects", xpath: `${V}/address`, element: addr });

  // ----- service objects -----
  const svc = ir.services
    .filter((s) => s.protocol === "tcp" || s.protocol === "udp")
    .map((s) => {
      const ports = s.portRange ? `${s.portRange[0]}-${s.portRange[1]}` : s.ports.join(",");
      return `<entry name="${xmlEsc(s.name)}"><protocol><${s.protocol}><port>${xmlEsc(ports)}</port></${s.protocol}></protocol></entry>`;
    })
    .join("");
  if (svc) ops.push({ label: "service objects", xpath: `${V}/service`, element: svc });

  // ----- zone-protection profile (flood + packet-based; attached to zones) -----
  const prot = ir.protection;
  const zpParts: string[] = [];
  if (prot.floodProtection) {
    zpParts.push(
      "<flood>" +
        "<tcp-syn><enable>yes</enable></tcp-syn>" +
        "<udp><enable>yes</enable></udp>" +
        "<icmp><enable>yes</enable></icmp>" +
        "<icmpv6><enable>yes</enable></icmpv6>" +
        "<other-ip><enable>yes</enable></other-ip>" +
        "</flood>",
    );
  }
  if (prot.packetBasedAttackProtection) {
    zpParts.push(
      "<discard-overlapping-tcp-segment-mismatch>yes</discard-overlapping-tcp-segment-mismatch>" +
        "<discard-malformed-option>yes</discard-malformed-option>",
    );
  }
  const ZP_NAME = zpParts.length ? "bastion-zp" : "";
  if (ZP_NAME) {
    ops.push({
      label: "zone-protection profile",
      xpath: `${D}/network/profiles/zone-protection-profile`,
      element: `<entry name="${ZP_NAME}">${zpParts.join("")}</entry>`,
    });
  }

  // ----- zones (zone-protection profile attached when enabled) -----
  const zpRef = ZP_NAME ? `<zone-protection-profile>${ZP_NAME}</zone-protection-profile>` : "";
  const zones = ir.zones
    .map(
      (z) =>
        `<entry name="${xmlEsc(z.name)}"><network><layer3>${z.interfaces
          .map((m) => `<member>${xmlEsc(m)}</member>`)
          .join("")}</layer3>${zpRef}</network></entry>`,
    )
    .join("");
  if (zones) ops.push({ label: "zones", xpath: `${V}/zone`, element: zones });

  // ----- NGFW security-profile group, baked into every allow rule -----
  // Maps the IR's NGFW toggles to PAN's predefined profiles; if no NGFW config
  // is present we still apply a sensible baseline so allowed traffic is always
  // inspected. Uses predefined "default"/"strict" profiles (verified on device).
  const ng = ir.ngfw[0];
  const ngfwMembers: string[] = [];
  if (ng) {
    if (ng.antiMalware) ngfwMembers.push("<virus><member>default</member></virus>");
    if (ng.dnsSecurity) ngfwMembers.push("<spyware><member>strict</member></spyware>");
    if (ng.ips) ngfwMembers.push("<vulnerability><member>strict</member></vulnerability>");
    if (ng.urlFiltering) ngfwMembers.push("<url-filtering><member>default</member></url-filtering>");
    if (ng.sandboxing) ngfwMembers.push("<wildfire-analysis><member>default</member></wildfire-analysis>");
  } else {
    // No explicit NGFW config → bake in a baseline.
    ngfwMembers.push(
      "<virus><member>default</member></virus>",
      "<spyware><member>strict</member></spyware>",
      "<vulnerability><member>strict</member></vulnerability>",
      "<url-filtering><member>default</member></url-filtering>",
    );
  }
  const NGFW_GROUP = ngfwMembers.length ? "bastion-ngfw" : "";
  if (NGFW_GROUP) {
    ops.push({
      label: "NGFW profile group",
      xpath: `${V}/profile-group`,
      element: `<entry name="${NGFW_GROUP}">${ngfwMembers.join("")}</entry>`,
    });
  }

  // ----- security rules (allow rules get the NGFW group attached) -----
  const sec = ir.security
    .map((r) => {
      const action = r.action === "reject" ? "reset-client" : r.action; // allow|deny|drop
      const svcMembers =
        r.services.length && !(r.services.length === 1 && r.services[0] === "any")
          ? members(r.services)
          : "<member>application-default</member>";
      // NGFW profiles only inspect permitted traffic, so attach to allow rules.
      const profile =
        action === "allow" && NGFW_GROUP
          ? `<profile-setting><group><member>${NGFW_GROUP}</member></group></profile-setting>`
          : "";
      return (
        `<entry name="${xmlEsc(r.name)}">` +
        `<from>${members(r.sourceZones)}</from>` +
        `<to>${members(r.destZones)}</to>` +
        `<source>${members(r.sources)}</source>` +
        `<destination>${members(r.destinations)}</destination>` +
        `<application>${members(r.applications.map(aliasApp))}</application>` +
        `<service>${svcMembers}</service>` +
        `<action>${action}</action>` +
        profile +
        `<log-end>${r.log ? "yes" : "no"}</log-end>` +
        (r.disabled ? "<disabled>yes</disabled>" : "") +
        `</entry>`
      );
    })
    .join("");
  if (sec) ops.push({ label: "security rules", xpath: `${V}/rulebase/security/rules`, element: sec });

  // ----- NAT rules -----
  // Map a zone to its first interface, for interface-based SNAT ("to the WAN
  // interface address" -> dynamic-ip-and-port/interface-address).
  const zoneIface = new Map<string, string>();
  for (const z of ir.zones) if (z.interfaces[0]) zoneIface.set(z.name, z.interfaces[0]);

  const nat = ir.nat
    .map((n) => {
      let trans = "";
      if (n.type === "source" && n.translatedSource) {
        const ts = n.translatedSource;
        // Resolve interface-based SNAT to the egress (to-zone) interface.
        let iface = "";
        if (isIfaceName(ts)) iface = ts;
        else if (isIfaceRef(ts)) iface = n.destZone ? (zoneIface.get(n.destZone) ?? "") : "";
        if (iface) {
          trans =
            `<source-translation><dynamic-ip-and-port><interface-address>` +
            `<interface>${xmlEsc(iface)}</interface>` +
            `</interface-address></dynamic-ip-and-port></source-translation>`;
        } else {
          trans =
            `<source-translation><dynamic-ip-and-port><translated-address>` +
            `<member>${xmlEsc(ts)}</member>` +
            `</translated-address></dynamic-ip-and-port></source-translation>`;
        }
      } else if ((n.type === "destination" || n.type === "static") && n.translatedDest) {
        trans =
          `<destination-translation><translated-address>${xmlEsc(n.translatedDest)}</translated-address>` +
          (n.translatedPort ? `<translated-port>${n.translatedPort}</translated-port>` : "") +
          `</destination-translation>`;
      }
      return (
        `<entry name="${xmlEsc(n.name)}">` +
        `<from>${members(n.sourceZone ? [n.sourceZone] : [])}</from>` +
        `<to>${members(n.destZone ? [n.destZone] : [])}</to>` +
        `<source>${members(n.originalSource)}</source>` +
        `<destination>${members(n.originalDest)}</destination>` +
        `<service>${n.service ? xmlEsc(n.service) : "any"}</service>` +
        trans +
        (n.disabled ? "<disabled>yes</disabled>" : "") +
        `</entry>`
      );
    })
    .join("");
  if (nat) ops.push({ label: "NAT rules", xpath: `${V}/rulebase/nat/rules`, element: nat });

  return ops;
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

  // ----- NGFW security-profile group (baked into every allow rule) -----
  lines.push("");
  lines.push("# --- NGFW security profiles ---");
  const sng = ir.ngfw[0];
  const sgParts: string[] = [];
  if (sng ? sng.antiMalware : true) sgParts.push("virus default");
  if (sng ? sng.dnsSecurity : true) sgParts.push("spyware strict");
  if (sng ? sng.ips : true) sgParts.push("vulnerability strict");
  if (sng ? sng.urlFiltering : true) sgParts.push("url-filtering default");
  if (sng && sng.sandboxing) sgParts.push("wildfire-analysis default");
  const STAGED_NGFW = sgParts.length ? "bastion-ngfw" : "";
  for (const pg of sgParts) {
    const [type, val] = pg.split(" ");
    lines.push(`set profile-group ${STAGED_NGFW} ${type} ${val}`);
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
    // Bake the NGFW profile group into allow rules (profiles inspect permitted traffic).
    const profs = action === "allow" && STAGED_NGFW ? [STAGED_NGFW] : rule.profiles;
    for (const prof of profs) {
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
