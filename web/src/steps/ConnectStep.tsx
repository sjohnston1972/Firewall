import { useEffect, useState, type ReactNode } from "react";
import type { StepProps } from "../App";
import { api, ApiError } from "../api";
import { Card, CardBody } from "../components/Card";
import { Field } from "../components/Field";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import { StepShell } from "../components/StepShell";
import { VendorToggle } from "../components/VendorToggle";
import { TRANSPORTS, VENDORS, type Transport, type Vendor } from "../types";

interface ConnectStepProps extends StepProps {
  setVendor: (v: Vendor) => void;
}

export function ConnectStep({ state, patch, onNext, step, total, setVendor }: ConnectStepProps) {
  const { target } = state;
  const vendorMeta = VENDORS.find((v) => v.id === target.vendor)!;
  const isMeraki = vendorMeta.cloudManaged;

  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const setCred = (k: keyof typeof target.credentials, v: string) =>
    patch({ target: { ...target, credentials: { ...target.credentials, [k]: v } } });

  const setTransport = (t: Transport) => patch({ target: { ...target, transport: t } });

  // The relay agent needs a session id to dial. Mint one as soon as the relay
  // transport is chosen so the copy-paste command below is ready.
  useEffect(() => {
    if (target.transport === "relay" && !state.sessionId) {
      api
        .createSession(target.vendor)
        .then((s) => patch({ sessionId: s.id }))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.transport]);

  const deviceUrl = target.credentials.host
    ? /^https?:\/\//i.test(target.credentials.host)
      ? target.credentials.host
      : `https://${target.credentials.host}`
    : "https://<mgmt-ip>";
  const relayCmd =
    `node relay-agent.mjs --url wss://bastion.clydeford.net/api/relay/` +
    `${state.sessionId ?? "<session-id>"} --device ${deviceUrl}`;
  const copyCmd = async () => {
    try {
      await navigator.clipboard.writeText(relayCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const connected = state.conn?.ok === true;

  const testConnection = async () => {
    setError(null);
    setTesting(true);
    try {
      let sessionId = state.sessionId;
      if (!sessionId) {
        const session = await api.createSession(target.vendor);
        sessionId = session.id;
        patch({ sessionId });
      }
      const conn = await api.connect(sessionId, target);
      patch({ conn });
      if (!conn.ok) setError(conn.message ?? "Authentication failed.");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Connection test failed.";
      setError(msg);
      patch({ conn: null });
    } finally {
      setTesting(false);
    }
  };

  return (
    <StepShellLite
      step={step}
      total={total}
      onNext={onNext}
      nextDisabled={!connected}
      footerNote={connected ? "Connection verified" : "Test the connection to continue"}
    >
      <Card>
        <CardBody className="space-y-4">
          {/* Vendor */}
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="eyebrow">Vendor</span>
              <span className="font-mono text-[10px] text-ink-500">
                apply · {vendorMeta.applyModel}
              </span>
            </div>
            <VendorToggle value={target.vendor} onChange={setVendor} disabled={testing} />
          </div>

          {isMeraki ? (
            <div>
              <span className="eyebrow mb-2 block">Meraki Dashboard API · cloud-managed</span>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field
                  id="apiKey"
                  label="API key"
                  mono
                  type="password"
                  placeholder="••••••••••••"
                  value={target.credentials.apiKey ?? ""}
                  onChange={(e) => setCred("apiKey", e.target.value)}
                />
                <Field
                  id="orgId"
                  label="Organization ID"
                  mono
                  placeholder="123456"
                  value={target.credentials.orgId ?? ""}
                  onChange={(e) => setCred("orgId", e.target.value)}
                />
                <Field
                  id="networkId"
                  label="Network ID"
                  mono
                  placeholder="L_123456789"
                  value={target.credentials.networkId ?? ""}
                  onChange={(e) => setCred("networkId", e.target.value)}
                />
              </div>
            </div>
          ) : (
            <>
              {/* Transport — single compact row */}
              <div>
                <span className="eyebrow mb-2 block">Transport</span>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {TRANSPORTS.map((t) => {
                    const active = target.transport === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTransport(t.id)}
                        aria-pressed={active}
                        className={
                          "rounded-lg border px-2.5 py-1.5 text-left transition-all " +
                          (active
                            ? "border-accent bg-accent-soft/40"
                            : "border-ink-700 bg-ink-900/50 hover:border-ink-600")
                        }
                      >
                        <span
                          className={`block text-[13px] font-medium ${active ? "text-accent" : "text-slate-200"}`}
                        >
                          {t.label}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-tight text-ink-500">
                          {t.blurb}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Credentials — single row */}
              <div className="grid gap-3 sm:grid-cols-3">
                <Field
                  id="host"
                  label="Management host / IP"
                  mono
                  placeholder="10.0.0.1"
                  value={target.credentials.host ?? ""}
                  onChange={(e) => setCred("host", e.target.value)}
                />
                <Field
                  id="username"
                  label="Username"
                  mono
                  placeholder="admin"
                  value={target.credentials.username ?? ""}
                  onChange={(e) => setCred("username", e.target.value)}
                />
                <Field
                  id="password"
                  label="Password"
                  mono
                  type="password"
                  placeholder="••••••••"
                  value={target.credentials.password ?? ""}
                  onChange={(e) => setCred("password", e.target.value)}
                />
              </div>

              {target.transport === "tunnel" && (
                <Field
                  id="tunnelHostname"
                  label="Tunnel hostname"
                  mono
                  placeholder="fw-mgmt.example.cloudflareaccess.com"
                  value={target.tunnelHostname ?? ""}
                  onChange={(e) => patch({ target: { ...target, tunnelHostname: e.target.value } })}
                />
              )}

              {target.transport === "relay" && (
                <div className="rounded-lg border border-accent/30 bg-accent-soft/20 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium text-slate-200">On-site agent:</span>
                    <a
                      href="/relay-agent.mjs"
                      download="relay-agent.mjs"
                      className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent-soft/30 px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent-soft/50"
                    >
                      ↓ Download
                    </a>
                    <span className="text-[10px] text-ink-500">
                      run it on a host that reaches the device, then Test.
                    </span>
                  </div>
                  <div className="relative mt-1.5">
                    <code className="block overflow-x-auto whitespace-pre rounded bg-ink-950 px-2 py-1.5 pr-14 font-mono text-[10px] text-accent">
                      {relayCmd}
                    </code>
                    <button
                      type="button"
                      onClick={copyCmd}
                      className="absolute right-1 top-1 rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 hover:border-accent/50 hover:text-accent"
                    >
                      {copied ? "✓" : "Copy"}
                    </button>
                  </div>
                </div>
              )}

              {target.transport === "container" && (
                <p className="text-[10px] leading-relaxed text-ink-500">
                  <span className="text-slate-200">Cloud proxy:</span> a short-lived Cloudflare
                  container reaches self-signed mgmt planes on a public IP — no agent. Sleeps when
                  idle.
                </p>
              )}

              {target.transport === "direct" && (
                <p className="text-[10px] leading-relaxed text-ink-500">
                  <span className="text-slate-200">Direct</span> needs a public IP with a trusted
                  cert. Self-signed devices need Cloud proxy or the Relay agent.
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-ink-700 pt-3">
            <Button variant="primary" onClick={testConnection} loading={testing}>
              Test connection
            </Button>
            {state.conn && (
              <StatusBadge tone={connected ? "good" : "bad"} dot>
                {connected ? "authenticated" : "failed"}
              </StatusBadge>
            )}
            <span className="text-[11px] text-ink-500">
              Read-only · credentials live in session memory only.
            </span>
          </div>

          {error && (
            <div className="rounded-lg border border-bad/30 bg-bad/5 p-2.5 text-xs leading-relaxed text-bad">
              {error}
            </div>
          )}

          {/* Connect-timeout = packets silently dropped, almost always source-IP
              filtering (NSG / mgmt permitted-IPs). Point the user at the relay. */}
          {error && /timeout/i.test(error) && target.transport !== "relay" && (
            <div className="rounded-lg border border-warn/30 bg-warn/5 p-2.5 text-xs leading-relaxed text-ink-500">
              <span className="font-medium text-warn">Looks like a connect timeout.</span> The device
              dropped the connection rather than refusing it — usually the target is{" "}
              <span className="text-slate-200">source-IP filtered</span> (an Azure NSG or the firewall's
              own management permitted-IP list) that allows your location but not
              {target.transport === "container" ? " Cloudflare's container egress" : " this path"}.
              Run the <span className="text-slate-200">Relay agent</span> on a host the device already
              allows — it connects from that host's IP, so no allowlist change is needed.
              <button
                type="button"
                onClick={() => setTransport("relay")}
                className="ml-2 rounded border border-accent/40 bg-accent-soft/30 px-2 py-0.5 font-medium text-accent hover:bg-accent-soft/50"
              >
                Switch to Relay agent
              </button>
            </div>
          )}

          {connected && (
            <dl className="grid gap-px overflow-hidden rounded-lg border border-ink-700 bg-ink-700 sm:grid-cols-4">
              <ConnFact label="Model" value={state.conn?.model} />
              <ConnFact label="Version" value={state.conn?.version} />
              <ConnFact label="Serial" value={state.conn?.serial} />
              <ConnFact label="License" value={state.conn?.license} />
            </dl>
          )}
        </CardBody>
      </Card>
    </StepShellLite>
  );
}

function ConnFact({ label, value }: { label: string; value?: string }) {
  return (
    <div className="bg-ink-900 px-3 py-2.5">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 font-mono text-xs text-slate-200">{value ?? "—"}</dd>
    </div>
  );
}

// Local lightweight shell so ConnectStep keeps its own intro copy.
function StepShellLite(props: {
  step: number;
  total: number;
  onNext: () => void;
  nextDisabled?: boolean;
  footerNote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <StepShell
      step={props.step}
      total={props.total}
      eyebrow="Connect to target"
      title="Connect & authenticate"
      intro="Read-only: test auth and read model/licensing — nothing is written until you confirm a plan."
      onNext={props.onNext}
      nextDisabled={props.nextDisabled}
      footerNote={props.footerNote}
    >
      {props.children}
    </StepShell>
  );
}
