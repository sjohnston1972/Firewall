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
        (checked ? "bg-accent shadow-[0_0_12px_-2px_rgba(79,156,249,0.8)]" : "bg-ink-600")
      }
    >
      <span
        className={
          // Fixed near-white knob with a hairline ring so it reads on the accent
          // track AND the off track in both light and dark themes.
          "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow ring-1 ring-black/10 transition-transform " +
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
  /** rich hover detail — shown as a tooltip on hover/focus */
  detail?: string;
}

export function ToggleCard({ title, description, checked, onChange, tag, detail }: ToggleCardProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      title={detail}
      className={
        "group relative flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-all duration-200 " +
        (checked
          ? "border-accent bg-accent-soft/40 shadow-[0_0_0_1px_rgba(79,156,249,0.55),0_0_24px_-6px_rgba(79,156,249,0.65)]"
          : "border-ink-700 bg-ink-900/50 hover:border-ink-600 hover:bg-ink-800/50")
      }
    >
      <Toggle checked={checked} onChange={onChange} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className={
              "text-[13px] font-medium transition-colors " +
              (checked ? "text-accent" : "text-slate-100")
            }
          >
            {title}
          </span>
          {tag && (
            <span className="eyebrow rounded bg-ink-700 px-1.5 py-0.5 text-ink-500">
              {tag}
            </span>
          )}
          {detail && <span className="ml-auto text-[11px] text-ink-600 group-hover:text-accent">ⓘ</span>}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-ink-500">
          {description}
        </span>
      </span>
      {detail && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-2 right-2 top-full z-30 mt-1 hidden rounded-md border border-ink-600 bg-ink-950/98 p-2.5 text-[11px] leading-relaxed text-slate-200 shadow-xl group-hover:block group-focus-visible:block"
        >
          {detail}
        </span>
      )}
    </button>
  );
}
