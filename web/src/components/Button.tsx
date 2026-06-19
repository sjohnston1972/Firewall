import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium " +
  "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 " +
  "focus-visible:outline-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-ink-950 hover:bg-[#6bb0ff] shadow-[0_0_0_1px_rgba(79,156,249,0.4)]",
  danger:
    "bg-bad text-ink-950 hover:bg-[#ff9090] shadow-[0_0_0_1px_rgba(248,113,113,0.4)]",
  ghost:
    "bg-transparent text-slate-200 border border-ink-600 hover:border-ink-500 hover:bg-ink-800",
  subtle: "bg-ink-700 text-slate-200 hover:bg-ink-600 border border-ink-600",
};

const sizes: Record<Size, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-4 py-2.5",
};

export function Button({
  variant = "subtle",
  size = "md",
  loading = false,
  disabled,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading && (
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
