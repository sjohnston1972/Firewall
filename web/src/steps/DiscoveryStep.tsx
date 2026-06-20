import { useState } from "react";
import type { StepProps } from "../App";
import { api, ApiError } from "../api";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import type { DeviceInventory } from "../types";

export function DiscoveryStep({ state, patch, onNext, onBack, step, total }: StepProps) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inv = state.inventory;

  const runScan = async () => {
    if (!state.sessionId) {
      setError("No session — go back and connect first.");
      return;
    }
    setError(null);
    setScanning(true);
    try {
      const inventory = await api.discover(state.sessionId);
      patch({ inventory });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Discovery failed.";
      setError(`${msg} — the backend may not be running yet.`);
    } finally {
      setScanning(false);
    }
  };

  return (
    <StepShell
      step={step}
      total={total}
      eyebrow="Discovery"
      title="Read-only scan & backup"
      intro="Bastion reads the running layout and takes a full running-config backup to R2 before anything is changed. This is your rollback safety net."
      onBack={onBack}
      onNext={onNext}
      nextDisabled={!inv}
      footerNote={inv ? "Inventory captured" : "Run a scan to continue"}
    >
      <Card>
        <CardHeader
          eyebrow="Read-only"
          title="Discover device inventory"
          description="Interfaces, zones, routes and existing objects — nothing is written."
          action={
            <Button variant="primary" onClick={runScan} loading={scanning}>
              {inv ? "Re-scan" : "Run discovery"}
            </Button>
          }
        />
        <CardBody>
          {error && (
            <p className="mb-4 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
              {error}
            </p>
          )}

          {!inv && !error && (
            <EmptyState
              scanning={scanning}
              text={
                scanning
                  ? "Reading interfaces, zones and routing table…"
                  : "No discovery yet. Run a read-only scan to map the device."
              }
            />
          )}

          {inv && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="good" dot>
                  backup taken
                </StatusBadge>
                <span className="font-mono text-[11px] text-ink-500">
                  {inv.backupRef ?? "r2://backups/running-config.xml"}
                </span>
                {inv.haState && (
                  <StatusBadge tone={inv.haState === "active" ? "good" : "warn"}>
                    HA · {inv.haState}
                  </StatusBadge>
                )}
                <StatusBadge tone="neutral">{inv.objectCount ?? 0} objects</StatusBadge>
              </div>

              <Interfaces inv={inv} />

              <div className="grid gap-5 lg:grid-cols-2">
                <ZoneSummary inv={inv} />
                <RouteSummary inv={inv} />
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </StepShell>
  );
}

function EmptyState({ text, scanning }: { text: string; scanning: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-ink-700 py-14 text-center">
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-full border border-ink-600 text-ink-500 ${
          scanning ? "animate-pulse" : ""
        }`}
        aria-hidden
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6" />
          <path d="M16 16L21 21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
      <p className="max-w-sm text-sm text-ink-500">{text}</p>
    </div>
  );
}

function Interfaces({ inv }: { inv: DeviceInventory }) {
  if (inv.interfaces.length === 0) {
    return <p className="text-xs text-ink-500">No interfaces returned.</p>;
  }
  return (
    <div>
      <div className="eyebrow mb-2">Interfaces · {inv.interfaces.length}</div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
        {inv.interfaces.map((iface) => (
          <div
            key={iface.name}
            title={[
              iface.name,
              iface.address,
              iface.zone && `zone ${iface.zone}`,
              iface.link && `link ${iface.link}`,
              iface.hwType,
            ]
              .filter(Boolean)
              .join(" · ")}
            className="flex items-center gap-1.5 rounded-md border border-ink-700 bg-ink-950 px-2 py-1"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                iface.link === "down" || !iface.enabled ? "bg-ink-500" : "bg-good"
              }`}
              aria-hidden
            />
            <span className="truncate font-mono text-[11px] text-slate-100">{iface.name}</span>
            <span className="ml-auto flex min-w-0 items-center gap-1.5">
              {iface.address && (
                <span className="truncate font-mono text-[10px] text-ink-500">{iface.address}</span>
              )}
              {iface.zone && (
                <span className="shrink-0 rounded bg-accent-soft/40 px-1 font-mono text-[10px] text-accent">
                  {iface.zone}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ZoneSummary({ inv }: { inv: DeviceInventory }) {
  return (
    <div>
      <div className="eyebrow mb-2">Zones · {inv.zones.length}</div>
      <div className="overflow-hidden rounded-lg border border-ink-700">
        {inv.zones.length === 0 ? (
          <p className="px-3 py-3 text-xs text-ink-500">No zones configured.</p>
        ) : (
          inv.zones.map((z) => (
            <div
              key={z.name}
              className="flex items-center justify-between border-b border-ink-800 px-3 py-2 last:border-0"
            >
              <span className="font-mono text-xs text-slate-200">{z.name}</span>
              <span className="font-mono text-[11px] text-ink-500">
                {z.interfaces.length} iface{z.interfaces.length === 1 ? "" : "s"}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function RouteSummary({ inv }: { inv: DeviceInventory }) {
  return (
    <div>
      <div className="eyebrow mb-2">Routes · {inv.routes.length}</div>
      <div className="overflow-hidden rounded-lg border border-ink-700">
        {inv.routes.length === 0 ? (
          <p className="px-3 py-3 text-xs text-ink-500">No routes returned.</p>
        ) : (
          inv.routes.slice(0, 8).map((r, i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-ink-800 px-3 py-2 font-mono text-[11px] last:border-0"
            >
              <span className="text-slate-200">{r.destination}</span>
              <span className="text-ink-500">→ {r.nexthop}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
