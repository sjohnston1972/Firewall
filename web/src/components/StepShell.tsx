import type { ReactNode } from "react";
import { Button } from "./Button";

interface StepShellProps {
  step: number;
  total: number;
  eyebrow: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  /** footer nav */
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextLoading?: boolean;
  backLabel?: string;
  footerNote?: ReactNode;
}

/**
 * Common chrome for every wizard step: a numbered header and a sticky footer
 * with Back / Next so the flow feels consistent end to end.
 */
export function StepShell({
  step,
  total,
  eyebrow,
  title,
  intro,
  children,
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled,
  nextLoading,
  backLabel = "Back",
  footerNote,
}: StepShellProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="mb-6">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-accent">
            {String(step).padStart(2, "0")}
            <span className="text-ink-600"> / {String(total).padStart(2, "0")}</span>
          </span>
          <span className="eyebrow">{eyebrow}</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-50">{title}</h1>
        {intro && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-500">{intro}</p>}
      </header>

      <div className="flex-1 space-y-6">{children}</div>

      {(onBack || onNext) && (
        <footer className="sticky bottom-0 -mx-1 mt-8 flex items-center justify-between gap-4 border-t border-ink-700 bg-ink-950/90 px-1 py-4 backdrop-blur">
          <div>
            {onBack && (
              <Button variant="ghost" onClick={onBack}>
                ← {backLabel}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-4">
            {footerNote && <span className="text-xs text-ink-500">{footerNote}</span>}
            {onNext && (
              <Button
                variant="primary"
                onClick={onNext}
                disabled={nextDisabled}
                loading={nextLoading}
              >
                {nextLabel} →
              </Button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}
