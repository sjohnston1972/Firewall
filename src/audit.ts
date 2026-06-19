/** Append-only audit log (CLAUDE.md §4.1/§8/§12). Every write path calls this. */
import type { Env } from "./types";
import { uid, nowIso } from "./db";

export interface AuditEntry {
  projectId?: string;
  actor: string;
  action: string;
  target?: string;
  beforeRef?: string;
  afterRef?: string;
  detail?: unknown;
}

export async function audit(env: Env, e: AuditEntry): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (id, project_id, actor, action, target, before_ref, after_ref, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        uid("aud_"),
        e.projectId ?? null,
        e.actor,
        e.action,
        e.target ?? null,
        e.beforeRef ?? null,
        e.afterRef ?? null,
        e.detail === undefined ? null : JSON.stringify(e.detail),
        nowIso(),
      )
      .run();
  } catch (err) {
    // Audit must never break the request path, but a failure is itself notable.
    console.error("audit write failed", err);
  }
}
