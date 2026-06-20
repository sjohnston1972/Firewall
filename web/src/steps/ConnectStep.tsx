import { useEffect, useState, type ReactNode } from "react";
import type { StepProps } from "../App";
import { api, ApiError } from "../api";
import { Card, CardBody, CardHeader } from "../components/Card";
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
        <CardHeader
          eyebrow="Target platform"
          title="Choose the firewall vendor"
          description="The driver and the fields below change per platform. Meraki is cloud-managed — it asks for an API key instead of an IP and transport."
        />
        <CardBody>
          <VendorToggle value={target.vendor} onChange={setVendor} disabled={testing} />
          <p className="mt-3 font-mono text-[11px] text-ink-500">
            apply model · {vendorMeta.applyModel}
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow={isMeraki ? "Dashboard credentials" : "Connection"}
          title={isMeraki ? "Meraki Dashboard API" : "Reach the management plane"}
          description={
            isMeraki
              ? "Bastion talks to the Meraki cloud — no local IP or transport choice."
              : "Pick how the Worker reaches the device. Credentials live in session memory only and are never logged."
          }
        />
        <CardBody>
          {isMeraki ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="apiKey"
                label="API key"
                mono
                type="password"
                placeholder="••••••••••••••••"
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
                className="sm:col-span-2"
              />
            </div>
          ) : (
            <div className="space-y-5">
              {/* Transport selector */}
              <div>
                <span className="eyebrow mb-2 block">Transport</span>
                <div className="grid gap-2 sm:grid-cols-3">
                  {TRANSPORTS.map((t) => {
                    const active = target.transport === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTransport(t.id)}
                        aria-pressed={active}
                        className={
                          "rounded-lg border px-3 py-2.5 text-left transition-all " +
                          (active
                            ? "border-accent bg-accent-soft/40"
                            : "border-ink-700 bg-ink-900/50 hover:border-ink-600")
                        }
                      >
                        <span
                          className={`block text-sm font-medium ${active ? "text-accent" : "text-slate-200"}`}
                        >
                          {t.label}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-ink-500">
                          {t.blurb}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="host"
                  label="Management host / IP"
                  mono
                  placeholder="10.0.0.1"
                  value={target.credentials.host ?? ""}
                  onChange={(e) => setCred("host", e.target.value)}
                />
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

              {target.transport === "relay" && (
                <div className="rounded-lg border border-accent/30 bg-accent-soft/20 p-3">
                  <p className="text-xs font-medium text-slate-200">Run the on-site agent</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                    On a host that can reach the firewall, run the command below. It dials outbound
                    to this session over WSS and forwards API calls to the device — and it can talk
                    to self-signed management certs (which the Worker cannot).
                  </p>
                  <code className="mt-2 block overflow-x-auto whitespace-pre rounded bg-ink-950 px-2 py-2 font-mono text-[11px] text-accent">
                    {relayCmd}
                  </code>
                  <p className="mt-2 text-[11px] text-ink-500">
                    Then click <span className="text-slate-200">Test connection</span>. The agent is
                    in <span className="font-mono">agent/relay-agent.mjs</span>.
                  </p>
                </div>
              )}

              {target.transport === "direct" && (
                <p className="text-[11px] leading-relaxed text-ink-500">
                  Direct requires a publicly reachable mgmt IP with a{" "}
                  <span className="text-slate-200">trusted TLS certificate</span>. Devices with
                  self-signed certs (most firewalls by default) need the Relay agent or a Cloudflare
                  Tunnel — the Worker cannot bypass certificate verification.
                </p>
              )}
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-ink-700 pt-5">
            <Button variant="primary" onClick={testConnection} loading={testing}>
              Test connection
            </Button>
            {state.conn && (
              <StatusBadge tone={connected ? "good" : "bad"} dot>
                {connected ? "authenticated" : "failed"}
              </StatusBadge>
            )}
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-bad/30 bg-bad/5 p-3 text-xs leading-relaxed text-bad">
              {error}
            </div>
          )}

          {connected && (
            <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-ink-700 bg-ink-700 sm:grid-cols-4">
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
      intro="Every session begins read-only. We test auth, read model and licensing, and open nothing on the device until you confirm a plan later."
      onNext={props.onNext}
      nextDisabled={props.nextDisabled}
      footerNote={props.footerNote}
    >
      {props.children}
    </StepShell>
  );
}
