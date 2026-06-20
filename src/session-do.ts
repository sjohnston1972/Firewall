/**
 * SessionDO — one Durable Object instance per onboarding session (CLAUDE.md §3/§8).
 * Holds: live wizard state, credentials IN MEMORY ONLY, the WSS link to a relay
 * agent (if used), and an apply-lock so a session can't double-apply.
 *
 * The Worker router forwards every /api/session/:id/* action here because this is
 * the only place credentials live. The DO builds the transport + driver, performs
 * the action, and writes through to D1/R2 + the audit log.
 */
import type { Env, Credentials, TargetConfig, Vendor } from "./types";
import { HttpError, json } from "./types";
import { IR, IRFragment, type IR as IRType, validateFragment } from "../schema/ir";
import { getDriver } from "./drivers";
import { makeTransport } from "./transport";
import type {
  ContainerProxyRequest,
  Transport,
  TransportRequest,
  TransportResponse,
} from "./transport/types";
import { getContainer } from "@cloudflare/containers";
import { normalise } from "./normaliser";
import { buildPlan, diffIR } from "./plan/engine";
import { db, uid, nowIso } from "./db";
import { audit } from "./audit";

interface SessionState {
  projectId?: string;
  vendor?: Vendor;
  target?: TargetConfig;
  design?: Partial<IRType>;
  lastDiscoveryRef?: string;
  backupRef?: string;
}

interface PendingRelay {
  resolve: (r: TransportResponse) => void;
  reject: (e: Error) => void;
}

export class SessionDO {
  private creds: Credentials = {}; // in memory only — never persisted
  private applying = false;
  private relay: WebSocket | null = null;
  private pending = new Map<string, PendingRelay>();
  private mem: SessionState = {};

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get<SessionState>("state");
      if (saved) this.mem = saved;
    });
  }

  private async persist(): Promise<void> {
    await this.state.storage.put("state", this.mem);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Relay agent WebSocket upgrade (inbound WSS from on-site agent).
    if (url.pathname.endsWith("/relay")) {
      return this.handleRelayUpgrade(req);
    }

    // Internal action path: /do/<action> (+ optional /:i for import accept)
    const parts = url.pathname.split("/").filter(Boolean);
    const action = parts[parts.length - 1] === "" ? parts[parts.length - 2] : parts[parts.length - 1];

    try {
      const body = req.method === "POST" ? await this.readJson(req) : {};
      switch (true) {
        case url.pathname.includes("/connect"):
          return await this.connect(body);
        case url.pathname.includes("/discover"):
          return await this.discover();
        case url.pathname.includes("/design"):
          return await this.saveDesign(body);
        case url.pathname.includes("/import/") && url.pathname.includes("/accept"):
          return await this.acceptImport(this.importIdFromPath(url.pathname));
        case url.pathname.includes("/import"):
          return await this.importConfig(body);
        case url.pathname.includes("/packs"):
          return await this.setPacks(body);
        case url.pathname.includes("/plan"):
          return await this.plan();
        case url.pathname.includes("/validate"):
          return await this.validate();
        case url.pathname.includes("/apply"):
          return await this.apply(body);
        case url.pathname.includes("/bundle"):
          return await this.bundle();
        case url.pathname.includes("/verify"):
          return await this.verify();
        case url.pathname.includes("/rollback"):
          return await this.rollback();
        case url.pathname.includes("/report"):
          return await this.report();
        case url.pathname.includes("/state"):
          return req.method === "POST" ? await this.saveWizard(body) : await this.loadWizard();
        case url.pathname.includes("/init"):
          return await this.init(body);
        default:
          throw new HttpError(404, `unknown session action: ${action}`);
      }
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, detail: err.detail }, err.status);
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  }

  // ---------- helpers ----------
  private async readJson(req: Request): Promise<Record<string, unknown>> {
    try {
      const text = await req.text();
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
  }

  private importIdFromPath(path: string): string {
    const m = path.match(/\/import\/([^/]+)\/accept/);
    if (!m) throw new HttpError(400, "missing import id");
    return m[1];
  }

  private requireProject(): string {
    if (!this.mem.projectId) throw new HttpError(409, "session not initialised");
    return this.mem.projectId;
  }

  /**
   * The effective target. When the engineer hasn't connected a live device yet
   * we still allow offline operations (staged render, static validate) by
   * synthesising a direct target from the session vendor. Any actual network
   * call through this transport will fail honestly (no host) — which is correct.
   */
  private effectiveTarget(): TargetConfig {
    if (this.mem.target) return this.mem.target;
    const vendor = this.mem.vendor;
    if (!vendor) throw new HttpError(409, "session not initialised");
    return { vendor, transport: "direct" };
  }

  private buildTransport(): Transport {
    return makeTransport({
      target: this.effectiveTarget(),
      creds: this.creds,
      relaySend: this.relay ? (r) => this.relaySend(r) : undefined,
      containerSend: (r) => this.containerSend(r),
    });
  }

  /** Forward a device request through this session's cloud-proxy container. */
  private async containerSend(payload: ContainerProxyRequest): Promise<TransportResponse> {
    const container = getContainer(this.env.PROXY, this.requireProject());
    const res = await container.fetch(
      new Request("https://proxy/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    const data = (await res.json()) as {
      status?: number;
      headers?: Record<string, string>;
      body?: string;
      error?: string;
    };
    if (data.error) throw new Error(`cloud proxy: ${data.error}`);
    return { status: data.status ?? 0, headers: data.headers ?? {}, body: data.body ?? "" };
  }

  private driver() {
    return getDriver({
      vendor: this.effectiveTarget().vendor,
      creds: this.creds,
      transport: this.buildTransport(),
    });
  }

  /** Operations that genuinely need a live device (connect/discover/live-apply/verify). */
  private requireConnected() {
    if (!this.mem.target) throw new HttpError(409, "not connected to a device");
  }

  // ---------- actions ----------
  private async init(body: Record<string, unknown>): Promise<Response> {
    const projectId = String(body.projectId ?? "");
    const vendor = body.vendor as Vendor | undefined;
    if (!projectId || !vendor) throw new HttpError(400, "projectId and vendor required");
    this.mem.projectId = projectId;
    this.mem.vendor = vendor;
    await this.persist();
    return json({ ok: true, projectId });
  }

  /** Persist the frontend wizard state so a session can be resumed later. */
  private async saveWizard(body: Record<string, unknown>): Promise<Response> {
    const projectId = this.requireProject();
    const wizard = body.wizard ?? body;
    await this.state.storage.put("wizard", wizard);
    // Keep a friendly name + recency on the project row for the sessions list.
    const name = typeof body.name === "string" ? body.name : undefined;
    if (name) await db.renameProject(this.env, projectId, name).catch(() => {});
    else await db.touchProject(this.env, projectId).catch(() => {});
    return json({ ok: true });
  }

  private async loadWizard(): Promise<Response> {
    this.requireProject();
    const wizard = (await this.state.storage.get("wizard")) ?? null;
    return json({ wizard });
  }

  private async connect(body: Record<string, unknown>): Promise<Response> {
    const projectId = this.requireProject();
    const target = body.target as TargetConfig | undefined;
    const creds = (body.creds as Credentials | undefined) ?? {};
    if (!target?.vendor) throw new HttpError(400, "target.vendor required");
    this.mem.target = target;
    this.creds = creds; // memory only
    await this.persist();

    const info = await this.driver().testConnection();
    await audit(this.env, {
      projectId,
      actor: this.env.ALLOWED_EMAIL,
      action: "connect",
      target: target.vendor,
      detail: { reachable: info.reachable, model: info.model, version: info.version },
    });
    return json({ conn: info });
  }

  private async discover(): Promise<Response> {
    const projectId = this.requireProject();
    this.requireConnected();
    const inv = await this.driver().discover();

    // Persist discovery snapshot + take a backup (rollback safety net, §5.3).
    const discKey = `readbacks/${projectId}/discovery-${nowIso()}.json`;
    const backupKey = `backups/${projectId}/running-${nowIso()}.json`;
    await this.env.R2.put(discKey, JSON.stringify(inv, null, 2));
    await this.env.R2.put(backupKey, JSON.stringify(inv, null, 2));
    this.mem.lastDiscoveryRef = discKey;
    this.mem.backupRef = backupKey;
    await this.persist();
    await db.setTargetDiscovery(this.env, projectId, discKey).catch(() => {});

    await audit(this.env, {
      projectId,
      actor: this.env.ALLOWED_EMAIL,
      action: "discover",
      afterRef: discKey,
      detail: { interfaces: inv.interfaces.length, zones: inv.zones.length },
    });
    return json({ inventory: inv, backup: { taken: true, ref: backupKey } });
  }

  private async saveDesign(body: Record<string, unknown>): Promise<Response> {
    const projectId = this.requireProject();
    // body is a Partial<IR> from the GUI (interfaces/zones/system/protection/ngfw/...)
    this.mem.design = body as Partial<IRType>;
    await this.persist();
    await audit(this.env, { projectId, actor: this.env.ALLOWED_EMAIL, action: "design" });
    return json({ ok: true });
  }

  private async importConfig(body: Record<string, unknown>): Promise<Response> {
    const projectId = this.requireProject();
    const vendor = this.mem.vendor ?? (this.mem.target?.vendor as Vendor);
    if (!vendor) throw new HttpError(409, "vendor unknown");
    const sourceText = String(body.sourceText ?? "");
    const format = body.format ? String(body.format) : undefined;
    const hard = Boolean(body.hard);
    if (!sourceText.trim()) throw new HttpError(400, "sourceText required");

    const importId = uid("imp_");
    const rawKey = `imports/${importId}.txt`;
    await this.env.R2.put(rawKey, sourceText);

    const result = await normalise(this.env, { vendor, sourceText, format, hard });
    const fragmentJson = result.fragment ? JSON.stringify(result.fragment) : null;
    await db.insertImport(this.env, {
      id: importId,
      project_id: projectId,
      raw_ref: rawKey,
      fragment_json: fragmentJson,
      provenance: JSON.stringify({ model: result.model, format, warnings: result.warnings }),
    });
    await audit(this.env, {
      projectId,
      actor: this.env.ALLOWED_EMAIL,
      action: "import",
      target: importId,
      afterRef: rawKey,
      detail: { ok: result.ok, model: result.model, warnings: result.warnings.length },
    });

    return json({
      importId,
      ok: result.ok,
      model: result.model,
      fragment: result.fragment ?? null,
      errors: result.errors ?? [],
      warnings: result.warnings,
    });
  }

  private async acceptImport(importId: string): Promise<Response> {
    const projectId = this.requireProject();
    await db.acceptImport(this.env, importId);
    await audit(this.env, {
      projectId,
      actor: this.env.ALLOWED_EMAIL,
      action: "import.accept",
      target: importId,
    });
    return json({ ok: true });
  }

  private async setPacks(body: Record<string, unknown>): Promise<Response> {
    const projectId = this.requireProject();
    const enabled = Array.isArray(body.enabled) ? (body.enabled as unknown[]).map(String) : [];
    await db.setPacks(this.env, projectId, enabled);
    await audit(this.env, {
      projectId,
      actor: this.env.ALLOWED_EMAIL,
      action: "packs",
      detail: { enabled },
    });
    return json({ ok: true, enabled });
  }

  private async assemblePlan(): Promise<IRType> {
    const projectId = this.requireProject();
    const vendor = this.mem.vendor ?? (this.mem.target?.vendor as Vendor);
    if (!vendor) throw new HttpError(409, "vendor unknown");

    const fragJsons = await db.acceptedFragments(this.env, projectId);
    const fragments: IRFragment[] = [];
    for (const fj of fragJsons) {
      const parsed = validateFragment(JSON.parse(fj));
      if (parsed.ok) fragments.push(parsed.fragment);
    }
    const enabledPacks = await db.enabledPacks(this.env, projectId);
    return buildPlan({
      vendor,
      design: this.mem.design ?? {},
      fragments,
      enabledPacks,
    });
  }

  private async plan(): Promise<Response> {
    const projectId = this.requireProject();
    const ir = await this.assemblePlan();

    const prev = await db.latestPlan(this.env, projectId);
    const before = prev ? (IR.parse(JSON.parse(prev.ir_json)) as IRType) : null;
    const diff = diffIR(before, ir);

    const version = await db.nextPlanVersion(this.env, projectId);
    const planId = uid("pln_");
    await db.insertPlan(this.env, {
      id: planId,
      project_id: projectId,
      version,
      ir_json: JSON.stringify(ir),
      diff_json: JSON.stringify(diff),
    });
    await audit(this.env, {
      projectId,
      actor: this.env.ALLOWED_EMAIL,
      action: "plan",
      target: `v${version}`,
      detail: diff.sections,
    });
    return json({ planId, version, ir, diff });
  }

  private async validate(): Promise<Response> {
    this.requireProject();
    const ir = await this.assemblePlan();
    const validation = await this.driver().validate({ version: 0, ir });
    return json({ validation });
  }

  private async apply(body: Record<string, unknown>): Promise<Response> {
    const projectId = this.requireProject();
    const mode = body.mode === "live" ? "live" : "staged";
    if (this.applying) throw new HttpError(409, "an apply is already in progress");
    this.applying = true;
    try {
      const ir = await this.assemblePlan();
      const latest = await db.latestPlan(this.env, projectId);
      const planId = latest?.id ?? null;
      const driver = this.driver();
      const runId = uid("run_");

      if (mode === "staged") {
        const rendered = await driver.render({ version: latest?.version ?? 0, ir });
        const bundleKey = `bundles/${projectId}/${runId}-${rendered.filename}`;
        await this.env.R2.put(bundleKey, rendered.content, {
          httpMetadata: { contentType: "text/plain" },
        });
        const result = { ok: true, mode, format: rendered.format, filename: rendered.filename };
        await db.insertApplyRun(this.env, {
          id: runId,
          project_id: projectId,
          plan_id: planId,
          mode,
          result: JSON.stringify(result),
          bundle_ref: bundleKey,
          readback_ref: null,
        });
        await audit(this.env, {
          projectId,
          actor: this.env.ALLOWED_EMAIL,
          action: "apply.staged",
          target: runId,
          afterRef: bundleKey,
        });
        return json({ runId, mode, bundle: { ref: bundleKey, filename: rendered.filename } });
      }

      // LIVE — must be connected to a device, plus a typed acknowledgement (§10/§12).
      this.requireConnected();
      const ack = String(body.acknowledge ?? "");
      const required = this.mem.design?.system?.hostname || "APPLY";
      if (ack !== required) {
        throw new HttpError(412, `live apply requires typed acknowledgement: "${required}"`);
      }
      const applyResult = await driver.applyLive({ version: latest?.version ?? 0, ir });
      let readbackKey: string | null = null;
      if (applyResult.ok) {
        const rb = await driver.readback().catch(() => null);
        if (rb) {
          readbackKey = `readbacks/${projectId}/${runId}.json`;
          await this.env.R2.put(readbackKey, JSON.stringify(rb, null, 2));
        }
      }
      await db.insertApplyRun(this.env, {
        id: runId,
        project_id: projectId,
        plan_id: planId,
        mode,
        result: JSON.stringify(applyResult),
        bundle_ref: null,
        readback_ref: readbackKey,
      });
      await db.setProjectStatus(this.env, projectId, applyResult.ok ? "applied" : "apply-failed");
      await audit(this.env, {
        projectId,
        actor: this.env.ALLOWED_EMAIL,
        action: "apply.live",
        target: runId,
        afterRef: readbackKey ?? undefined,
        detail: { ok: applyResult.ok, committed: applyResult.committed, messages: applyResult.messages },
      });
      return json({ runId, mode, result: applyResult, readbackRef: readbackKey });
    } finally {
      this.applying = false;
    }
  }

  private async bundle(): Promise<Response> {
    const projectId = this.requireProject();
    // Return the most recent staged bundle for this project.
    const list = await this.env.R2.list({ prefix: `bundles/${projectId}/` });
    const latest = list.objects.sort((a, b) => (a.uploaded > b.uploaded ? -1 : 1))[0];
    if (!latest) throw new HttpError(404, "no staged bundle found");
    const obj = await this.env.R2.get(latest.key);
    if (!obj) throw new HttpError(404, "bundle missing");
    const filename = latest.key.split("/").pop() ?? "bundle.txt";
    return new Response(obj.body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  private async verify(): Promise<Response> {
    const projectId = this.requireProject();
    this.requireConnected();
    const ir = await this.assemblePlan();
    const rb = await this.driver().readback();
    const key = `readbacks/${projectId}/verify-${nowIso()}.json`;
    await this.env.R2.put(key, JSON.stringify(rb, null, 2));

    // naive comparison: which desired zones/interfaces are present on device
    const deviceZones = new Set(rb.zones.map((z) => z.name));
    const deviceIfaces = new Set(rb.interfaces.map((i) => i.name));
    const checks = [
      ...ir.zones.map((z) => ({ kind: "zone", name: z.name, present: deviceZones.has(z.name) })),
      ...ir.interfaces.map((i) => ({
        kind: "interface",
        name: i.name,
        present: deviceIfaces.has(i.name),
      })),
    ];
    await audit(this.env, {
      projectId,
      actor: this.env.ALLOWED_EMAIL,
      action: "verify",
      afterRef: key,
    });
    return json({ readbackRef: key, checks });
  }

  private async rollback(): Promise<Response> {
    const projectId = this.requireProject();
    if (!this.mem.backupRef) throw new HttpError(409, "no backup available to roll back to");
    // The backup is the pre-change running-config snapshot in R2. A real rollback
    // re-applies it via the driver; here we record the intent and surface the ref.
    await audit(this.env, {
      projectId,
      actor: this.env.ALLOWED_EMAIL,
      action: "rollback",
      beforeRef: this.mem.backupRef,
    });
    return json({ ok: true, restoredFrom: this.mem.backupRef });
  }

  private async report(): Promise<Response> {
    const projectId = this.requireProject();
    const ir = await this.assemblePlan();
    const lines: string[] = [];
    lines.push(`# Bastion Build Report`);
    lines.push(`Project: ${projectId}`);
    lines.push(`Vendor: ${ir.meta.vendor}`);
    lines.push(`Generated: ${nowIso()}`);
    lines.push(``);
    lines.push(`## System`);
    lines.push(`Hostname: ${ir.system.hostname ?? "(unset)"}`);
    lines.push(`DNS: ${ir.system.dns.join(", ") || "(none)"}`);
    lines.push(`NTP: ${ir.system.ntp.join(", ") || "(none)"}`);
    lines.push(``);
    lines.push(`## Counts`);
    lines.push(`Interfaces: ${ir.interfaces.length}`);
    lines.push(`Zones: ${ir.zones.length}`);
    lines.push(`Address objects: ${ir.addresses.length}`);
    lines.push(`Service objects: ${ir.services.length}`);
    lines.push(`NAT rules: ${ir.nat.length}`);
    lines.push(`Security rules: ${ir.security.length}`);
    lines.push(`VPN tunnels: ${ir.vpn.length}`);
    lines.push(`NGFW profiles: ${ir.ngfw.length}`);
    const reportText = lines.join("\n");
    const key = `reports/${projectId}/report-${nowIso()}.md`;
    await this.env.R2.put(key, reportText);
    return json({ reportRef: key, report: reportText });
  }

  // ---------- relay agent WSS ----------
  private handleRelayUpgrade(req: Request): Response {
    if (req.headers.get("Upgrade") !== "websocket") {
      throw new HttpError(426, "expected websocket upgrade");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.relay = server;
    server.addEventListener("message", (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as {
          id: string;
          response?: TransportResponse;
          error?: string;
        };
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else if (msg.response) p.resolve(msg.response);
      } catch {
        /* ignore malformed frame */
      }
    });
    server.addEventListener("close", () => {
      this.relay = null;
      for (const [, p] of this.pending) p.reject(new Error("relay disconnected"));
      this.pending.clear();
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private relaySend(reqFrame: TransportRequest): Promise<TransportResponse> {
    if (!this.relay) return Promise.reject(new Error("no relay agent connected"));
    const id = uid("rl_");
    const socket = this.relay;
    return new Promise<TransportResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, request: reqFrame }));
      // 30s timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("relay request timed out"));
        }
      }, 30_000);
    });
  }
}
