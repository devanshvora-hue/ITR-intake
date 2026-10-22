import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard, authLink } from "@/components/ca/AuthCard";
import { ForgotPasswordForm } from "@/components/ca/ForgotPasswordForm";

export const metadata: Metadata = { title: "Forgot password · ITR Intake" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      eyebrow="CA dashboard"
      title="Reset your password"
      intro="Enter your account email. If an account exists, we will send a one-time reset link."
      footer={
        <Link href="/ca/login" className={authLink}>
          ← Back to sign in
        </Link>
      }
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
