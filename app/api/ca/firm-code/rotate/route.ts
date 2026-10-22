import { firmCodeChange } from "@/lib/server/firm-code-route";
import { rotateFirmCode } from "@/lib/server/firm-codes";
import { apiRoute, json } from "@/lib/server/http";

export const runtime = "nodejs";

export const POST = apiRoute((request) => firmCodeChange(request, async (db, principal) =>
  json({ firm_code: await rotateFirmCode(db, principal) })));
