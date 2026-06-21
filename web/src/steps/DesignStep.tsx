import { useState } from "react";
import type { StepProps } from "../App";
import { api, ApiError } from "../api";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { Field } from "../components/Field";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import type { IfaceMode, ZoneDesign } from "../types";

type ZoneType = ZoneDesign["type"];

const ZONE_PRESETS: { type: ZoneType; name: string }[] = [
  { type: "trust", name: "trust" },
  { type: "untrust", name: "untrust" },
  { type: "dmz", name: "dmz" },
  { type: "guest", name: "guest" },
];

const ZONE_TONE: Record<ZoneType, "good" | "bad" | "warn" | "accent" | "neutral"> = {
  trust: "good",
  untrust: "bad",
  dmz: "warn",
  guest: "accent",
  custom: "neutral",
};

export function DesignStep({ state, patch, onNext, onBack, step, total }: StepProps) {
  const { design } = state;
  const ifaceNames = state.inventory?.interfaces.map((i) => i.name) ?? [];
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (next: Partial<typeof design>) => {
    setSaved(false);
    patch({ design: { ...design, ...next } });
  };

  const addZone = (type: ZoneType, name: string) => {
    if (design.zones.some((z) => z.name === name)) return;
    update({ zones: [...design.zones, { name, type, interfaces: [] }] });
  };

  const addCustomZone = () => {
    let n = design.zones.length + 1;
    let candidate = `zone${n}`;
    while (design.zones.some((z) => z.name === candidate)) candidate = `zone${++n}`;
    update({ zones: [...design.zones, { name: candidate, type: "custom", interfaces: [] }] });
  };

  const removeZone = (name: string) =>
    update({ zones: design.zones.filter((z) => z.name !== name) });

  const renameZone = (oldName: string, newName: string) =>
    update({
      zones: design.zones.map((z) => (z.name === oldName ? { ...z, name: newName } : z)),
    });

  // Assign an interface to exactly one zone (move semantics).
  const assignInterface = (iface: string, zoneName: string | null) =>
    update({
      zones: design.zones.map((z) => ({
        ...z,
        interfaces:
          z.name === zoneName
            ? Array.from(new Set([...z.interfaces, iface]))
            : z.interfaces.filter((i) => i !== iface),
      })),
    });

  const zoneOf = (iface: string) =>
    design.zones.find((z) => z.interfaces.includes(iface))?.name ?? null;

  const discoveredIp = (iface: string) =>
    state.inventory?.interfaces.find((i) => i.name === iface)?.address;
  const addrOf = (iface: string) =>
    design.interfaceAddrs?.[iface] ?? { mode: "config" as const, address: discoveredIp(iface) };
  const setAddr = (
    iface: string,
    next: { mode: "config" | "none" | "dhcp" | "static"; address?: string },
  ) => update({ interfaceAddrs: { ...(design.interfaceAddrs ?? {}), [iface]: next } });

  // ---- LACP link-aggregation (ae<n>) ----
  const aggregates = design.aggregates ?? [];
  const bundleOf = (iface: string) => aggregates.find((a) => a.members.includes(iface))?.name ?? null;
  const setAggregates = (next: typeof aggregates) => update({ aggregates: next });
  const nextAeName = () => {
    let n = 1;
    while (aggregates.some((a) => a.name === `ae${n}`)) n++;
    return `ae${n}`;
  };
  const addToBundle = (iface: string, aeName: string) => {
    // a bundled member can't also be a zone interface
    update({
      zones: design.zones.map((z) => ({ ...z, interfaces: z.interfaces.filter((i) => i !== iface) })),
      aggregates: aggregates.map((a) =>
        a.name === aeName ? { ...a, members: Array.from(new Set([...a.members, iface])) } : a,
      ),
    });
  };
  const newBundleWith = (iface: string) => {
    const name = nextAeName();
    update({
      zones: design.zones.map((z) => ({ ...z, interfaces: z.interfaces.filter((i) => i !== iface) })),
      aggregates: [...aggregates, { name, members: [iface] }],
    });
  };
  const removeFromBundle = (iface: string) =>
    setAggregates(
      aggregates
        .map((a) => ({ ...a, members: a.members.filter((m) => m !== iface) }))
        .filter((a) => a.members.length > 0),
    );
  const deleteBundle = (aeName: string) =>
    update({
      zones: design.zones.map((z) => ({ ...z, interfaces: z.interfaces.filter((i) => i !== aeName) })),
      aggregates: aggregates.filter((a) => a.name !== aeName),
    });

  const renderAddr = (name: string) => {
    const addr = addrOf(name);
    const disc = discoveredIp(name);
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-1">
        <select
          value={addr.mode}
          onChange={(e) => setAddr(name, { mode: e.target.value as IfaceMode, address: addr.address })}
          aria-label={`Addressing for ${name}`}
          className="cursor-pointer rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[10px] text-slate-200 focus:border-accent focus:outline-none"
        >
          <option value="config">From import info</option>
          <option value="dhcp">DHCP</option>
          <option value="static">Static</option>
          <option value="none">No IP</option>
        </select>
        {addr.mode === "static" && (
          <input
            value={addr.address ?? ""}
            onChange={(e) => setAddr(name, { mode: "static", address: e.target.value.replace(/\s/g, "") })}
            placeholder="10.0.0.1/24"
            spellCheck={false}
            aria-label={`IP/CIDR for ${name}`}
            className="flex-1 rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[10px] text-slate-100 placeholder:text-ink-600 focus:border-accent focus:outline-none"
          />
        )}
        {addr.mode === "config" && (
          <span className="font-mono text-[10px] text-ink-500">
            {disc ? `from import: ${disc}` : "(none imported — WAN falls back to DHCP)"}
          </span>
        )}
        {addr.mode === "none" && (
          <span className="text-[10px] text-ink-500">no IP — WAN needs DHCP/static for source-NAT</span>
        )}
      </div>
    );
  };

  const listEditor =
    (key: "dns" | "ntp") =>
    (raw: string) =>
      update({ [key]: raw.split(/[\s,]+/).filter(Boolean) } as Partial<typeof design>);

  const save = async () => {
    if (!state.sessionId) {
      onNext();
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.design(state.sessionId, design);
      setSaved(true);
    } catch (e) {
      // Saving is best-effort; the design lives in state regardless.
      const msg = e instanceof ApiError ? e.message : "Save failed.";
      setError(`${msg} — kept locally; you can still continue.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <StepShell
      step={step}
      total={total}
      eyebrow="Zone / interface design"
      title="Shape the desired state"
      intro="Define zones, map discovered interfaces onto them, and set system basics. This becomes the backbone of the IR plan."
      onBack={onBack}
      onNext={() => {
        void save();
        onNext();
      }}
      footerNote={saved ? "Design saved" : undefined}
    >
      <Card>
        <CardHeader
          eyebrow="Zones"
          title="Create zones"
          description="Start from a trust/untrust/DMZ pattern or add custom zones."
          action={
            <Button variant="subtle" size="sm" onClick={addCustomZone}>
              + Custom zone
            </Button>
          }
        />
        <CardBody>
          <div className="mb-4 flex flex-wrap gap-2">
            {ZONE_PRESETS.map((p) => {
              const exists = design.zones.some((z) => z.name === p.name);
              return (
                <button
                  key={p.type}
                  type="button"
                  disabled={exists}
                  onClick={() => addZone(p.type, p.name)}
                  className="rounded-full border border-ink-600 bg-ink-800 px-3 py-1 font-mono text-[11px] text-slate-300 transition-colors hover:border-ink-500 disabled:opacity-40"
                >
                  + {p.name}
                </button>
              );
            })}
          </div>

          {design.zones.length === 0 ? (
            <p className="rounded-lg border border-dashed border-ink-700 px-3 py-8 text-center text-sm text-ink-500">
              No zones yet. Add at least one zone, then map interfaces to it.
            </p>
          ) : (
            <div className="space-y-2">
              {design.zones.map((z) => (
                <div
                  key={z.name}
                  className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5"
                >
                  <StatusBadge tone={ZONE_TONE[z.type]}>{z.type}</StatusBadge>
                  <input
                    value={z.name}
                    onChange={(e) => renameZone(z.name, e.target.value)}
                    className="flex-1 bg-transparent font-mono text-sm text-slate-100 focus:outline-none"
                    aria-label={`Zone name for ${z.name}`}
                  />
                  <span className="font-mono text-[11px] text-ink-500">
                    {z.interfaces.length} mapped
                  </span>
                  <button
                    type="button"
                    onClick={() => removeZone(z.name)}
                    aria-label={`Remove zone ${z.name}`}
                    className="text-ink-500 transition-colors hover:text-bad"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Interface mapping"
          title="Map interfaces to zones"
          description="Assign each interface to a zone and set its addressing. Default uses the IP from import info. Bundle interfaces into a LACP aggregate (ae) with the Bundle control."
        />
        <CardBody>
          {ifaceNames.length === 0 && aggregates.length === 0 ? (
            <p className="text-sm text-ink-500">
              No discovered interfaces. Run discovery first, or continue and map later.
            </p>
          ) : (
            <div className="space-y-2">
              {aggregates.map((ag) => {
                const assigned = zoneOf(ag.name);
                return (
                  <div key={ag.name} className="rounded-lg border border-accent/40 bg-ink-950 px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs text-accent">
                        {ag.name}{" "}
                        <span className="text-[10px] text-ink-500">
                          LACP · {ag.members.length} member{ag.members.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      <div className="flex items-center gap-2">
                        <select
                          value={assigned ?? ""}
                          onChange={(e) => assignInterface(ag.name, e.target.value || null)}
                          aria-label={`Zone for ${ag.name}`}
                          disabled={design.zones.length === 0}
                          className="cursor-pointer rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[11px] text-slate-200 focus:border-accent focus:outline-none disabled:opacity-40"
                        >
                          <option value="">unassigned</option>
                          {design.zones.map((z) => (
                            <option key={z.name} value={z.name}>
                              {z.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => deleteBundle(ag.name)}
                          aria-label={`Delete bundle ${ag.name}`}
                          className="text-ink-500 transition-colors hover:text-bad"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-ink-500">
                      {ag.members.join(", ") || "no members yet"}
                    </div>
                    {assigned && renderAddr(ag.name)}
                  </div>
                );
              })}

              {ifaceNames.map((iface) => {
                const bundle = bundleOf(iface);
                if (bundle) {
                  return (
                    <div
                      key={iface}
                      className="flex items-center justify-between rounded-lg border border-ink-700 bg-ink-950 px-3 py-2"
                    >
                      <span className="font-mono text-xs text-slate-100">{iface}</span>
                      <span className="flex items-center gap-2">
                        <span className="rounded bg-accent-soft/40 px-1.5 py-0.5 font-mono text-[10px] text-accent">
                          bundled in {bundle}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFromBundle(iface)}
                          className="text-[11px] text-ink-500 hover:text-bad"
                        >
                          unbundle
                        </button>
                      </span>
                    </div>
                  );
                }
                const assigned = zoneOf(iface);
                return (
                  <div
                    key={iface}
                    className={`rounded-lg border bg-ink-950 px-3 py-2.5 ${assigned ? "border-accent/40" : "border-ink-700"}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs text-slate-100">{iface}</span>
                      <div className="flex items-center gap-2">
                        <select
                          value={assigned ?? ""}
                          onChange={(e) => assignInterface(iface, e.target.value || null)}
                          aria-label={`Zone for ${iface}`}
                          disabled={design.zones.length === 0}
                          className="cursor-pointer rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[11px] text-slate-200 focus:border-accent focus:outline-none disabled:opacity-40"
                        >
                          <option value="">unassigned</option>
                          {design.zones.map((z) => (
                            <option key={z.name} value={z.name}>
                              {z.name}
                            </option>
                          ))}
                        </select>
                        <select
                          value=""
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "__new") newBundleWith(iface);
                            else if (v) addToBundle(iface, v);
                          }}
                          aria-label={`Bundle ${iface}`}
                          title="LACP link aggregation"
                          className="cursor-pointer rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-[11px] text-slate-200 focus:border-accent focus:outline-none"
                        >
                          <option value="">bundle…</option>
                          {aggregates.map((a) => (
                            <option key={a.name} value={a.name}>
                              + {a.name}
                            </option>
                          ))}
                          <option value="__new">+ new ae</option>
                        </select>
                      </div>
                    </div>
                    {assigned && renderAddr(iface)}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="System"
          title="Hostname, DNS & NTP"
          description="Applied via deterministic per-vendor templates."
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              id="hostname"
              label="Hostname"
              mono
              placeholder="fw-site-01"
              value={design.hostname ?? ""}
              onChange={(e) => update({ hostname: e.target.value })}
            />
            <Field
              id="dns"
              label="DNS servers"
              mono
              placeholder="1.1.1.1, 9.9.9.9"
              hint="Comma or space separated"
              value={design.dns.join(", ")}
              onChange={(e) => listEditor("dns")(e.target.value)}
            />
            <Field
              id="ntp"
              label="NTP servers"
              mono
              placeholder="time.cloudflare.com"
              hint="Comma or space separated"
              value={design.ntp.join(", ")}
              onChange={(e) => listEditor("ntp")(e.target.value)}
            />
          </div>
          {error && <p className="mt-3 text-xs text-warn">{error}</p>}
          {saving && <p className="mt-3 text-xs text-ink-500">Saving design…</p>}
        </CardBody>
      </Card>
    </StepShell>
  );
}
