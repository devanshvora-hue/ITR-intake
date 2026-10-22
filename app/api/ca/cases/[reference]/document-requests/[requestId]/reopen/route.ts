import { documentStatusRoute } from "@/lib/server/document-status-route";

export const runtime = "nodejs";

export const POST = documentStatusRoute("reopen");
