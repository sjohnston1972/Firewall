import type { ReactNode } from "react";

type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

interface StatusBadgeProps {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
}

const tones: Record<Tone, string> = {
  neutral: "border-ink-600 bg-ink-800 text-ink-500",
  good: "border-good/30 bg-good/10 text-good",
  warn: "border-warn/30 bg-warn/10 text-warn",
  bad: "border-bad/30 bg-bad/10 text-bad",
  accent: "border-accent/30 bg-accent/10 text-accent",
};

const dotColor: Record<Tone, string> = {
  neutral: "bg-ink-500",
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  accent: "bg-accent",
};

export function StatusBadge({ tone = "neutral", children, dot }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] tracking-wide ${tones[tone]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dotColor[tone]}`} />}
      {children}
    </span>
  );
}
