import { useState } from "react";
import type { StepProps } from "../App";
import { api, ApiError } from "../api";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";

export function VerifyStep({ state, patch, onBack, step, total }: StepProps) {
  const [reading, setReading] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const result = state.verifyResult;

  const loadReport = async () => {
    if (!state.sessionId) return;
    setLoadingReport(true);
    setNote(null);
    try {
      const blob = await api.report(state.sessionId);
      setReport(await blob.text());
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : "Could not generate the build report.");
    } finally {
      setLoadingReport(false);
    }
  };

  const downloadReport = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([report], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `bastion-report-${(state.sessionId ?? "run").slice(4, 12)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const readBack = async () => {
    setNote(null);
    setReading(true);
    try {
      if (!state.sessionId) throw new ApiError("No session", 0, null);
      const res = await api.verify(state.sessionId);
      patch({ verifyResult: res });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Read-back failed.";
      setNote(`${msg} — the backend is needed to read the device.`);
    } finally {
      setReading(false);
    }
  };

  const rollback = async () => {
    setNote(null);
    setRolling(true);
    try {
      if (!state.sessionId) throw new ApiError("No session", 0, null);
      const res = await api.rollback(state.sessionId);
      setNote(res.message ?? "Rollback complete — pre-change config re-applied.");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Rollback failed.";
      setNote(`${msg}`);
    } finally {
      setRolling(false);
    }
  };

  const matched = result?.rows.filter((r) => r.match).length ?? 0;
  const mismatched = (result?.rows.length ?? 0) - matched;

  return (
    <StepShell
      step={step}
      total={total}
      eyebrow="Verify"
      title="Read the device back"
      intro="Confirm what actually landed. Bastion reads the device again and compares it to the plan, item by item."
      onBack={onBack}
    >
      <Card>
        <CardHeader
          eyebrow="Read-back"
          title="Confirm applied state"
          description="Each expected value is compared against what the device now reports."
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={readBack} loading={reading}>
                {result ? "Re-read" : "Read device back"}
              </Button>
              <Button variant="ghost" onClick={loadReport} loading={loadingReport}>
                Build report
              </Button>
            </div>
          }
        />
        <CardBody>
          {note && <p className="mb-3 text-xs text-warn">{note}</p>}
          {!result ? (
            <p className="rounded-lg border border-dashed border-ink-700 px-3 py-8 text-center text-sm text-ink-500">
              No read-back yet. Read the device to compare expected vs actual.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={result.ok && mismatched === 0 ? "good" : "warn"} dot>
                  {mismatched === 0 ? "all checks matched" : `${mismatched} mismatch${mismatched === 1 ? "" : "es"}`}
                </StatusBadge>
                <StatusBadge tone="good">{matched} matched</StatusBadge>
                {mismatched > 0 && <StatusBadge tone="bad">{mismatched} differ</StatusBadge>}
              </div>

              <div className="overflow-hidden rounded-lg border border-ink-700">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-ink-700 bg-ink-900/60">
                      <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-500">
                        Item
                      </th>
                      <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-500">
                        Expected
                      </th>
                      <th className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-500">
                        Actual
                      </th>
                      <th className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-wider text-ink-500">
                        Result
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr
                        key={i}
                        className={`border-b border-ink-800 last:border-0 ${
                          r.match ? "" : "bg-bad/5"
                        }`}
                      >
                        <td className="px-3 py-2 font-mono text-slate-200">{r.item}</td>
                        <td className="px-3 py-2 font-mono text-ink-500">{r.expected}</td>
                        <td className={`px-3 py-2 font-mono ${r.match ? "text-slate-300" : "text-bad"}`}>
                          {r.actual}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={r.match ? "text-good" : "text-bad"}>
                            {r.match ? "✓ match" : "✕ differ"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {report && (
        <Card>
          <CardHeader
            eyebrow="End-of-run summary"
            title="Build report"
            description="How each brief item, policy pack and NGFW feature was met — plus placeholders and follow-up config."
            action={
              <Button variant="subtle" size="sm" onClick={downloadReport}>
                ↓ Download .md
              </Button>
            }
          />
          <CardBody>
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-950 p-4 text-[11px] leading-relaxed text-slate-200">
              {report}
            </pre>
          </CardBody>
        </Card>
      )}

      <Card className="border-bad/30">
        <CardHeader
          eyebrow="Safety net"
          title="Rollback"
          description="Re-apply the pre-change running-config backup taken at discovery."
          action={
            <Button variant="danger" onClick={rollback} loading={rolling}>
              Roll back to backup
            </Button>
          }
        />
      </Card>
    </StepShell>
  );
}
