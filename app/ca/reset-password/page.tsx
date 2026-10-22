import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard, authLink } from "@/components/ca/AuthCard";
import { ResetPasswordForm } from "@/components/ca/ResetPasswordForm";

export const metadata: Metadata = { title: "Choose a new password · ITR Intake", referrer: "no-referrer" };

export default function ResetPasswordPage() {
  return (
    <AuthCard
      eyebrow="CA dashboard"
      title="Choose a new password"
      intro="Choose a password of at least 12 characters. Saving it signs you out on every device."
      footer={
        <Link href="/ca/login" className={authLink}>
          ← Back to sign in
        </Link>
      }
    >
      <ResetPasswordForm />
    </AuthCard>
  );
}
