"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/api-client";
import { FormMessage } from "./Field";

type State = "checking" | "verified" | "failed" | "missing" | "unavailable";

async function verify(token: string | null): Promise<State> {
  if (!token) return "missing";
  const result = await postJson("/api/ca/verify-email", { token });
  if (result.ok) return "verified";
  return result.status === 0 ? "unavailable" : "failed";
}

// The token is carried in the URL fragment (#token=...), which browsers never
// send to a server, so it does not end up in server logs. It is removed from
// the address bar as soon as it has been read.
export function VerifyEmail() {
  const [state, setState] = useState<State>("checking");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    window.history.replaceState(null, "", window.location.pathname);
    verify(token).then(setState);
  }, []);

  if (state === "checking") return <FormMessage tone="info">Checking your verification link…</FormMessage>;
  if (state === "verified")
    return (
      <div className="space-y-4">
        <FormMessage tone="info">Your email address is verified.</FormMessage>
        <p className="text-sm text-ink-soft">
          Your account is now <strong className="font-medium text-ink">awaiting administrator approval</strong>.
          Verification alone does not activate it; you will be able to sign in once an administrator
          has approved your firm.
        </p>
        <Link href="/ca/login" className="inline-block text-sm font-medium text-teal underline">
          Go to sign in
        </Link>
      </div>
    );
  if (state === "unavailable") return <FormMessage tone="error">The ITR Intake server is not reachable. Is it running?</FormMessage>;
  return (
    <FormMessage tone="error">
      This verification link is invalid or has expired. Links work once and expire after 24 hours.
    </FormMessage>
  );
}
