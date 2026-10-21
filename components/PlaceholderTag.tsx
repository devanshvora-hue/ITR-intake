export function PlaceholderTag({ children = "Coming in a later stage" }: { children?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink-faint/60 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-ink-faint">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ink-faint/60" />
      {children}
    </span>
  );
}
