export function AuthCard({ eyebrow, title, intro, children, footer }: {
  eyebrow: string;
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">{eyebrow}</p>
      <h1 className="mt-3 font-serif text-3xl font-medium tracking-tight">{title}</h1>
      {intro && <div className="mt-3 text-sm leading-relaxed text-ink-soft">{intro}</div>}
      <div className="mt-8 rounded-2xl border border-line bg-white p-6">{children}</div>
      {footer && <div className="mt-6 text-sm text-ink-soft">{footer}</div>}
    </div>
  );
}
