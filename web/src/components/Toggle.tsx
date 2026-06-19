interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}

export function Toggle({ checked, onChange, label, disabled, id }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors " +
        "disabled:opacity-40 focus-visible:outline-none " +
        (checked ? "bg-accent" : "bg-ink-600")
      }
    >
      <span
        className={
          "inline-block h-3.5 w-3.5 transform rounded-full bg-ink-950 shadow transition-transform " +
          (checked ? "translate-x-[1.15rem]" : "translate-x-1")
        }
      />
    </button>
  );
}

interface ToggleCardProps {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  tag?: string;
}

export function ToggleCard({ title, description, checked, onChange, tag }: ToggleCardProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className={
        "group flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-all " +
        (checked
          ? "border-accent/60 bg-accent-soft/30 shadow-[0_0_0_1px_rgba(79,156,249,0.25)]"
          : "border-ink-700 bg-ink-900/50 hover:border-ink-600")
      }
    >
      <Toggle checked={checked} onChange={onChange} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-100">{title}</span>
          {tag && (
            <span className="eyebrow rounded bg-ink-700 px-1.5 py-0.5 text-ink-500">
              {tag}
            </span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-ink-500">
          {description}
        </span>
      </span>
    </button>
  );
}
