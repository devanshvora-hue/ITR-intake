// Types and labels for supporting-document requests (Stage 5.9). Shapes mirror
// document_requests.request_view: CA views carry file IDs (needed to
// download); client views never do.

import { toneClasses } from "./tones";

export type RequestStatus = "requested" | "received" | "waived";

export type RequestFile = {
  id?: string;
  display_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_at: string;
};

export type DocumentRequest = {
  id: string;
  label: string;
  description: string | null;
  required: boolean;
  status: RequestStatus;
  created_at: string;
  files: RequestFile[];
};

// Server limits (also imported by lib/server/documents.ts). Shown to the client
// for guidance; the server remains the authority. Vercel's request body limit
// is about 4.5 MB, so one file is at most 4 MB.
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 5;
export const DOCUMENT_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  requested: "Waiting for upload",
  received: "Received",
  waived: "Waived",
};

export const REQUEST_STATUS_TONES: Record<string, string> = toneClasses<RequestStatus>({
  requested: "warning",
  received: "success",
  waived: "neutral",
});

// Safe messages for the server's fixed error codes.
export const DOCUMENT_ERRORS: Record<string, string> = {
  empty_file: "The file is empty.",
  unsupported_file_type: "Only PDF, JPEG and PNG files are accepted.",
  type_mismatch: "The file does not match its type. Please upload a real PDF, JPEG or PNG.",
  file_too_large: "The file is larger than 4 MB.",
  truncated_file: "The file looks incomplete. Please download it again and retry.",
  case_closed: "This case is closed.",
  request_waived: "Your CA has waived this request, so no upload is needed.",
  already_uploaded_for_another_request: "This file was already uploaded for a different request.",
  file_limit_reached: "The limit of 5 files for this request has been reached.",
  invalid_transition: "This request has already changed. Reload to see its current state.",
  rate_limited: "Too many attempts. Please try again later.",
};

export function documentError(status: number, code: unknown, fallback: string): string {
  if (status === 0) return "The server is not reachable. Check your connection and try again.";
  if (status === 413) return DOCUMENT_ERRORS.file_too_large;
  if (status === 429) return DOCUMENT_ERRORS.rate_limited;
  return (typeof code === "string" && DOCUMENT_ERRORS[code]) || fallback;
}
