/**
 * Bastion Worker entry. Serves the React SPA (ASSETS binding) and the /api/* surface.
 * A Worker is stateless; per-session state lives in the SessionDO (see session-do.ts).
 */
import type { Env } from "./types";
import { HttpError, json } from "./types";
import { handleApi } from "./router";

export { SessionDO } from "./session-do";
export { ProxyContainer } from "./container";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env);
      } catch (err) {
        if (err instanceof HttpError) {
          return json({ error: err.message, detail: err.detail }, err.status);
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error("api error", message);
        return json({ error: message }, 500);
      }
    }

    // Everything else: the SPA static assets (Vite build in /dist).
    return env.ASSETS.fetch(req);
  },
};
