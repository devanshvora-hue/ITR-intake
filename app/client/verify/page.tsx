import type { Metadata } from "next";
import { AuthCard } from "@/components/ca/AuthCard";
import { ClientVerify } from "@/components/client/ClientVerify";

export const metadata: Metadata = { title: "Continue · ITR Intake", referrer: "no-referrer" };

export default function ClientVerifyPage() {
  return (
    <AuthCard eyebrow="Client portal" title="Confirming your email">
      <ClientVerify />
    </AuthCard>
  );
}
