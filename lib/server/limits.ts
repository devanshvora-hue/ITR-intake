// Abuse limits per one-hour window (same values as the Python API). Counters
// hold hashes only. "Per address" limits use the caller's address on Vercel
// (see http.clientAddress) and are a shared ceiling elsewhere.

export const limits = {
  RESET_REQUESTS_PER_EMAIL: 3,
  RESET_REQUESTS_PER_ADDRESS: 60,
  RESET_REQUESTS_ALL: 300,
  RESET_ATTEMPTS_PER_ADDRESS: 60,
  RESET_ATTEMPTS_ALL: 600,
  RESEND_VERIFICATION_PER_EMAIL: 3,
  FIRM_CODE_CHANGES_PER_FIRM: 10,
  FIRM_CODE_CHANGES_PER_ADDRESS: 60,
  CLIENT_STARTS_PER_EMAIL: 5,
  CLIENT_STARTS_PER_ADDRESS: 60,
  CLIENT_STARTS_ALL: 300,
  CLIENT_BAD_CODES_PER_ADDRESS: 30, // invalid firm codes; past this, the address gets no e-mails for the window
  CLIENT_VERIFY_PER_ADDRESS: 60,
  CLIENT_VERIFY_ALL: 600,
  CLIENT_CASES_PER_CLIENT: 20,
  CLIENT_PROFILE_UPDATES_PER_CLIENT: 30,
};
