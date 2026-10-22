// The frame for the sign-in style pages: the CA sign-in, registration and
// password pages (dark, inside the CA shell) and the client link check (light,
// inside the site frame). Colours come from tokens, so the same markup suits
// both themes. A thin accent rule marks the top of the form card.
export function AuthCard({ eyebrow, title, intro, children, footer, wide = false }: {
  eyebrow: string;
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** A wider card for longer forms (registration). */
  wide?: boolean;
}) {
  return (
    <div className={`mx-auto w-full px-4 py-10 sm:px-6 sm:py-16 ${wide ? "max-w-xl" : "max-w-md"}`}>
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">{eyebrow}</p>
      <h1 className="mt-3 font-serif text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      {intro && <div className="mt-3 text-sm leading-relaxed text-ink-soft">{intro}</div>}
      <div className="mt-7 overflow-hidden rounded-2xl border border-line bg-surface">
        <div aria-hidden="true" className="h-0.5 bg-accent" />
        <div className="p-5 sm:p-7">{children}</div>
      </div>
      {footer && <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-soft">{footer}</div>}
    </div>
  );
}

/** A text link on an auth page; underlined, so it is not told apart by colour alone. */
export const authLink = "font-medium text-teal underline underline-offset-2";
