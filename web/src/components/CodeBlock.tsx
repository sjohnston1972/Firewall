import type { ReactNode } from "react";

interface CodeBlockProps {
  children: ReactNode;
  label?: string;
  className?: string;
}

export function CodeBlock({ children, label, className = "" }: CodeBlockProps) {
  return (
    <div className={`overflow-hidden rounded-lg border border-ink-700 bg-ink-950 ${className}`}>
      {label && (
        <div className="eyebrow border-b border-ink-700 bg-ink-900/60 px-3 py-1.5">
          {label}
        </div>
      )}
      <pre className="overflow-x-auto px-3 py-3 font-mono text-xs leading-relaxed text-slate-300">
        {children}
      </pre>
    </div>
  );
}
