import { useState } from "react";
import type { StepProps } from "../App";
import { api, ApiError } from "../api";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import type { ApplyMode } from "../types";

export function ApplyStep({ state, patch, onNext, onBack, step, total }: StepProps) {
  const [mode, setMode] = useState<ApplyMode>("staged");
  const [ack, setAck] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The acknowledgement phrase is the device hostname if known, else "APPLY".
  const phrase = state.design.hostname || "APPLY";
  const liveArmed = mode === "live" && ack.trim() === phrase;
  const result = state.applyResult;
  const changeCount = state.plan?.totalChanges ?? 0;

  const run = async () => {
    setError(null);
    setApplying(true);
    try {
      if (!state.sessionId) throw new ApiError("No session", 0, null);
      const res = await api.apply(state.sessionId, mode, mode === "live" ? ack.trim() : undefined);
      patch({ applyResult: res });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Apply failed.";
      setError(`${msg} — the apply path requires the backend.`);
    } finally {
      setApplying(false);
    }
  };

  const downloadBundle = () => {
    if (state.sessionId) window.open(api.bundleUrl(state.sessionId), "_blank", "noopener");
  };

  return (
    <StepShell
      step={step}
      total={total}
      eyebrow="Apply"
      title="Apply the plan"
      intro="Choose how this lands on the device. Live commits via the vendor API; staged produces a downloadable bundle you push by hand. Either way, a backup already exists and every action is audited."
      onBack={onBack}
      onNext={onNext}
      nextDisabled={!result?.ok}
      nextLabel="Continue to verify"
      footerNote={result?.ok ? "Applied" : "Apply to continue"}
    >
      {/* Mode selector */}
      <div className="grid gap-3 md:grid-cols-2">
        <ModeCard
          active={mode === "staged"}
          onClick={() => setMode("staged")}
          tone="accent"
          title="Staged"
          badge="safe"
          desc="Render the config and download a bundle to review and push manually. Nothing touches the device now."
        />
        <ModeCard
          active={mode === "live"}
          onClick={() => setMode("live")}
          tone="bad"
          title="Live"
          badge="writes to device"
          desc="Build a candidate config and commit it through the vendor API. Requires a typed acknowledgement."
        />
      </div>

      {mode === "staged" ? (
        <Card>
          <CardHeader
            eyebrow="Staged apply"
            title="Generate config bundle"
            description="A vendor-native, human-reviewable bundle rendered deterministically from the IR."
          />
          <CardBody>
            <div className="flex flex-wrap items-center gap-3">
              {!result ? (
                <Button variant="primary" onClick={run} loading={applying}>
                  Render staged bundle
                </Button>
              ) : (
                <>
                  <StatusBadge tone="good" dot>
                    bundle ready
                  </StatusBadge>
                  <Button variant="primary" onClick={downloadBundle}>
                    ↓ Download bundle
                  </Button>
                  <span className="font-mono text-[11px] text-ink-500">
                    {result.bundleRef ?? "r2://bundles/staged.zip"}
                  </span>
                </>
              )}
            </div>
            {error && <p className="mt-3 text-xs text-bad">{error}</p>}
          </CardBody>
        </Card>
      ) : (
        <Card className="border-bad/40">
          <CardHeader
            eyebrow="Live apply — irreversible commit"
            title="Confirm a write to the device"
            description="This commits the candidate config. A full backup was taken at discovery; rollback re-applies it."
            action={
              <StatusBadge tone="bad" dot>
                {changeCount} change{changeCount === 1 ? "" : "s"}
              </StatusBadge>
            }
          />
          <CardBody>
            <div className="rounded-lg border border-bad/30 bg-bad/5 p-4">
              <p className="mb-3 text-sm text-slate-200">
                Type the acknowledgement phrase to arm the commit:
              </p>
              <code className="mb-3 inline-block rounded bg-ink-950 px-2 py-1 font-mono text-sm text-bad">
                {phrase}
              </code>
              <input
                value={ack}
                onChange={(e) => setAck(e.target.value)}
                placeholder={phrase}
                aria-label="Acknowledgement phrase"
                spellCheck={false}
                className="w-full rounded-md border border-bad/40 bg-ink-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-ink-600 focus:border-bad focus:outline-none focus:ring-1 focus:ring-bad"
              />
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button variant="danger" onClick={run} disabled={!liveArmed} loading={applying}>
                  Commit to device
                </Button>
                {!liveArmed && (
                  <span className="text-xs text-ink-500">
                    Button stays disabled until the phrase matches exactly.
                  </span>
                )}
                {result?.ok && (
                  <StatusBadge tone="good" dot>
                    committed {result.commitId ? `· ${result.commitId}` : ""}
                  </StatusBadge>
                )}
              </div>
              {error && <p className="mt-3 text-xs text-bad">{error}</p>}
            </div>
          </CardBody>
        </Card>
      )}
    </StepShell>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  desc,
  badge,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  badge: string;
  tone: "accent" | "bad";
}) {
  const activeBorder = tone === "bad" ? "border-bad bg-bad/5" : "border-accent bg-accent-soft/30";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-xl border p-4 text-left transition-all " +
        (active ? activeBorder : "border-ink-700 bg-ink-900/50 hover:border-ink-600")
      }
    >
      <div className="flex items-center justify-between">
        <span className="text-base font-semibold text-slate-100">{title}</span>
        <StatusBadge tone={tone}>{badge}</StatusBadge>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-500">{desc}</p>
    </button>
  );
}
