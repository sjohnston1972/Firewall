/** API router (CLAUDE.md §9). Authenticates, then forwards session actions to the DO. */
import type { Env, Vendor } from "./types";
import { HttpError, json, VENDORS } from "./types";
import { db, uid } from "./db";
import { audit } from "./audit";
import { PACKS } from "./packs/catalogue";

/** Cloudflare Access injects the verified identity. Enforce single-user (§12). */
function authedEmail(req: Request, env: Env): string {
  const email = req.headers.get("Cf-Access-Authenticated-User-Email");
  if (email) {
    if (email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
      throw new HttpError(403, "forbidden");
    }
    return email;
  }
  // No Access header → local dev / direct. Allow, acting as the owner.
  if (env.ENVIRONMENT === "production") {
    // In production, Access should always be in front. Be strict.
    throw new HttpError(401, "authentication required");
  }
  return env.ALLOWED_EMAIL;
}

function doStub(env: Env, sessionId: string) {
  const id = env.SESSION.idFromName(sessionId);
  return env.SESSION.get(id);
}

/** Forward a session action to its DO, rewriting the path to /do/<action...>. */
async function forwardToDO(env: Env, sessionId: string, req: Request, action: string): Promise<Response> {
  const stub = doStub(env, sessionId);
  const url = new URL(req.url);
  const doUrl = `https://do/${action}${url.search}`;
  const init: RequestInit = { method: req.method, headers: { "content-type": "application/json" } };
  if (req.method === "POST") init.body = await req.text();
  return stub.fetch(new Request(doUrl, init));
}

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // ---- relay agent WSS: WS /api/relay/:token ----
  const relayMatch = path.match(/^\/api\/relay\/([^/]+)$/);
  if (relayMatch) {
    // token maps 1:1 to a session id in this single-user app.
    const sessionId = relayMatch[1];
    const stub = doStub(env, sessionId);
    return stub.fetch(new Request("https://do/relay", req));
  }

  const email = authedEmail(req, env);

  // ---- GET /api/packs : catalogue ----
  if (path === "/api/packs" && req.method === "GET") {
    return json({ packs: PACKS });
  }

  // ---- GET /api/sessions : list saved onboarding sessions ----
  if (path === "/api/sessions" && req.method === "GET") {
    const rows = await db.listProjects(env);
    return json({
      sessions: rows.map((r) => ({
        id: r.id,
        name: r.name,
        vendor: r.vendor,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  }

  // ---- POST /api/session : create ----
  if (path === "/api/session" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { name?: string; vendor?: string };
    const vendor = body.vendor as Vendor;
    if (!vendor || !VENDORS.includes(vendor)) {
      throw new HttpError(400, `vendor must be one of: ${VENDORS.join(", ")}`);
    }
    const projectId = uid("prj_");
    const name = (body.name || "Untitled onboarding").slice(0, 120);
    await db.createProject(env, { id: projectId, name, vendor });
    // initialise the DO
    const stub = doStub(env, projectId);
    await stub.fetch(
      new Request("https://do/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, vendor }),
      }),
    );
    await audit(env, { projectId, actor: email, action: "session.create", detail: { vendor, name } });
    return json({ id: projectId, name, vendor });
  }

  // ---- DELETE /api/session/:id : discard & delete a session ----
  const delMatch = path.match(/^\/api\/session\/([^/]+)$/);
  if (delMatch && req.method === "DELETE") {
    const sessionId = delMatch[1];
    const project = await db.getProject(env, sessionId);
    if (!project) return json({ ok: true }); // already gone — idempotent

    // R2 cleanup: project-prefixed objects + the (non-prefixed) raw imports.
    const prefixes = [
      `backups/${sessionId}/`,
      `bundles/${sessionId}/`,
      `readbacks/${sessionId}/`,
      `reports/${sessionId}/`,
    ];
    for (const prefix of prefixes) {
      const listed = await env.R2.list({ prefix });
      await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
    }
    const importRefs = await db.importRefs(env, sessionId);
    await Promise.all(importRefs.map((k) => env.R2.delete(k)));

    // Wipe the Durable Object's persisted + in-memory state.
    await doStub(env, sessionId)
      .fetch(new Request("https://do/wipe", { method: "POST" }))
      .catch(() => {});

    // Delete D1 rows (audit log preserved), then record the deletion.
    await db.deleteProjectData(env, sessionId);
    await audit(env, { projectId: sessionId, actor: email, action: "session.delete" });
    return json({ ok: true });
  }

  // ---- /api/session/:id/<action...> ----
  const sessMatch = path.match(/^\/api\/session\/([^/]+)\/(.+)$/);
  if (sessMatch) {
    const sessionId = sessMatch[1];
    const action = sessMatch[2]; // e.g. connect, discover, import/imp_x/accept, bundle
    // ensure project exists
    const project = await db.getProject(env, sessionId);
    if (!project) throw new HttpError(404, "session not found");
    return forwardToDO(env, sessionId, req, action);
  }

  throw new HttpError(404, "not found");
}
