/** D1 helpers (CLAUDE.md §8). Thin, typed wrappers; no ORM. */
import type { Env, Vendor } from "./types";

export function uid(prefix = ""): string {
  return prefix + crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface ProjectRow {
  id: string;
  name: string;
  vendor: Vendor;
  status: string;
  created_at: string;
  updated_at: string;
}

export const db = {
  async createProject(env: Env, p: { id: string; name: string; vendor: Vendor }): Promise<void> {
    const ts = nowIso();
    await env.DB.prepare(
      `INSERT INTO projects (id, name, vendor, status, created_at, updated_at)
       VALUES (?, ?, ?, 'created', ?, ?)`,
    )
      .bind(p.id, p.name, p.vendor, ts, ts)
      .run();
  },

  async getProject(env: Env, id: string): Promise<ProjectRow | null> {
    return env.DB.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<ProjectRow>();
  },

  async listProjects(env: Env): Promise<ProjectRow[]> {
    const res = await env.DB.prepare(
      `SELECT * FROM projects ORDER BY updated_at DESC LIMIT 100`,
    ).all<ProjectRow>();
    return res.results ?? [];
  },

  async renameProject(env: Env, id: string, name: string): Promise<void> {
    await env.DB.prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`)
      .bind(name.slice(0, 120), nowIso(), id)
      .run();
  },

  async touchProject(env: Env, id: string): Promise<void> {
    await env.DB.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  },

  async setProjectStatus(env: Env, id: string, status: string): Promise<void> {
    await env.DB.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(status, nowIso(), id)
      .run();
  },

  async upsertTarget(
    env: Env,
    t: { id: string; project_id: string; vendor: Vendor; transport: string; conn_meta: unknown },
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO targets (id, project_id, vendor, transport, conn_meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(t.id, t.project_id, t.vendor, t.transport, JSON.stringify(t.conn_meta ?? {}), nowIso())
      .run();
  },

  async setTargetDiscovery(env: Env, projectId: string, ref: string): Promise<void> {
    await env.DB.prepare(`UPDATE targets SET discovery_ref = ? WHERE project_id = ?`)
      .bind(ref, projectId)
      .run();
  },

  async nextPlanVersion(env: Env, projectId: string): Promise<number> {
    const row = await env.DB.prepare(
      `SELECT COALESCE(MAX(version), 0) AS v FROM plans WHERE project_id = ?`,
    )
      .bind(projectId)
      .first<{ v: number }>();
    return (row?.v ?? 0) + 1;
  },

  async insertPlan(
    env: Env,
    p: { id: string; project_id: string; version: number; ir_json: string; diff_json: string },
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO plans (id, project_id, version, ir_json, diff_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(p.id, p.project_id, p.version, p.ir_json, p.diff_json, nowIso())
      .run();
  },

  async latestPlan(
    env: Env,
    projectId: string,
  ): Promise<{ id: string; version: number; ir_json: string; diff_json: string } | null> {
    return env.DB.prepare(
      `SELECT id, version, ir_json, diff_json FROM plans WHERE project_id = ? ORDER BY version DESC LIMIT 1`,
    )
      .bind(projectId)
      .first();
  },

  async insertImport(
    env: Env,
    im: {
      id: string;
      project_id: string;
      raw_ref: string;
      fragment_json: string | null;
      provenance: string;
    },
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO imports (id, project_id, raw_ref, fragment_json, provenance, accepted, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
      .bind(im.id, im.project_id, im.raw_ref, im.fragment_json, im.provenance, nowIso())
      .run();
  },

  async acceptImport(env: Env, id: string): Promise<void> {
    await env.DB.prepare(`UPDATE imports SET accepted = 1 WHERE id = ?`).bind(id).run();
  },

  async acceptedFragments(env: Env, projectId: string): Promise<string[]> {
    const res = await env.DB.prepare(
      `SELECT fragment_json FROM imports WHERE project_id = ? AND accepted = 1 AND fragment_json IS NOT NULL`,
    )
      .bind(projectId)
      .all<{ fragment_json: string }>();
    return (res.results ?? []).map((r) => r.fragment_json);
  },

  async setPacks(env: Env, projectId: string, enabledIds: string[]): Promise<void> {
    const stmts = [
      env.DB.prepare(`DELETE FROM policy_packs WHERE project_id = ?`).bind(projectId),
      ...enabledIds.map((pid) =>
        env.DB
          .prepare(
            `INSERT INTO policy_packs (project_id, pack_id, enabled) VALUES (?, ?, 1)
             ON CONFLICT(project_id, pack_id) DO UPDATE SET enabled = 1`,
          )
          .bind(projectId, pid),
      ),
    ];
    await env.DB.batch(stmts);
  },

  async enabledPacks(env: Env, projectId: string): Promise<string[]> {
    const res = await env.DB.prepare(
      `SELECT pack_id FROM policy_packs WHERE project_id = ? AND enabled = 1`,
    )
      .bind(projectId)
      .all<{ pack_id: string }>();
    return (res.results ?? []).map((r) => r.pack_id);
  },

  async insertApplyRun(
    env: Env,
    r: {
      id: string;
      project_id: string;
      plan_id: string | null;
      mode: string;
      result: string;
      bundle_ref: string | null;
      readback_ref: string | null;
    },
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO apply_runs (id, project_id, plan_id, mode, result, bundle_ref, readback_ref, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        r.id,
        r.project_id,
        r.plan_id,
        r.mode,
        r.result,
        r.bundle_ref,
        r.readback_ref,
        nowIso(),
        nowIso(),
      )
      .run();
  },
};
