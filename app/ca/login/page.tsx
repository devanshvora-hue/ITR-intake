import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/ca/AuthCard";
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
        <>
          New firm?{" "}
          <Link href="/ca/register" className="font-medium text-teal underline">
            Register a CA account
          </Link>
          {" · "}
          <Link href="/ca/forgot-password" className="font-medium text-teal underline">
            Forgot password?
          </Link>
        </>
      }
    >
      {session.state === "unavailable" && (
        <p className="mb-4 rounded-lg bg-rose-wash px-3 py-2 text-sm text-rose-ink">
          The ITR Intake server is not reachable. Start it, then reload this page.
        </p>
      )}
      <LoginForm />
    </AuthCard>
  );
}
