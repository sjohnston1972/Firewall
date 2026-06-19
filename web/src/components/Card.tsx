import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className = "" }: CardProps) {
  return (
    <div
      className={`rounded-xl border border-ink-700 bg-ink-900/70 backdrop-blur-sm ${className}`}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function CardHeader({ eyebrow, title, description, action }: CardHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-4">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-ink-500">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardBody({ children, className = "" }: CardProps) {
  return <div className={`px-5 py-5 ${className}`}>{children}</div>;
}
