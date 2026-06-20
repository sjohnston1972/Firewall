#!/usr/bin/env node
/**
 * Bastion relay agent (CLAUDE.md §4.2, Phase 6).
 *
 * Runs on-site, deep inside a private network where the firewall mgmt endpoint
 * is NOT reachable from the internet. It dials OUTBOUND over WSS to the session's
 * Durable Object — firewalls allow outbound by default, so no inbound holes are
 * opened. The Durable Object then shuttles vendor-API requests across this link;
 * the agent performs them against the local mgmt IP and returns the response.
 *
 * Usage:
 *   node relay-agent.mjs \
 *     --url wss://bastion.clydeford.net/api/relay/<session-token> \
 *     --device https://10.0.0.1            # local mgmt base URL
 *
 * The token is the session id (single-user app). The agent never stores creds —
 * it only forwards bytes between the DO and the local device.
 *
 * Requires Node 18+ (global fetch + WebSocket). No npm dependencies.
 */

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const WS_URL = arg("url");
const DEVICE_BASE = arg("device");
// Firewall management planes almost always present a self-signed certificate.
// The whole point of the on-site agent is that IT can reach them (unlike the
// Worker), so we skip TLS verification on the device side by default. Pass
// --secure to enforce verification.
const SECURE = flag("secure");
if (!SECURE) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

if (!WS_URL || !DEVICE_BASE) {
  console.error(
    "usage: node relay-agent.mjs --url wss://.../api/relay/<session-id> --device https://<mgmt-ip> [--secure]",
  );
  process.exit(1);
}
console.log(`[relay] device=${DEVICE_BASE} tls-verify=${SECURE ? "on" : "off (self-signed ok)"}`);

function connect() {
  console.log(`[relay] connecting to ${WS_URL}`);
  const ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => console.log("[relay] connected — awaiting requests"));

  ws.addEventListener("message", async (ev) => {
    let frame;
    try {
      frame = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    const { id, request } = frame;
    if (!id || !request) return;
    try {
      const url = DEVICE_BASE.replace(/\/$/, "") + request.path;
      const res = await fetch(url, {
        method: request.method,
        headers: request.headers || {},
        body: request.body ?? undefined,
      });
      const body = await res.text();
      const headers = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      ws.send(JSON.stringify({ id, response: { status: res.status, headers, body } }));
    } catch (err) {
      ws.send(JSON.stringify({ id, error: String(err?.message ?? err) }));
    }
  });

  ws.addEventListener("close", () => {
    console.log("[relay] disconnected — reconnecting in 3s");
    setTimeout(connect, 3000);
  });
  ws.addEventListener("error", (e) => console.error("[relay] error", e?.message ?? e));
}

connect();
