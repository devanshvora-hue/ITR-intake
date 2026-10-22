import type { Metadata } from "next";
import { AuthCard } from "@/components/ca/AuthCard";
import { VerifyEmail } from "@/components/ca/VerifyEmail";

export const metadata: Metadata = { title: "Verify email · ITR Intake", referrer: "no-referrer" };

export default function VerifyEmailPage() {
  return (
    <AuthCard eyebrow="CA onboarding" title="Verify your email">
      <VerifyEmail />
    </AuthCard>
  );
}
