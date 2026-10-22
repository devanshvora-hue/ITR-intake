// Server-only: resolve the visitor's CA session by asking the API, forwarding
// the browser's cookies. Used by server components to protect CA pages; the
// API remains the authority on every request.
import type { CaseReadiness } from "./case-readiness";
import { apiGet } from "./self-api";
import type { StatementUpload } from "./statements";

export type CaMe = {
  user: { full_name: string; email: string; role: string };
  firm: { name: string; status: string };
  session: { idle_expires_at: string; absolute_expires_at: string };
};

export type CaCase = {
  reference: string;
  financial_year: string;
  status: string;
  updated_at: string;
  created_at: string;
  client_first_name: string;
  client_email: string;
  profile: { full_name: string | null; bank_name: string | null; account_last4: string | null; complete: boolean };
  readiness: CaseReadiness;
};

export type CaStatement = StatementUpload & {
  case_reference: string;
  client_first_name: string;
  financial_year: string;
  bank_name: string | null;
};

export type FirmCode = {
  code: string;
  display: string;
  status: "active" | "revoked";
  created_at: string;
  revoked_at: string | null;
};

export type FirmCodeState = { active: FirmCode | null; previous: FirmCode[]; can_manage: boolean };

export type CaSessionState =
  | { state: "signed_in"; me: CaMe; cases: CaCase[]; firmCode: FirmCodeState | null; statements: CaStatement[] }
  | { state: "signed_out" }
  | { state: "unavailable" };

export async function getCaSession({ withCases = false, withFirmCode = false, withStatements = false } = {}):
  Promise<CaSessionState> {
  try {
    const meRes = await apiGet("/api/ca/me");
    if (meRes.status === 401) return { state: "signed_out" };
    if (!meRes.ok) return { state: "unavailable" };
    const me = (await meRes.json()) as CaMe;
    let cases: CaCase[] = [];
    if (withCases) {
      const casesRes = await apiGet("/api/ca/cases");
      if (casesRes.status === 401) return { state: "signed_out" };
      if (!casesRes.ok) return { state: "unavailable" };
      cases = ((await casesRes.json()) as { cases: CaCase[] }).cases;
    }
    let firmCode: FirmCodeState | null = null;
    if (withFirmCode) {
      const codeRes = await apiGet("/api/ca/firm-code");
      if (codeRes.status === 401) return { state: "signed_out" };
      if (!codeRes.ok) return { state: "unavailable" };
      firmCode = (await codeRes.json()) as FirmCodeState;
    }
    let statements: CaStatement[] = [];
    if (withStatements) {
      const res = await apiGet("/api/ca/statements");
      if (res.status === 401) return { state: "signed_out" };
      if (!res.ok) return { state: "unavailable" };
      statements = ((await res.json()) as { statements: CaStatement[] }).statements;
    }
    return { state: "signed_in", me, cases, firmCode, statements };
  } catch {
    return { state: "unavailable" };
  }
}
