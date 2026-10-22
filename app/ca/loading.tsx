// Shown while a CA page waits for its data (the dashboard and case pages ask
// the API on every request). Placeholder blocks only; the pulse respects
// reduced motion.
export default function CaLoading() {
  const block = "rounded-2xl border border-line bg-surface motion-safe:animate-pulse";
  return (
    <div role="status" aria-live="polite" className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true">
        <div className="h-3 w-28 rounded bg-paper-deep motion-safe:animate-pulse" />
        <div className="mt-4 h-8 w-64 max-w-full rounded bg-paper-deep motion-safe:animate-pulse" />
        <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className={`h-24 ${block}`} />)}
        </div>
        <div className={`mt-8 h-64 ${block}`} />
      </div>
    </div>
  );
}
