import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

function FieldShell({ label, hint, htmlFor, children, className = "" }: FieldShellProps) {
  return (
    <label htmlFor={htmlFor} className={`block ${className}`}>
      <span className="eyebrow mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded-md border border-ink-600 bg-ink-950/80 px-3 py-2 text-sm " +
  "text-slate-100 placeholder:text-ink-500 transition-colors " +
  "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  mono?: boolean;
}

export function Field({ label, hint, mono, className = "", id, ...rest }: FieldProps) {
  return (
    <FieldShell label={label} hint={hint} htmlFor={id} className={className}>
      <input id={id} className={`${inputCls} ${mono ? "font-mono" : ""}`} {...rest} />
    </FieldShell>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}

export function SelectField({
  label,
  hint,
  className = "",
  id,
  children,
  ...rest
}: SelectFieldProps) {
  return (
    <FieldShell label={label} hint={hint} htmlFor={id} className={className}>
      <select id={id} className={`${inputCls} cursor-pointer appearance-none`} {...rest}>
        {children}
      </select>
    </FieldShell>
  );
}
