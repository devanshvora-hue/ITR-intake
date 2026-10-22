// Register, verify and approve a synthetic CA, returning a signed-in client.

import { expect } from "vitest";
import { POST as login } from "@/app/api/ca/login/route";
import { POST as register } from "@/app/api/ca/register/route";
import { POST as verifyEmail } from "@/app/api/ca/verify-email/route";
import { approveCa } from "@/lib/server/ca-auth";
import { Client, env, mailedToken, PASSWORD } from "./http";

export async function onboardCa(tag = "a"): Promise<Client> {
  const ca = new Client();
  await ca.post(register, { full_name: `CA ${tag} (synthetic)`, email: `ca-${tag}@example.test`, password: PASSWORD,
    firm_name: `Firm ${tag} (synthetic)` });
  await ca.post(verifyEmail, { token: await mailedToken(`ca-${tag}@example.test`) });
  await approveCa(env.db, { email: `ca-${tag}@example.test`, approvedBy: "Operator (synthetic)" });
  const response = await ca.post(login, { email: `ca-${tag}@example.test`, password: PASSWORD });
  expect(response.status).toBe(200);
  return ca;
}
