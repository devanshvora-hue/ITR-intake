// Shown only when the API reports that e-mail delivery is simulated
// (development mode). It makes clear that no e-mail was sent.

export function DevEmailNotice({ outboxUrl }: { outboxUrl?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-amber-ink/40 bg-amber-wash px-4 py-3 text-sm text-amber-ink">
      <p className="font-semibold">Development simulation: no email was sent.</p>
      <p className="mt-1">
        In local development, messages are placed in a developer outbox on this
        computer instead of being emailed.
        {outboxUrl && (
          <>
            {" "}
            Open{" "}
            <a href={outboxUrl} target="_blank" rel="noreferrer" className="font-medium underline">
              the developer outbox
            </a>{" "}
            and follow the link there.
          </>
        )}
      </p>
    </div>
  );
}
