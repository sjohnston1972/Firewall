/**
 * Typed fetch client for the Bastion Worker API (CLAUDE.md §9).
 *
 * Every path here matches the documented API surface exactly. The UI is built
 * to render before a backend exists, so callers should expect these to reject
 * with `ApiError` and handle it with placeholder/empty states.
 */
import type {
  ApplyMode,
  ApplyResult,
  ConnInfo,
  Design,
  DeviceInventory,
  ImportFormat,
  ImportResult,
  PlanDiff,
  PolicyPack,
  Session,
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
    // Network failure / no backend yet — surface uniformly.
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

const json = (data: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(data),
});

// ---------- API surface (CLAUDE.md §9) ----------
export const api = {
  // POST /api/session
  createSession(vendor: Vendor): Promise<Session> {
    return request<Session>("/api/session", json({ vendor }));
  },

  // POST /api/session/:id/connect
  connect(id: string, target: TargetConfig): Promise<ConnInfo> {
    return request<ConnInfo>(`/api/session/${id}/connect`, json(target));
  },

  // POST /api/session/:id/discover
  discover(id: string): Promise<DeviceInventory> {
    return request<DeviceInventory>(`/api/session/${id}/discover`, json({}));
  },

  // POST /api/session/:id/design
  design(id: string, design: Design): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/session/${id}/design`, json(design));
  },

  // POST /api/session/:id/import
  import(
    id: string,
    payload: { format: ImportFormat; source: string },
  ): Promise<ImportResult> {
    return request<ImportResult>(`/api/session/${id}/import`, json(payload));
  },

  // POST /api/session/:id/import/:i/accept
  acceptImport(id: string, importId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/session/${id}/import/${importId}/accept`,
      json({ accepted: true }),
    );
  },

  // POST /api/session/:id/packs
  packs(
    id: string,
    enabled?: string[],
  ): Promise<{ packs: PolicyPack[] }> {
    return request<{ packs: PolicyPack[] }>(
      `/api/session/${id}/packs`,
      json(enabled ? { enabled } : {}),
    );
  },

  // POST /api/session/:id/plan
  plan(id: string, body?: unknown): Promise<PlanDiff> {
    return request<PlanDiff>(`/api/session/${id}/plan`, json(body ?? {}));
  },

  // POST /api/session/:id/validate
  validate(id: string): Promise<Validation> {
    return request<Validation>(`/api/session/${id}/validate`, json({}));
  },

  // POST /api/session/:id/apply
  apply(id: string, mode: ApplyMode): Promise<ApplyResult> {
    return request<ApplyResult>(`/api/session/${id}/apply`, json({ mode }));
  },

  // GET /api/session/:id/bundle  — returns the staged config bundle URL
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
  verify(id: string): Promise<VerifyResult> {
    return request<VerifyResult>(`/api/session/${id}/verify`, json({}));
  },

  // POST /api/session/:id/rollback
  rollback(id: string): Promise<{ ok: boolean; message?: string }> {
    return request<{ ok: boolean; message?: string }>(
      `/api/session/${id}/rollback`,
      json({}),
    );
  },

  // GET /api/session/:id/report  — generated build report (PDF)
  reportUrl(id: string): string {
    return `/api/session/${id}/report`;
  },
  report(id: string): Promise<Blob> {
    return fetch(`/api/session/${id}/report`).then((r) => {
      if (!r.ok) throw new ApiError("Report unavailable", r.status, null);
      return r.blob();
    });
  },
};
