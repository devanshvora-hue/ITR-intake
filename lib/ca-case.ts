// Server-only: load one case of the signed-in CA's firm by asking the API,
// forwarding the browser's cookies. The API decides the firm from the
// session; the reference only selects a case within that firm.
import type { CaseDetail } from "./case-review";
import { apiGet } from "./self-api";

export type CaCaseState =
  | { state: "found"; detail: CaseDetail }
  | { state: "not_found" }
  | { state: "signed_out" }
  | { state: "unavailable" };

export async function getCaCase(reference: string): Promise<CaCaseState> {
  try {
    const res = await apiGet(`/api/ca/cases/${encodeURIComponent(reference)}`);
    if (res.status === 401) return { state: "signed_out" };
    if (res.status === 404) return { state: "not_found" };
    if (!res.ok) return { state: "unavailable" };
    return { state: "found", detail: (await res.json()) as CaseDetail };
  } catch {
    return { state: "unavailable" };
  }
}
