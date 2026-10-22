"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FormMessage } from "@/components/ca/Field";
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

  if (state === "checking") return <FormMessage tone="info">Checking your link…</FormMessage>;
  if (state === "unavailable") return <FormMessage tone="error">The ITR Intake server is not reachable. Please try again later.</FormMessage>;
  if (state === "limited") return <FormMessage tone="error">Too many attempts. Please try again later.</FormMessage>;
  return (
    <div className="space-y-4">
      <FormMessage tone="error">
        This link is invalid or has expired. Links work once and expire after 30 minutes.
      </FormMessage>
      <Link href="/client" className="inline-block text-sm font-medium text-teal underline">
        Start again
      </Link>
    </div>
  );
}
