import type { Metadata } from "next";
import { AuthCard } from "@/components/ca/AuthCard";
import { ResetPasswordForm } from "@/components/ca/ResetPasswordForm";

export const metadata: Metadata = { title: "Choose a new password · ITR Intake", referrer: "no-referrer" };

export default function ResetPasswordPage() {
  return (
    <AuthCard eyebrow="CA dashboard" title="Choose a new password">
      <ResetPasswordForm />
    </AuthCard>
  );
}
