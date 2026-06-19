import type { DiffLine, DiffOp } from "../types";

/**
 * Two ways to render a diff:
 *  - <DiffPanel>: a single column of op-prefixed lines (used by the plan).
 *  - <SideBySideDiff>: BEFORE / AFTER columns (used by AI imports, §5.6).
 */

const opGutter: Record<DiffOp, string> = {
  add: "text-good",
  remove: "text-bad",
  modify: "text-warn",
  keep: "text-ink-500",
};

const opRow: Record<DiffOp, string> = {
  add: "bg-good/5",
  remove: "bg-bad/5",
  modify: "bg-warn/5",
  keep: "",
};

const opSign: Record<DiffOp, string> = {
  add: "+",
  remove: "-",
  modify: "~",
  keep: " ",
};

interface DiffPanelProps {
  lines: DiffLine[];
  label?: string;
  emptyText?: string;
}

export function DiffPanel({ lines, label, emptyText = "No changes." }: DiffPanelProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
      {label && (
        <div className="eyebrow border-b border-ink-700 bg-ink-900/60 px-3 py-1.5">
          {label}
        </div>
      )}
      {lines.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-ink-500">{emptyText}</div>
      ) : (
        <div className="max-h-[28rem] overflow-auto font-mono text-xs leading-relaxed">
          {lines.map((line, i) => (
            <div key={i} className={`flex ${opRow[line.op]}`}>
              <span
                className={`w-6 shrink-0 select-none px-2 text-right ${opGutter[line.op]}`}
              >
                {opSign[line.op]}
              </span>
              <span className="whitespace-pre-wrap break-all px-2 py-px text-slate-300">
                {line.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SideBySideDiffProps {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
}

export function SideBySideDiff({
  before,
  after,
  beforeLabel = "Source (before)",
  afterLabel = "Normalised IR (after)",
}: SideBySideDiffProps) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
        <div className="eyebrow border-b border-ink-700 bg-ink-900/60 px-3 py-1.5 text-bad/80">
          {beforeLabel}
        </div>
        <pre className="max-h-[24rem] overflow-auto px-3 py-3 font-mono text-xs leading-relaxed text-ink-500">
          {before || "—"}
        </pre>
      </div>
      <div className="overflow-hidden rounded-lg border border-good/30 bg-ink-950">
        <div className="eyebrow border-b border-good/20 bg-good/5 px-3 py-1.5 text-good/90">
          {afterLabel}
        </div>
        <pre className="max-h-[24rem] overflow-auto px-3 py-3 font-mono text-xs leading-relaxed text-slate-300">
          {after || "—"}
        </pre>
      </div>
    </div>
  );
}
