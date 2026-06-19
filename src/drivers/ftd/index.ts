/**
 * Cisco FTD driver via FMC REST (CLAUDE.md §4.3).
 *
 * API model: Firepower Management Center REST API. Auth uses a token obtained
 * from POST /api/fmc_platform/v1/auth/generatetoken (returns an
 * X-auth-access-token header). Config objects live under a domain UUID; staged
 * deploys are pushed to managed devices.
 *
 * render() emits a JSON representation of the intended FMC objects + access
 * rules derived from the IR. The IR -> device path contains ZERO AI.
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

export class FtdDriver implements FirewallDriver {
  readonly vendor: Vendor = "ftd";
  private readonly creds: Credentials;
  private readonly transport: Transport;
  private authToken?: string;
  private domainUuid?: string;

  constructor(ctx: DriverContext) {
    this.creds = ctx.creds;
    this.transport = ctx.transport;
    this.domainUuid = ctx.creds.fmcDomain;
  }

  /** Obtain an FMC auth token via Basic auth on generatetoken. */
  private async ensureToken(): Promise<string> {
    if (this.authToken) return this.authToken;
    const user = this.creds.username ?? "";
    const pass = this.creds.password ?? "";
    const basic = btoa(`${user}:${pass}`);
    const req: TransportRequest = {
      method: "POST",
      path: "/api/fmc_platform/v1/auth/generatetoken",
      headers: { authorization: `Basic ${basic}` },
      body: "",
    };
    const res = await this.transport.fetch(req);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`FMC token request failed: HTTP ${res.status}`);
    }
    const token = res.headers["x-auth-access-token"];
    if (!token) {
      throw new Error("FMC generatetoken returned no X-auth-access-token header");
    }
    this.authToken = token;
    // Default domain may be returned in a header as a comma-separated list.
    if (!this.domainUuid) {
      const domains = res.headers["domain_uuid"];
      if (domains) this.domainUuid = domains.split(",")[0];
    }
    return token;
  }

  private async getJson(path: string): Promise<unknown> {
    const token = await this.ensureToken();
    const res = await this.transport.fetch({
      method: "GET",
      path,
      headers: { "x-auth-access-token": token, accept: "application/json" },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`FMC GET ${path} failed: HTTP ${res.status}`);
    }
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new Error(`FMC GET ${path} returned non-JSON body`);
    }
  }

  async testConnection(): Promise<ConnInfo> {
    try {
      await this.ensureToken();
      // serverversion gives the FMC version/model.
      const data = (await this.getJson(
        "/api/fmc_platform/v1/info/serverversion",
      )) as {
        items?: Array<{ serverVersion?: string; vdbVersion?: string; model?: string }>;
      };
      const item = data.items?.[0] ?? {};
      return {
        reachable: true,
        model: item.model ?? "Cisco FMC",
        version: item.serverVersion,
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

    const dom = this.domainUuid ?? "default";

    // Security zones.
    try {
      const data = (await this.getJson(
        `/api/fmc_config/v1/domain/${dom}/object/securityzones?expanded=true`,
      )) as { items?: Array<{ name?: string; interfaces?: Array<{ name?: string }> }> };
      for (const z of data.items ?? []) {
        if (!z.name) continue;
        zones.push({
          name: z.name,
          interfaces: (z.interfaces ?? [])
            .map((i) => i.name)
            .filter((x): x is string => typeof x === "string"),
        });
      }
    } catch {
      // tolerate
    }

    // Network (host/subnet) objects.
    try {
      const data = (await this.getJson(
        `/api/fmc_config/v1/domain/${dom}/object/networkaddresses?expanded=true`,
      )) as { items?: Array<{ name?: string; value?: string }> };
      for (const a of data.items ?? []) {
        if (!a.name) continue;
        addressObjects.push({ name: a.name, value: a.value ?? "" });
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

    for (const rule of ir.security) {
      for (const z of [...rule.sourceZones, ...rule.destZones]) {
        if (!zoneNames.has(z)) {
          findings.push({
            severity: "warn",
            message: `Access rule "${rule.name}" references security zone "${z}" not in plan.`,
          });
        }
      }
      const anySrc = rule.sources.length === 0 || rule.sources.includes("any");
      const anyDst =
        rule.destinations.length === 0 || rule.destinations.includes("any");
      if (rule.action === "allow" && anySrc && anyDst) {
        findings.push({
          severity: "warn",
          message: `Access rule "${rule.name}" is any->any ALLOW — review before deploy.`,
        });
      }
    }

    const ok = !findings.some((f) => f.severity === "error");
    return Promise.resolve({ ok, findings });
  }

  render(plan: BuildPlan): Promise<RenderedConfig> {
    return Promise.resolve({
      format: "json",
      filename: "ftd-config.json",
      content: renderFtdJson(plan.ir),
    });
  }

  async applyLive(plan: BuildPlan): Promise<ApplyResult> {
    const messages: string[] = [];
    try {
      const token = await this.ensureToken();
      const dom = this.domainUuid ?? "default";
      let writes = 0;

      // Push network objects, then access rules into the default access policy.
      for (const addr of plan.ir.addresses) {
        const objType = addr.kind === "fqdn" ? "fqdns" : "networks";
        const body = JSON.stringify({
          name: addr.name,
          type: addr.kind === "fqdn" ? "FQDN" : "Network",
          value: addr.value,
        });
        const res = await this.transport.fetch({
          method: "POST",
          path: `/api/fmc_config/v1/domain/${dom}/object/${objType}`,
          headers: {
            "x-auth-access-token": token,
            "content-type": "application/json",
          },
          body,
        });
        if (res.status < 200 || res.status >= 300) {
          return {
            ok: false,
            committed: false,
            messages: [
              ...messages,
              `Network object "${addr.name}" write failed: HTTP ${res.status}`,
            ],
          };
        }
        writes++;
      }

      messages.push(`Created ${writes} object(s) in FMC.`);

      // FTD is deploy-staged: after object/policy writes, a deploy must be
      // triggered to push to managed devices.
      const deployRes = await this.transport.fetch({
        method: "POST",
        path: `/api/fmc_config/v1/domain/${dom}/deployment/deploymentrequests`,
        headers: {
          "x-auth-access-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "DeploymentRequest", forceDeploy: false }),
      });
      if (deployRes.status < 200 || deployRes.status >= 300) {
        return {
          ok: false,
          committed: false,
          messages: [...messages, `Deploy request failed: HTTP ${deployRes.status}`],
        };
      }

      let jobId: string | undefined;
      try {
        const parsed = JSON.parse(deployRes.body) as { taskId?: { id?: string } };
        jobId = parsed.taskId?.id;
      } catch {
        // tolerate non-JSON deploy response
      }

      messages.push(`Deploy requested${jobId ? ` (task ${jobId})` : ""}.`);
      return { ok: true, committed: true, jobId, messages };
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
// Deterministic FTD/FMC JSON renderer.
// ---------------------------------------------------------------------------

function renderFtdJson(ir: IR): string {
  const networkObjects = ir.addresses.map((a) => ({
    name: a.name,
    type: a.kind === "fqdn" ? "FQDN" : "Network",
    value: a.value,
  }));

  const portObjects = ir.services
    .filter((s) => s.protocol === "tcp" || s.protocol === "udp")
    .map((s) => ({
      name: s.name,
      type: "ProtocolPortObject",
      protocol: s.protocol.toUpperCase(),
      port: s.portRange
        ? `${s.portRange[0]}-${s.portRange[1]}`
        : s.ports.join(","),
    }));

  const securityZones = ir.zones.map((z) => ({
    name: z.name,
    type: "SecurityZone",
    interfaceMode: "ROUTED",
    interfaces: z.interfaces.map((i) => ({ name: i, type: "PhysicalInterface" })),
  }));

  const accessRules = ir.security.map((r) => ({
    name: r.name,
    type: "AccessRule",
    action: ftdAction(r.action),
    enabled: !r.disabled,
    sourceZones: r.sourceZones.map((z) => ({ name: z, type: "SecurityZone" })),
    destinationZones: r.destZones.map((z) => ({ name: z, type: "SecurityZone" })),
    sourceNetworks: anyOrNamed(r.sources),
    destinationNetworks: anyOrNamed(r.destinations),
    servicePorts: anyOrNamed(r.services),
    logBegin: r.log,
    logEnd: r.log,
    description: r.description,
  }));

  const natRules = ir.nat.map((n) => ({
    name: n.name,
    type: "FTDNatRule",
    natType: n.type === "source" ? "DYNAMIC" : "STATIC",
    sourceZone: n.sourceZone,
    destinationZone: n.destZone,
    originalSource: n.originalSource,
    originalDestination: n.originalDest,
    translatedSource: n.translatedSource,
    translatedDestination: n.translatedDest,
    translatedPort: n.translatedPort,
  }));

  const doc = {
    _meta: {
      generator: "bastion",
      vendor: ir.meta.vendor,
      irVersion: ir.meta.irVersion,
      note: "Intended FMC objects/rules derived from IR. Apply via FMC REST.",
    },
    system: {
      hostname: ir.system.hostname,
      dnsServers: ir.system.dns,
      ntpServers: ir.system.ntp,
    },
    securityZones,
    networkObjects,
    portObjects,
    accessRules,
    natRules,
  };

  return JSON.stringify(doc, null, 2);
}

function ftdAction(action: IR["security"][number]["action"]): string {
  switch (action) {
    case "allow":
      return "ALLOW";
    case "deny":
      return "BLOCK";
    case "drop":
      return "BLOCK";
    case "reject":
      return "BLOCK_RESET";
    default:
      return "BLOCK";
  }
}

function anyOrNamed(vals: string[]): { literal?: string; named: string[] } {
  if (vals.length === 0 || vals.includes("any")) {
    return { literal: "any", named: [] };
  }
  return { named: vals };
}
