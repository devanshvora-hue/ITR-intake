"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/api-client";

export function ClientLogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    await postJson("/api/client/logout");
    router.replace("/client");
    router.refresh();
    setBusy(false);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium transition-colors hover:border-ink-faint disabled:opacity-60"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
