// Register a synthetic CA firm, returning the client that registration signed in.

import { expect } from "vitest";
import { POST as register } from "@/app/api/ca/register/route";
import { Client, PASSWORD } from "./http";

export async function onboardCa(tag = "a"): Promise<Client> {
  const ca = new Client();
  const response = await ca.post(register, { full_name: `CA ${tag} (synthetic)`, email: `ca-${tag}@example.test`,
    password: PASSWORD, firm_name: `Firm ${tag} (synthetic)` });
  expect(response.status).toBe(201);
  return ca;
}
