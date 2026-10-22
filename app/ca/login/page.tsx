import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard, authLink } from "@/components/ca/AuthCard";
import { FormMessage } from "@/components/ui/FormMessage";
import { LoginForm } from "@/components/ca/LoginForm";
import { getCaSession } from "@/lib/ca-session";

export const metadata: Metadata = { title: "CA sign in · ITR Intake" };
export const dynamic = "force-dynamic";

export default async function CaLoginPage() {
  const session = await getCaSession();
  if (session.state === "signed_in") redirect("/ca");

  return (
    <AuthCard
      eyebrow="CA dashboard"
      title="Sign in"
      intro="For registered CA firm accounts. Clients do not sign in here."
      footer={
        <p>
          New firm?{" "}
          <Link href="/ca/register" className={authLink}>
            Register a CA account
          </Link>
        </p>
      }
    >
      {session.state === "unavailable" && (
        <div className="mb-5">
          <FormMessage tone="error">The ITR Intake server is not reachable. Start it, then reload this page.</FormMessage>
        </div>
      )}
      <LoginForm />
    </AuthCard>
  );
}
