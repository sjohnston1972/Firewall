/**
 * ProxyContainer — a per-session Cloudflare Container (CLAUDE.md transport layer).
 *
 * The Worker's fetch can't disable TLS verification, so it can't reach a firewall
 * whose mgmt plane uses a self-signed cert. This container can. It runs the tiny
 * proxy in container/server.mjs and the SessionDO routes device API calls through
 * it. Ephemeral: it sleeps after inactivity and is billed only while awake.
 */
import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

export class ProxyContainer extends Container<Env> {
  // Matches EXPOSE/PORT in container/Dockerfile + server.mjs.
  override defaultPort = 8080;
  // Spin the container down after a short idle window (ephemeral / cost control).
  override sleepAfter = "5m";
}
