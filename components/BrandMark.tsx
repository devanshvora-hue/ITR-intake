// The ITR Intake symbol: an open isometric box with a sheet dropping into it,
// on its own midnight tile so it reads the same on light and dark pages.
// Decorative by default; pass a label when the mark stands alone.

export function BrandMark({ size = 28, label }: { size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={label ? "img" : undefined} aria-label={label}
         aria-hidden={label ? undefined : true} focusable="false" className="shrink-0">
      <rect width="32" height="32" rx="8" fill="#101421" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="#30384e" />
      {/* box opening */}
      <path d="M16 9.5 25 14 16 18.5 7 14Z" fill="#0b1230" />
      {/* the sheet, partly inside the box */}
      <path d="M12.5 5.5 19.5 9v8.5l-7-3.5Z" fill="#f0f3f8" />
      <path d="M14 8.6 18 10.6M14 10.6 18 12.6" stroke="#519cff" strokeWidth="1" strokeLinecap="round" />
      {/* front faces */}
      <path d="M7 14 16 18.5V27L7 22.5Z" fill="#2583ff" />
      <path d="M16 18.5 25 14v8.5L16 27Z" fill="#1d4fc4" />
      <path d="M7 14 16 18.5 25 14" fill="none" stroke="#9cc6ff" strokeWidth="0.8" strokeLinejoin="round" />
    </svg>
  );
}

/** Symbol and wordmark together. The visible text is the accessible name. */
export function BrandLockup({ size = 28 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark size={size} />
      <span className="text-[15px] leading-none font-semibold tracking-tight">
        ITR <span className="font-normal">Intake</span>
      </span>
    </span>
  );
}
