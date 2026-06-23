/**
 * Typed fetch client for the Bastion Worker API (CLAUDE.md §9).
 *
 * This layer is the ADAPTER between the SPA's wire types (web/src/types.ts) and
 * the backend's IR-shaped contract (the Durable Object). Requests are mapped to
 * what the backend expects; responses are mapped back to the UI's shapes. Keeping
 * this here means the step components never have to know the IR encoding.
 */
import type {
  ApplyMode,
  ApplyResult,
  ConnInfo,
  Credentials,
  Design,
  DeviceInventory,
  DiffLine,
  ImportFormat,
  ImportResult,
  NgfwSettings,
  PlanDiff,
  PlanSection,
  PolicyPack,
  ProtectionSettings,
  Session,
  SessionSummary,
  TargetConfig,
  Validation,
  VerifyResult,
  Vendor,
} from "./types";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new ApiError("Network unreachable", 0, cause);
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : null) ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, body);
  }

  return body as T;
}

const post = (data: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(data) });

// ---------- request mappers (UI shape -> backend shape) ----------

/** Map the UI credentials to the backend's Credentials (Meraki uses cloud keys). */
function mapCreds(vendor: Vendor, c: Credentials): Record<string, unknown> {
  if (vendor === "meraki") {
    return {
      merakiApiKey: c.apiKey,
      merakiOrgId: c.orgId,
      merakiNetworkId: c.networkId,
    };
  }
  return { host: c.host, username: c.username, password: c.password, apiKey: c.apiKey };
}

/** Build the backend Partial<IR> design payload from the UI design + toggles. */
function mapDesign(
  design: Design,
  ngfw?: NgfwSettings,
  protection?: ProtectionSettings,
): Record<string, unknown> {
  // LACP: member ethernet -> its aggregate (ae<n>).
  const memberToAe = new Map<string, string>();
  for (const ag of design.aggregates ?? [])
    for (const m of ag.members) memberToAe.set(m, ag.name);

  // Derive L3 interfaces from the zones, with addressing. Trailing spaces are
  // trimmed. "config" mode pulls the IP discovered from the device; WAN (untrust)
  // falls back to DHCP so source-NAT can commit/function.
  const ifaceZone = new Map<string, string>();
  for (const z of design.zones) for (const i of z.interfaces) ifaceZone.set(i, z.name);
  const zoneType = new Map(design.zones.map((z) => [z.name, z.type]));
  type Addr = { mode: "dhcp" } | { mode: "static"; address: string } | { mode: "none" };
  const resolveAddr = (name: string, zone: string): Addr => {
    const a = design.interfaceAddrs?.[name];
    const addr = a?.address?.trim();
    const mode = a?.mode ?? "config";
    if (mode === "dhcp") return { mode: "dhcp" };
    if (mode === "static") return addr ? { mode: "static", address: addr } : { mode: "none" };
    if (mode === "config" && addr) return { mode: "static", address: addr }; // pulled IP
    // no IP available → WAN defaults to DHCP, others to none
    return zoneType.get(zone) === "untrust" ? { mode: "dhcp" } : { mode: "none" };
  };

  const interfaces: Record<string, unknown>[] = [];
  // zone-assigned interfaces (standalone ethernets + ae bundles) — L3
  for (const [name, zone] of ifaceZone.entries()) {
    if (memberToAe.has(name)) continue; // a bundle member can't be an L3 zone iface
    const dh = design.interfaceDhcp?.[name];
    const dhcpServer =
      dh && dh.poolStart?.trim() && dh.poolEnd?.trim()
        ? {
            poolStart: dh.poolStart.trim(),
            poolEnd: dh.poolEnd.trim(),
            gateway: dh.gateway?.trim() || undefined,
            dns: (dh.dns ?? []).map((d) => d.trim()).filter(Boolean),
          }
        : undefined;
    interfaces.push({ name, enabled: true, zone, addressing: resolveAddr(name, zone), dhcpServer });
  }
  // Aggregate (ae<n>) interfaces that aren't mapped to a zone are still emitted,
  // so their LACP members reference a real aggregate (otherwise the push fails
  // with "aggregate-group aeN is not a valid reference").
  const emitted = new Set(interfaces.map((i) => i.name as string));
  for (const ag of design.aggregates ?? []) {
    if (!emitted.has(ag.name)) {
      interfaces.push({ name: ag.name, enabled: true, addressing: resolveAddr(ag.name, "") });
      emitted.add(ag.name);
    }
  }
  // LACP member ethernets — carry aggregate-group, no addressing/zone of their own
  for (const [member, aeName] of memberToAe.entries()) {
    interfaces.push({ name: member, enabled: true, aggregateGroup: aeName });
  }

  const ngfwProfiles =
    ngfw && Object.values(ngfw).some(Boolean)
      ? [{ name: "baseline", ...ngfw }]
      : [];

  return {
    system: {
      hostname: design.hostname,
      dns: design.dns,
      ntp: design.ntp,
      timezone: design.timezone,
      management: design.management,
    },
    interfaces,
    zones: design.zones.map((z) => ({ name: z.name, type: z.type, interfaces: z.interfaces })),
    routes: (design.routes ?? [])
      .filter((r) => r.name?.trim() && r.destination?.trim())
      .map((r) => ({
        name: r.name.trim(),
        destination: r.destination.trim(),
        nexthop: r.nexthop?.trim() || undefined,
        interface: r.interface?.trim() || undefined,
      })),
    ngfw: ngfwProfiles,
    protection: protection ?? undefined,
  };
}

// ---------- response mappers (backend shape -> UI shape) ----------

function mapConn(raw: unknown): ConnInfo {
  const c = (raw as { conn?: Record<string, unknown> })?.conn ?? {};
  const licenses = c.licenses as string[] | undefined;
  // The driver puts the real failure cause in `raw` on error — surface it.
  const rawMsg = typeof c.raw === "string" ? c.raw : undefined;
  return {
    ok: Boolean(c.reachable),
    model: c.model as string | undefined,
    version: c.version as string | undefined,
    serial: c.serial as string | undefined,
    license: licenses?.join(", "),
    haState: c.haState as string | undefined,
    message: c.reachable ? undefined : (rawMsg ?? "Device did not respond as reachable."),
  };
}

function mapInventory(raw: unknown): DeviceInventory {
  const r = raw as { inventory?: Record<string, unknown>; backup?: { ref?: string } };
  const inv = r.inventory ?? {};
  const addr = (inv.addressObjects as unknown[]) ?? [];
  const svc = (inv.serviceObjects as unknown[]) ?? [];
  return {
    interfaces: (inv.interfaces as DeviceInventory["interfaces"]) ?? [],
    zones: (inv.zones as DeviceInventory["zones"]) ?? [],
    routes: (inv.routes as DeviceInventory["routes"]) ?? [],
    objectCount: addr.length + svc.length,
    haState: inv.haState as string | undefined,
    backupRef: r.backup?.ref,
  };
}

const SECTION_TITLES: Record<string, string> = {
  interfaces: "Interfaces",
  zones: "Zones",
  addresses: "Address objects",
  services: "Service objects",
  nat: "NAT rules",
  security: "Security rules",
  vpn: "VPN tunnels",
  ngfw: "NGFW profiles",
  system: "System (hostname / DNS / NTP)",
  protection: "Zone protection / hardening",
};

interface BackendDiff {
  summary: string;
  sections: Record<string, { added: number; removed: number; changed: number }>;
  added: string[];
  removed: string[];
  changed: string[];
}

function mapPlan(raw: unknown): PlanDiff {
  const r = raw as { version?: number; diff?: BackendDiff };
  const diff = r.diff ?? { summary: "", sections: {}, added: [], removed: [], changed: [] };

  // Bucket the "section: name" lines back into their sections.
  const bySection = (list: string[], op: DiffLine["op"]): Record<string, DiffLine[]> => {
    const out: Record<string, DiffLine[]> = {};
    for (const entry of list) {
      const idx = entry.indexOf(":");
      const key = idx >= 0 ? entry.slice(0, idx).trim() : "other";
      const text = idx >= 0 ? entry.slice(idx + 1).trim() : entry;
      (out[key] ??= []).push({ op, text });
    }
    return out;
  };
  const adds = bySection(diff.added, "add");
  const rems = bySection(diff.removed, "remove");
  const chgs = bySection(diff.changed, "modify");

  const sections: PlanSection[] = Object.entries(diff.sections).map(([key, counts]) => ({
    key,
    title: SECTION_TITLES[key] ?? key,
    added: counts.added,
    modified: counts.changed,
    removed: counts.removed,
    lines: [...(adds[key] ?? []), ...(chgs[key] ?? []), ...(rems[key] ?? [])],
  }));

  const totalChanges = diff.added.length + diff.removed.length + diff.changed.length;
  return { version: r.version ?? 1, sections, totalChanges };
}

// ---------- API surface (CLAUDE.md §9) ----------
export const api = {
  // GET /api/sessions
  listSessions(): Promise<{ sessions: SessionSummary[] }> {
    return request<{ sessions: SessionSummary[] }>("/api/sessions");
  },

  // POST /api/session
  async createSession(vendor: Vendor, name?: string): Promise<Session> {
    const r = await request<{ id: string; name: string; vendor: Vendor }>(
      "/api/session",
      post({ vendor, name }),
    );
    return { id: r.id, vendor: r.vendor, status: "created", createdAt: new Date().toISOString() };
  },

  // DELETE /api/session/:id  — discard & delete a session (D1 + R2 + DO state)
  deleteSession(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/session/${id}`, { method: "DELETE" });
  },

  // GET/POST /api/session/:id/state  — save & resume wizard progress
  saveState(id: string, wizard: unknown, name?: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/session/${id}/state`, post({ wizard, name }));
  },
  loadState<T = unknown>(id: string): Promise<{ wizard: T | null }> {
    return request<{ wizard: T | null }>(`/api/session/${id}/state`);
  },

  // POST /api/session/:id/connect
  connect(id: string, target: TargetConfig): Promise<ConnInfo> {
    const payload = {
      target: {
        vendor: target.vendor,
        transport: target.transport,
        tunnelHostname: target.tunnelHostname,
        relayToken: target.relayToken,
      },
      creds: mapCreds(target.vendor, target.credentials),
    };
    return request<unknown>(`/api/session/${id}/connect`, post(payload)).then(mapConn);
  },

  // POST /api/session/:id/discover
  discover(id: string): Promise<DeviceInventory> {
    return request<unknown>(`/api/session/${id}/discover`, post({})).then(mapInventory);
  },

  // POST /api/session/:id/design
  design(
    id: string,
    design: Design,
    ngfw?: NgfwSettings,
    protection?: ProtectionSettings,
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/session/${id}/design`,
      post(mapDesign(design, ngfw, protection)),
    );
  },

  // POST /api/session/:id/import
  async import(
    id: string,
    payload: { format: ImportFormat; source: string },
  ): Promise<ImportResult> {
    const r = await request<{
      importId: string;
      ok: boolean;
      model?: string;
      fragment?: unknown;
      errors?: { path: string; message: string }[];
      warnings?: ImportResult["warnings"];
    }>(`/api/session/${id}/import`, post({ sourceText: payload.source, format: payload.format }));
    const after = r.ok
      ? JSON.stringify(r.fragment ?? {}, null, 2)
      : "Normalisation failed:\n" +
        (r.errors ?? []).map((e) => `• ${e.path}: ${e.message}`).join("\n");
    return {
      id: r.importId,
      format: payload.format,
      before: payload.source,
      after,
      warnings: r.warnings ?? [],
      accepted: false,
      model: r.model,
    };
  },

  // POST /api/session/:id/import/:i/accept
  acceptImport(id: string, importId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/session/${id}/import/${importId}/accept`, post({}));
  },

  // GET /api/packs  — the catalogue (returned with enabled:false for the UI)
  async packs(_id?: string): Promise<{ packs: PolicyPack[] }> {
    const r = await request<{ packs: Omit<PolicyPack, "enabled">[] }>("/api/packs");
    return { packs: r.packs.map((p) => ({ ...p, enabled: false })) };
  },

  // POST /api/session/:id/packs  — persist the enabled set
  setPacks(id: string, enabled: string[]): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/session/${id}/packs`, post({ enabled }));
  },

  // POST /api/session/:id/plan
  plan(id: string): Promise<PlanDiff> {
    return request<unknown>(`/api/session/${id}/plan`, post({})).then(mapPlan);
  },

  // POST /api/session/:id/validate
  validate(id: string): Promise<Validation> {
    return request<{ validation: Validation }>(`/api/session/${id}/validate`, post({})).then(
      (r) => r.validation,
    );
  },

  // POST /api/session/:id/apply
  async apply(id: string, mode: ApplyMode, acknowledge?: string): Promise<ApplyResult> {
    const r = await request<{
      runId: string;
      mode: ApplyMode;
      bundle?: { ref?: string; filename?: string };
      result?: { ok: boolean; committed: boolean; jobId?: string; messages: string[] };
    }>(`/api/session/${id}/apply`, post({ mode, acknowledge }));
    if (mode === "staged") {
      return { ok: true, mode, bundleRef: r.bundle?.ref };
    }
    return {
      ok: Boolean(r.result?.ok),
      mode,
      commitId: r.result?.jobId,
      committed: r.result?.committed,
      message: r.result?.messages?.join(" · "),
      messages: r.result?.messages,
    };
  },

  // GET /api/session/:id/bundle
  bundleUrl(id: string): string {
    return `/api/session/${id}/bundle`;
  },
  getBundle(id: string): Promise<Blob> {
    return fetch(`/api/session/${id}/bundle`).then((r) => {
      if (!r.ok) throw new ApiError("Bundle unavailable", r.status, null);
      return r.blob();
    });
  },

  // POST /api/session/:id/verify
  async verify(id: string): Promise<VerifyResult> {
    const r = await request<{ checks?: { kind: string; name: string; present: boolean }[] }>(
      `/api/session/${id}/verify`,
      post({}),
    );
    const checks = r.checks ?? [];
    return {
      ok: checks.every((c) => c.present),
      rows: checks.map((c) => ({
        item: `${c.kind} ${c.name}`,
        expected: "present",
        actual: c.present ? "present" : "absent",
        match: c.present,
      })),
    };
  },

  // POST /api/session/:id/rollback
  async rollback(id: string): Promise<{ ok: boolean; message?: string }> {
    const r = await request<{ ok: boolean; restoredFrom?: string }>(
      `/api/session/${id}/rollback`,
      post({}),
    );
    return { ok: r.ok, message: r.restoredFrom ? `Restored from ${r.restoredFrom}` : undefined };
  },

  // GET /api/session/:id/report  — markdown build report
  reportUrl(id: string): string {
    return `/api/session/${id}/report`;
  },
  async report(id: string): Promise<Blob> {
    const r = await request<{ report?: string }>(`/api/session/${id}/report`);
    return new Blob([r.report ?? "(empty report)"], { type: "text/markdown" });
  },
};
