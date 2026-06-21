import { useState } from "react";
import type { StepProps } from "../App";
import { api, ApiError } from "../api";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import type { ApplyMode } from "../types";

interface ModeDef {
  id: ApplyMode;
  title: string;
  badge: string;
  tone: "accent" | "warn" | "bad";
  desc: string;
  cta: string;
}

const MODES: ModeDef[] = [
  {
    id: "staged",
    title: "Staged",
    badge: "safe",
    tone: "accent",
    desc: "Render the config and download a bundle to review and push manually. Nothing touches the device now.",
    cta: "Render staged bundle",
  },
  {
    id: "push",
    title: "Push",
    badge: "writes candidate",
    tone: "warn",
    desc: "Push the config to the device's candidate configuration via the API. You commit on the firewall yourself.",
    cta: "Push to device",
  },
  {
    id: "live",
    title: "Push & Commit",
    badge: "writes + commits",
    tone: "bad",
    desc: "Push the candidate config and commit it through the vendor API. Requires a typed acknowledgement.",
    cta: "Push & commit",
  },
];

export function ApplyStep({ state, patch, onNext, onBack, step, total }: StepProps) {
  const [mode, setMode] = useState<ApplyMode>("staged");
  const [ack, setAck] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Acknowledgement phrase is the device hostname if known, else "APPLY".
  const phrase = state.design.hostname || "APPLY";
  const needsAck = mode !== "staged";
  const armed = !needsAck || ack.trim() === phrase;
  const result = state.applyResult;
  const changeCount = state.plan?.totalChanges ?? 0;
  const active = MODES.find((m) => m.id === mode)!;

  const run = async () => {
    setError(null);
    setApplying(true);
    patch({ applyResult: null });
    try {
      if (!state.sessionId) throw new ApiError("No session", 0, null);
      const res = await api.apply(state.sessionId, mode, needsAck ? ack.trim() : undefined);
      patch({ applyResult: res });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Apply failed.";
      setError(msg);
    } finally {
      setApplying(false);
    }
  };

  const downloadBundle = () => {
    if (state.sessionId) window.open(api.bundleUrl(state.sessionId), "_blank", "noopener");
  };

  // Show the active result only if it matches the selected mode.
  const shownResult = result && result.mode === mode ? result : null;

  return (
    <StepShell
      step={step}
      total={total}
      eyebrow="Apply"
      title="Apply the plan"
      intro="Choose how this lands on the device. Staged downloads a bundle; Push writes the candidate config (you commit on the firewall); Push & Commit writes and commits via the API. A backup exists and every action is audited."
      onBack={onBack}
      onNext={onNext}
      nextDisabled={!shownResult?.ok}
      nextLabel="Continue to verify"
      footerNote={shownResult?.ok ? "Applied" : "Apply to continue"}
    >
      {/* Mode selector — 3 up */}
      <div className="grid gap-2 md:grid-cols-3">
        {MODES.map((m) => {
          const on = mode === m.id;
          const border =
            m.tone === "bad"
              ? "border-bad bg-bad/5"
              : m.tone === "warn"
                ? "border-warn bg-warn/5"
                : "border-accent bg-accent-soft/30";
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              aria-pressed={on}
              className={
                "rounded-xl border p-3 text-left transition-all " +
                (on ? border : "border-ink-700 bg-ink-900/50 hover:border-ink-600")
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-100">{m.title}</span>
                <StatusBadge tone={m.tone}>{m.badge}</StatusBadge>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-ink-500">{m.desc}</p>
            </button>
          );
        })}
      </div>

      {/* Action card for the selected mode */}
      <Card className={mode === "live" ? "border-bad/40" : mode === "push" ? "border-warn/40" : ""}>
        <CardHeader
          eyebrow={mode === "staged" ? "Staged apply" : `${active.title} — writes to the device`}
          title={mode === "staged" ? "Generate config bundle" : "Confirm a write to the device"}
          description={
            mode === "staged"
              ? "A vendor-native, human-reviewable bundle rendered deterministically from the IR."
              : mode === "push"
                ? "Pushes the candidate config via the API. The running config does not change until you commit on the firewall."
                : "Pushes the candidate config and commits it. A full backup was taken at discovery; rollback re-applies it."
          }
          action={
            needsAck ? (
              <StatusBadge tone={mode === "live" ? "bad" : "warn"} dot>
                {changeCount} change{changeCount === 1 ? "" : "s"}
              </StatusBadge>
            ) : undefined
          }
        />
        <CardBody>
          {needsAck && (
            <div
              className={
                "mb-4 rounded-lg border p-3 " +
                (mode === "live" ? "border-bad/30 bg-bad/5" : "border-warn/30 bg-warn/5")
              }
            >
              <p className="mb-2 text-sm text-slate-200">
                Type the acknowledgement phrase to arm the {mode === "live" ? "commit" : "push"}:
              </p>
              <code className="mb-2 inline-block rounded bg-ink-950 px-2 py-1 font-mono text-sm text-bad">
                {phrase}
              </code>
              <input
                value={ack}
                onChange={(e) => setAck(e.target.value)}
                placeholder={phrase}
                aria-label="Acknowledgement phrase"
                spellCheck={false}
                className="w-full rounded-md border border-ink-600 bg-ink-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-ink-600 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={mode === "live" ? "danger" : "primary"}
              onClick={run}
              loading={applying}
              disabled={!armed}
            >
              {applying ? "Working…" : active.cta}
            </Button>
            {needsAck && !armed && (
              <span className="text-xs text-ink-500">
                Disabled until the phrase matches exactly.
              </span>
            )}
            {mode === "staged" && shownResult?.ok && (
              <Button variant="primary" onClick={downloadBundle}>
                ↓ Download bundle
              </Button>
            )}
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-bad/30 bg-bad/5 p-3 text-xs leading-relaxed text-bad">
              {error}
            </div>
          )}

          {shownResult && <ResultPanel r={shownResult} />}
        </CardBody>
      </Card>
    </StepShell>
  );
}

function ResultPanel({ r }: { r: NonNullable<StepProps["state"]["applyResult"]> }) {
  const ok = r.ok;
  const headline =
    r.mode === "staged"
      ? "Bundle rendered"
      : r.mode === "push"
        ? ok
          ? "Candidate pushed — commit on the firewall to activate"
          : "Push failed"
        : ok
          ? r.committed
            ? "Committed"
            : "Applied"
          : "Apply failed";
  return (
    <div
      className={
        "mt-4 rounded-lg border p-3 " +
        (ok ? "border-good/30 bg-good/5" : "border-bad/30 bg-bad/5")
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={ok ? "good" : "bad"} dot>
          {headline}
        </StatusBadge>
        {r.commitId && (
          <span className="font-mono text-[11px] text-ink-500">commit job {r.commitId}</span>
        )}
        {r.bundleRef && (
          <span className="truncate font-mono text-[11px] text-ink-500">{r.bundleRef}</span>
        )}
      </div>
      {r.messages && r.messages.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {r.messages.map((m, i) => (
            <li key={i} className="font-mono text-[11px] leading-relaxed text-slate-300">
              · {m}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
