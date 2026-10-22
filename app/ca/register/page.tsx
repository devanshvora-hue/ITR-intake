import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/ca/AuthCard";
import { RegisterForm } from "@/components/ca/RegisterForm";

export const metadata: Metadata = { title: "Register a CA account · ITR Intake" };

export default function CaRegisterPage() {
  return (
    <AuthCard
      eyebrow="CA onboarding"
      title="Register your firm"
      intro={
        <>
          Accounts go through three steps: you register, you verify your email address, and an
          administrator reviews and approves the firm. You can sign in only after approval.
          Please use synthetic details in this prototype.
        </>
      }
      footer={
        <>
          Already approved?{" "}
          <Link href="/ca/login" className="font-medium text-teal underline">
            Sign in
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthCard>
  );
}
