import { VENDORS, type Vendor } from "../types";

interface VendorToggleProps {
  value: Vendor;
  onChange: (next: Vendor) => void;
  disabled?: boolean;
}

export function VendorToggle({ value, onChange, disabled }: VendorToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Target vendor"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
    >
      {VENDORS.map((v) => {
        const active = v.id === value;
        return (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(v.id)}
            className={
              "flex flex-col items-start rounded-lg border px-3.5 py-3 text-left transition-all " +
              "disabled:cursor-not-allowed disabled:opacity-50 " +
              (active
                ? "border-accent bg-accent-soft/40 shadow-[0_0_0_1px_rgba(79,156,249,0.4)]"
                : "border-ink-700 bg-ink-900/50 hover:border-ink-600")
            }
          >
            <span className="flex w-full items-center justify-between">
              <span
                className={`text-sm font-semibold ${active ? "text-accent" : "text-slate-200"}`}
              >
                {v.label}
              </span>
              {v.cloudManaged && (
                <span className="eyebrow rounded bg-ink-700 px-1.5 py-0.5 text-ink-500">
                  cloud
                </span>
              )}
            </span>
            <span className="mt-1 font-mono text-[11px] text-ink-500">{v.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}
