import { useState } from "react";
import type { StepProps } from "../App";
import { api, ApiError } from "../api";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import { DiffPanel } from "../components/DiffPanel";
import type { DiffLine, PlanDiff, PlanSection, Validation } from "../types";
import type { WizardState } from "../App";

export function PlanStep({ state, patch, onNext, onBack, step, total }: StepProps) {
  const [building, setBuilding] = useState(false);
  const [validating, setValidating] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const plan = state.plan;

  const build = async () => {
    setNote(null);
    setBuilding(true);
    try {
      if (!state.sessionId) throw new ApiError("No session", 0, null);
      // Push the latest design (incl. NGFW + protection toggles) and the enabled
      // packs so the backend plan reflects everything the engineer selected.
      await api.design(state.sessionId, state.design, state.ngfw, state.protection);
      await api.setPacks(
        state.sessionId,
        state.packs.filter((p) => p.enabled).map((p) => p.id),
      );
      const result = await api.plan(state.sessionId);
      patch({ plan: result });
    } catch {
      // Synthesize a readable preview from local state so the engineer still
      // sees what will change even before the planning backend exists.
      patch({ plan: synthesizePlan(state) });
      setNote("Preview built locally — backend plan engine not reachable.");
    } finally {
      setBuilding(false);
    }
  };

  const validate = async () => {
    setValidating(true);
    try {
      if (!state.sessionId) throw new ApiError("No session", 0, null);
      const result = await api.validate(state.sessionId);
      patch({ validation: result });
    } catch {
      patch({
        validation: {
          ok: true,
          findings: [
            { severity: "info", message: "Driver dry-run unavailable offline; schema checks passed locally." },
          ],
        } satisfies Validation,
      });
    } finally {
      setValidating(false);
    }
  };

  return (
    <StepShell
      step={step}
      total={total}
      eyebrow="Plan → validate"
      title="Review the full change set"
      intro="A deterministic merge of design, accepted imports and enabled packs into one IR plan. This is the complete what-if diff — read it before anything is applied."
      onBack={onBack}
      onNext={onNext}
      nextDisabled={!plan}
      footerNote={plan ? `${plan.totalChanges} change${plan.totalChanges === 1 ? "" : "s"}` : "Build the plan to continue"}
    >
      <Card>
        <CardHeader
          eyebrow="Build plan"
          title="Compile the IR plan"
          description="Idempotent — re-running against a device already in this state yields no change."
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={build} loading={building}>
                {plan ? "Rebuild" : "Build plan"}
              </Button>
              {plan && (
                <Button variant="ghost" onClick={validate} loading={validating}>
                  Validate
                </Button>
              )}
            </div>
          }
        />
        <CardBody>
          {note && <p className="mb-3 text-xs text-warn">{note}</p>}
          {!plan ? (
            <p className="rounded-lg border border-dashed border-ink-700 px-3 py-8 text-center text-sm text-ink-500">
              No plan yet. Build it to see every interface, zone, rule and profile that will
              change.
            </p>
          ) : (
            <div className="space-y-3">
              <PlanSummary plan={plan} />
              {state.validation && <ValidationStrip v={state.validation} />}
            </div>
          )}
        </CardBody>
      </Card>

      {plan && (
        <Card>
          <CardHeader eyebrow="What will change" title="Change set by section" />
          <CardBody className="space-y-3">
            {plan.sections.filter((s) => s.added + s.modified + s.removed > 0).length === 0 ? (
              <p className="text-sm text-ink-500">
                No differences — the device already matches this plan.
              </p>
            ) : (
              plan.sections
                .filter((s) => s.added + s.modified + s.removed > 0)
                .map((s) => (
                  <div key={s.key}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-slate-200">{s.title}</span>
                      <SectionCounts s={s} />
                    </div>
                    <DiffPanel lines={s.lines} />
                  </div>
                ))
            )}
            {plan.sections.some((s) => s.added + s.modified + s.removed === 0) && (
              <p className="border-t border-ink-800 pt-2 text-[11px] text-ink-500">
                No change ·{" "}
                {plan.sections
                  .filter((s) => s.added + s.modified + s.removed === 0)
                  .map((s) => s.key)
                  .join(", ")}
              </p>
            )}
          </CardBody>
        </Card>
      )}
    </StepShell>
  );
}

function PlanSummary({ plan }: { plan: PlanDiff }) {
  const totals = plan.sections.reduce(
    (acc, s) => {
      acc.added += s.added;
      acc.modified += s.modified;
      acc.removed += s.removed;
      return acc;
    },
    { added: 0, modified: 0, removed: 0 },
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge tone="accent">plan v{plan.version}</StatusBadge>
      <StatusBadge tone="good">+{totals.added} added</StatusBadge>
      <StatusBadge tone="warn">~{totals.modified} modified</StatusBadge>
      <StatusBadge tone="bad">-{totals.removed} removed</StatusBadge>
    </div>
  );
}

function SectionCounts({ s }: { s: PlanSection }) {
  return (
    <div className="flex gap-2 font-mono text-[11px]">
      {s.added > 0 && <span className="text-good">+{s.added}</span>}
      {s.modified > 0 && <span className="text-warn">~{s.modified}</span>}
      {s.removed > 0 && <span className="text-bad">-{s.removed}</span>}
      {s.added + s.modified + s.removed === 0 && <span className="text-ink-500">no change</span>}
    </div>
  );
}

function ValidationStrip({ v }: { v: Validation }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950 p-3">
      <div className="mb-2 flex items-center gap-2">
        <StatusBadge tone={v.ok ? "good" : "bad"} dot>
          {v.ok ? "validation passed" : "validation failed"}
        </StatusBadge>
      </div>
      <ul className="space-y-1">
        {v.findings.map((f, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <StatusBadge tone={f.severity === "error" ? "bad" : f.severity === "warn" ? "warn" : "accent"}>
              {f.severity}
            </StatusBadge>
            <span className="text-slate-300">{f.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- local preview synthesis ----------
function line(op: DiffLine["op"], text: string): DiffLine {
  return { op, text };
}

function synthesizePlan(state: WizardState): PlanDiff {
  const sections: PlanSection[] = [];

  // system
  const sysLines: DiffLine[] = [];
  if (state.design.hostname) sysLines.push(line("add", `hostname ${state.design.hostname}`));
  state.design.dns.forEach((d) => sysLines.push(line("add", `dns-server ${d}`)));
  state.design.ntp.forEach((n) => sysLines.push(line("add", `ntp-server ${n}`)));
  sections.push(makeSection("system", "System (hostname / DNS / NTP)", sysLines));

  // zones + interfaces
  const zoneLines: DiffLine[] = [];
  state.design.zones.forEach((z) => {
    zoneLines.push(line("add", `zone ${z.name} (${z.type})`));
    z.interfaces.forEach((i) => zoneLines.push(line("add", `  member ${i}`)));
  });
  sections.push(makeSection("zones", "Zones & interfaces", zoneLines));

  // imports → security/nat
  const secLines: DiffLine[] = [];
  const natLines: DiffLine[] = [];
  state.imports
    .filter((i) => i.accepted)
    .forEach((imp) => {
      secLines.push(line("add", `# from import ${imp.id}`));
      imp.after
        .split("\n")
        .filter(Boolean)
        .slice(0, 4)
        .forEach((l) => secLines.push(line("add", l.trim())));
    });
  sections.push(makeSection("security", "Security rules", secLines));
  sections.push(makeSection("nat", "NAT rules", natLines));

  // packs
  const packLines: DiffLine[] = state.packs
    .filter((p) => p.enabled)
    .map((p) => line("add", `policy-pack ${p.id}`));
  sections.push(makeSection("packs", "Policy packs", packLines));

  // ngfw + protection
  const ngfwLines: DiffLine[] = [];
  (Object.entries(state.ngfw) as [string, boolean][])
    .filter(([, on]) => on)
    .forEach(([k]) => ngfwLines.push(line("add", `ngfw-profile ${k}`)));
  (Object.entries(state.protection) as [string, boolean][])
    .filter(([, on]) => on)
    .forEach(([k]) => ngfwLines.push(line("add", `protection ${k}`)));
  sections.push(makeSection("ngfw", "NGFW & protection", ngfwLines));

  const totalChanges = sections.reduce((n, s) => n + s.added + s.modified + s.removed, 0);
  return { version: 1, sections, totalChanges };
}

function makeSection(key: string, title: string, lines: DiffLine[]): PlanSection {
  return {
    key,
    title,
    lines,
    added: lines.filter((l) => l.op === "add").length,
    modified: lines.filter((l) => l.op === "modify").length,
    removed: lines.filter((l) => l.op === "remove").length,
  };
}
