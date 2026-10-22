// Server-only: resolve the visitor's client session by asking the API,
// forwarding the browser's cookies. The API remains the authority; it derives
// the client, firm and firm code from the session, never from the browser.
import type { DocumentRequest } from "./document-requests";
import { apiGet } from "./self-api";
import type { StatementUpload } from "./statements";


export type ClientProfile = {
  full_name: string | null;
  bank_name: string | null;
  account_last4: string | null;
  complete: boolean;
};

export type ClientCase = {
  reference: string;
  financial_year: string;
  status: string;
  created_at: string;
  updated_at: string;
  profile: ClientProfile;
  statements: StatementUpload[];
  document_requests: DocumentRequest[];
};

export type UploadLimits = { pdf_bytes: number; csv_bytes: number; statements_per_case: number; pdf_pages: number };

export type ClientMe = {
  client: { email: string };
  firm: { name: string };
  cases: ClientCase[];
  financial_years: string[];
  can_open_case: boolean;
  upload_limits: UploadLimits;
};

export type ClientSessionState =
  | { state: "signed_in"; me: ClientMe }
  | { state: "signed_out" }
  | { state: "unavailable" };

export async function getClientSession(): Promise<ClientSessionState> {
  try {
    const res = await apiGet("/api/client/me");
    if (res.status === 401) return { state: "signed_out" };
    if (!res.ok) return { state: "unavailable" };
    return { state: "signed_in", me: (await res.json()) as ClientMe };
  } catch {
    return { state: "unavailable" };
  }
}
