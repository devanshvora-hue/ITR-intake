// Server-only: load one case of the signed-in CA's firm by asking the API,
// forwarding the browser's cookies. The API decides the firm from the
// session; the reference only selects a case within that firm.
import { headers } from "next/headers";
import type { CaseDetail } from "./case-review";

const API_ORIGIN = process.env.ITR_API_ORIGIN ?? "http://127.0.0.1:8000";

export type CaCaseState =
  | { state: "found"; detail: CaseDetail }
  | { state: "not_found" }
  | { state: "signed_out" }
  | { state: "unavailable" };

export async function getCaCase(reference: string): Promise<CaCaseState> {
  const cookie = (await headers()).get("cookie") ?? "";
  try {
    const res = await fetch(`${API_ORIGIN}/api/ca/cases/${encodeURIComponent(reference)}`, {
      headers: { cookie },
      cache: "no-store",
    });
    if (res.status === 401) return { state: "signed_out" };
    if (res.status === 404) return { state: "not_found" };
    if (!res.ok) return { state: "unavailable" };
    return { state: "found", detail: (await res.json()) as CaseDetail };
  } catch {
    return { state: "unavailable" };
  }
}
