// Operator command line (there is deliberately no web page for this).
//
//   npm run admin -- list-pending
//   npm run admin -- approve --email ca@example.com --approved-by "Your name"
//
// Reads DATABASE_URL from .env.local (npm run admin passes --env-file).
// Output never includes password hashes, tokens or secrets.

import postgres from "postgres";

const [command, ...rest] = process.argv.slice(2);
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Add it to .env.local first.");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

try {
  if (command === "list-pending") {
    const rows = await sql`
      SELECT u.email_norm AS email, u.full_name, u.status AS user_status, f.name AS firm, f.status AS firm_status,
             u.email_verified_at IS NOT NULL AS email_verified
      FROM ca_users u JOIN firms f ON f.id = u.firm_id
      WHERE u.status = 'pending' OR f.status IN ('pending_verification', 'pending_approval')
      ORDER BY u.created_at`;
    if (rows.length === 0) console.log("No accounts are waiting for approval.");
    for (const r of rows) {
      console.log(`${r.email}  ${r.full_name}  firm="${r.firm}"  user=${r.user_status}  firm=${r.firm_status}  `
        + `email_verified=${r.email_verified}`);
    }
  } else if (command === "approve") {
    const email = (option("email") ?? "").trim().toLowerCase();
    const approvedBy = (option("approved-by") ?? "").trim();
    if (!email || !approvedBy) {
      console.error('Usage: npm run admin -- approve --email <email> --approved-by "<your name>"');
      process.exit(2);
    }
    const result = await sql.begin(async (tx) => {
      const [user] = await tx`SELECT u.id, u.firm_id, u.status, u.email_verified_at, f.status AS firm_status
                              FROM ca_users u JOIN firms f ON f.id = u.firm_id WHERE u.email_norm = ${email}`;
      if (!user) return "not_found";
      if (!user.email_verified_at) return "email_not_verified";
      if (user.status === "disabled" || user.firm_status === "suspended") return "account_disabled";
      await tx`UPDATE firms SET status = 'active', approved_at = COALESCE(approved_at, now()), approved_by = ${approvedBy},
               updated_at = now() WHERE id = ${user.firm_id}`;
      await tx`UPDATE ca_users SET status = 'active', updated_at = now() WHERE id = ${user.id}`;
      await tx`INSERT INTO audit_events (firm_id, actor_kind, actor_id, action) VALUES (${user.firm_id}, 'admin', ${approvedBy}, 'ca.approved')`;
      return "approved";
    });
    const messages = {
      approved: `Approved ${email}. They can sign in now.`,
      not_found: "No CA account with that email.",
      email_not_verified: "That account has not confirmed its email yet. Ask them to open the verification link first.",
      account_disabled: "That account or its firm is disabled.",
    };
    console.log(messages[result]);
    process.exitCode = result === "approved" ? 0 : 1;
  } else {
    console.log("Commands: list-pending | approve --email <email> --approved-by \"<name>\"");
    process.exitCode = 2;
  }
} catch (error) {
  console.error("Database error:", error?.code ?? error?.name ?? "unknown");
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
