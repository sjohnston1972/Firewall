import { useRef, useState } from "react";
import type { StepProps } from "../App";
import { api, ApiError } from "../api";
import { StepShell } from "../components/StepShell";
import { Card, CardBody, CardHeader } from "../components/Card";
import { SelectField } from "../components/Field";
import { Button } from "../components/Button";
import { StatusBadge } from "../components/StatusBadge";
import { SideBySideDiff } from "../components/DiffPanel";
import { IMPORT_FORMATS, type ImportFormat, type ImportResult, type ImportWarning } from "../types";

const WARN_TONE: Record<ImportWarning["severity"], "accent" | "warn" | "bad"> = {
  info: "accent",
  warn: "warn",
  danger: "bad",
};

export function ImportStep({ state, patch, onNext, onBack, step, total }: StepProps) {
  const [format, setFormat] = useState<ImportFormat>("panos-cli");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setImports = (next: ImportResult[]) => patch({ imports: next });

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setSource(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const normalise = async () => {
    if (!source.trim()) return;
    setError(null);
    setBusy(true);
    try {
      if (!state.sessionId) throw new ApiError("No session", 0, null);
      const result = await api.import(state.sessionId, { format, source });
      setImports([result, ...state.imports]);
      setSource("");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Normalise failed.";
      setError(`${msg} — the AI normaliser needs the backend running.`);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, accepted: boolean) => {
    setImports(
      state.imports.map((imp) => (imp.id === id ? { ...imp, accepted } : imp)),
    );
    if (accepted && state.sessionId) {
      try {
        await api.acceptImport(state.sessionId, id);
      } catch {
        /* local accept stands even if the persist call fails */
      }
    }
  };

  const remove = (id: string) => setImports(state.imports.filter((i) => i.id !== id));

  const acceptedCount = state.imports.filter((i) => i.accepted).length;

  return (
    <StepShell
      step={step}
      total={total}
      eyebrow="Imports — the only AI step"
      title="Normalise existing config"
      intro="Paste or upload source NAT / ACL / VPN in any format. The AI converts it to validated IR fragments — you review a before/after diff and accept each one. The AI never touches the device."
      onBack={onBack}
      onNext={onNext}
      nextLabel={state.imports.length ? "Continue" : "Skip imports"}
      footerNote={
        state.imports.length
          ? `${acceptedCount} of ${state.imports.length} accepted`
          : "Imports are optional"
      }
    >
      <Card>
        <CardHeader
          eyebrow="Source"
          title="Paste or upload config"
          description="Raw vendor CLI, another vendor's syntax, CSV export, or free text all work."
          action={
            <SelectField
              label="Format"
              id="import-format"
              value={format}
              onChange={(e) => setFormat(e.target.value as ImportFormat)}
              className="w-44"
            >
              {IMPORT_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </SelectField>
          }
        />
        <CardBody>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            placeholder={"# paste config here\nset rulebase security rules trust-untrust ..."}
            className="h-44 w-full resize-y rounded-lg border border-ink-600 bg-ink-950 px-3 py-3 font-mono text-xs leading-relaxed text-slate-200 placeholder:text-ink-600 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={normalise} loading={busy} disabled={!source.trim()}>
              {busy ? "Normalising…" : (<><SparkIcon /> Normalise with AI</>)}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.conf,.cfg,.csv,.xml,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = "";
              }}
            />
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              Upload file
            </Button>
            <span className="font-mono text-[11px] text-ink-500">
              {source ? `${source.length} chars` : "no input"}
            </span>
          </div>
          {error && <p className="mt-3 text-xs text-bad">{error}</p>}
        </CardBody>
      </Card>

      {busy && (
        <Card>
          <CardBody className="flex items-center gap-3 py-5">
            <span
              aria-hidden
              className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-100">Normalising with AI…</p>
              <p className="text-[11px] leading-snug text-ink-500">
                Converting your config to a schema-validated IR fragment and flagging anything
                ambiguous — this can take a few seconds.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      {!busy && state.imports.length === 0 ? (
        <p className="rounded-lg border border-dashed border-ink-700 px-3 py-8 text-center text-sm text-ink-500">
          No imports yet. Normalised fragments appear here for review. Nothing joins the plan
          until you accept it.
        </p>
      ) : (
        state.imports.map((imp) => (
          <Card key={imp.id}>
            <CardHeader
              eyebrow={`AI normalised · ${IMPORT_FORMATS.find((f) => f.id === imp.format)?.label ?? imp.format}`}
              title="Review fragment"
              description={imp.model ? `model · ${imp.model}` : undefined}
              action={
                imp.accepted ? (
                  <StatusBadge tone="good" dot>
                    accepted
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="warn" dot>
                    needs review
                  </StatusBadge>
                )
              }
            />
            <CardBody className="space-y-4">
              {imp.warnings.length > 0 && (
                <div className="space-y-1.5">
                  {imp.warnings.map((w, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2"
                    >
                      <StatusBadge tone={WARN_TONE[w.severity]}>{w.severity}</StatusBadge>
                      <span className="text-xs leading-relaxed text-slate-300">
                        <span className="font-mono text-slate-100">{w.item}</span> — {w.reason}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <SideBySideDiff before={imp.before} after={imp.after} />

              <div className="flex items-center gap-3 border-t border-ink-700 pt-3">
                {!imp.accepted ? (
                  <>
                    <Button variant="primary" size="sm" onClick={() => decide(imp.id, true)}>
                      ✓ Accept
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => remove(imp.id)}>
                      ✕ Reject
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => decide(imp.id, false)}>
                    Undo accept
                  </Button>
                )}
              </div>
            </CardBody>
          </Card>
        ))
      )}
    </StepShell>
  );
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2L13.8 8.2L20 10L13.8 11.8L12 18L10.2 11.8L4 10L10.2 8.2L12 2Z"
        fill="currentColor"
      />
    </svg>
  );
}
