export interface StepDef {
  key: string;
  label: string;
  hint: string;
}

interface StepBarProps {
  steps: StepDef[];
  current: number;
  furthest: number; // highest step reached — earlier steps are revisitable
  onJump: (index: number) => void;
}

/**
 * The pipeline spine (CLAUDE.md §4.1). Steps are a genuine sequence — Connect →
 * Discover → … → Verify — so they're numbered and wired together with a rail.
 * Vertical on desktop, horizontal scroller on small screens.
 */
export function StepBar({ steps, current, furthest, onJump }: StepBarProps) {
  return (
    <nav aria-label="Build pipeline">
      {/* Desktop: vertical spine */}
      <ol className="hidden md:block">
        {steps.map((step, i) => {
          const state =
            i === current ? "current" : i < current ? "done" : i <= furthest ? "ahead" : "locked";
          const reachable = i <= furthest;
          const isLast = i === steps.length - 1;
          return (
            <li key={step.key} className="relative pl-9">
              {/* rail */}
              {!isLast && (
                <span
                  aria-hidden
                  className={`absolute left-[0.6875rem] top-6 h-[calc(100%-0.5rem)] w-px ${
                    i < current ? "bg-accent/50" : "bg-ink-700"
                  }`}
                />
              )}
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && onJump(i)}
                className="group flex w-full items-center gap-3 py-2 text-left disabled:cursor-not-allowed"
              >
                {/* node */}
                <span
                  aria-hidden
                  className={`absolute left-0 flex h-6 w-6 items-center justify-center rounded-full border font-mono text-[10px] transition-colors ${
                    state === "current"
                      ? "node-active border-accent bg-accent text-ink-950"
                      : state === "done"
                        ? "border-accent/60 bg-accent-soft text-accent"
                        : reachable
                          ? "border-ink-600 bg-ink-800 text-ink-500 group-hover:border-ink-500"
                          : "border-ink-700 bg-ink-900 text-ink-700"
                  }`}
                >
                  {state === "done" ? "✓" : String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-medium ${
                      state === "current"
                        ? "text-slate-100"
                        : reachable
                          ? "text-slate-300 group-hover:text-slate-100"
                          : "text-ink-600"
                    }`}
                  >
                    {step.label}
                  </span>
                  <span className="block truncate text-[11px] text-ink-500">{step.hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {/* Mobile: horizontal scroller */}
      <ol className="flex gap-2 overflow-x-auto pb-2 md:hidden">
        {steps.map((step, i) => {
          const reachable = i <= furthest;
          const active = i === current;
          return (
            <li key={step.key} className="shrink-0">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && onJump(i)}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${
                  active
                    ? "border-accent bg-accent-soft/40 text-slate-100"
                    : reachable
                      ? "border-ink-600 bg-ink-800 text-slate-300"
                      : "border-ink-700 bg-ink-900 text-ink-600"
                }`}
              >
                <span className="font-mono text-[10px]">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-xs font-medium">{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
