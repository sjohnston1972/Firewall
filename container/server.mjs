/**
 * Bastion cloud-proxy container.
 *
 * Runs inside a per-session Cloudflare Container. The Worker can't disable TLS
 * verification, but this is a full Node runtime that CAN — so it reaches firewall
 * management planes that present self-signed / untrusted certificates.
 *
 * Protocol: the Worker POSTs a JSON envelope to /fetch:
 *   { method, url, headers?, body? }
 * and gets back:
 *   { status, headers, body }            (target reached; target's status wrapped)
 *   { error }                            (the proxy itself could not reach the target)
 * The HTTP status of THIS response is always 200 unless the request was malformed.
 *
 * TLS verification is disabled here on purpose (mgmt planes are self-signed). The
 * container only reaches the single host the Worker tells it to, per request.
 */
import { createServer } from "node:http";
import { setGlobalDispatcher, Agent } from "undici";

// Self-signed mgmt certs are the norm — this container exists precisely to talk
// to them. (The Worker, which cannot do this, is what we're working around.)
// Belt: the env var. Suspenders: an explicit undici dispatcher that disables
// certificate verification for the global fetch (robust across runtimes).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));

const PORT = Number(process.env.PORT || 8080);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  // Health check for the platform.
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method !== "POST" || !req.url?.startsWith("/fetch")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  let envelope;
  try {
    envelope = JSON.parse((await readBody(req)) || "{}");
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON envelope" }));
    return;
  }

  const { method = "GET", url, headers = {}, body } = envelope;
  if (!url || typeof url !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "envelope.url required" }));
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const upstream = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await upstream.text();
    const outHeaders = {};
    upstream.headers.forEach((v, k) => (outHeaders[k] = v));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: upstream.status, headers: outHeaders, body: text }));
  } catch (err) {
    // undici hides the real reason under err.cause — surface it for diagnosis.
    const cause = err?.cause;
    const causeStr = cause
      ? ` [cause: ${cause.code ?? ""} ${cause.message ?? cause}]`.replace(/\s+/g, " ").trim()
      : "";
    const message = `proxy fetch failed: ${err?.message ?? String(err)}${causeStr ? " " + causeStr : ""}`;
    console.error(message, "->", url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT} (TLS verification disabled for targets)`);
});
