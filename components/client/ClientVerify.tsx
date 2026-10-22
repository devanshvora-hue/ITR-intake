"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FormMessage } from "@/components/ca/Field";
import { buttonClasses } from "@/components/ui/Button";
import { postJson } from "@/lib/api-client";

type State = "checking" | "failed" | "missing" | "unavailable" | "limited";

async function verify(token: string | null): Promise<State | "signed_in"> {
  if (!token) return "missing";
  const result = await postJson("/api/client/verify", { token });
  if (result.ok) return "signed_in";
  if (result.status === 0) return "unavailable";
  if (result.status === 429) return "limited";
  // A link that was already used may belong to a session this browser already has.
  const me = await fetch("/api/client/me", { credentials: "same-origin" }).catch(() => null);
  return me?.ok ? "signed_in" : "failed";
}

// The token is carried in the URL fragment (#token=...), which browsers never
// send to a server. It is read once, removed from the address bar, and sent to
// the API, which answers with an HttpOnly session cookie.
export function ClientVerify() {
  const router = useRouter();
  const [state, setState] = useState<State>("checking");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React may run this twice in development
    started.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    window.history.replaceState(null, "", window.location.pathname);
    verify(token).then((next) => {
      if (next === "signed_in") {
        router.replace("/client");
        router.refresh();
      } else {
        setState(next);
      }
    });
  }, [router]);

  if (state === "checking") {
    return (
      <div role="status" className="flex items-start gap-3">
        <span aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 rounded-full border-2 border-line border-t-accent motion-safe:animate-spin" />
        <div>
          <p className="text-sm font-medium">Checking your link…</p>
          <p className="mt-1 text-sm text-ink-soft">When it is confirmed, your intake opens on its own.</p>
        </div>
      </div>
    );
  }
  // The link was taken out of the address bar when the page opened, so it cannot be retried from here:
  // every outcome below leads back to the client portal.
  return (
    <div className="space-y-5">
      {state === "unavailable" && (
        <FormMessage tone="error">The ITR Intake server is not reachable. Please try again later.</FormMessage>
      )}
      {state === "limited" && <FormMessage tone="error">Too many attempts. Please try again later.</FormMessage>}
      {(state === "failed" || state === "missing") && (
        <>
          <FormMessage tone="error">
            This link is invalid or has expired. Links work once and expire after 30 minutes.
          </FormMessage>
          <p className="text-sm text-ink-soft">
            Start again on the client portal with your firm code and email address.
          </p>
        </>
      )}
      <Link href="/client" className={`${buttonClasses({ size: "lg" })} block w-full text-center`}>
        {state === "failed" || state === "missing" ? "Start again" : "Back to the client portal"}
      </Link>
    </div>
  );
}
