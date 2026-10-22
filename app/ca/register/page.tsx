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
          Your firm and account are ready as soon as you register, and you are signed in straight
          away. Please use synthetic details in this prototype.
        </>
      }
      footer={
        <>
          Already registered?{" "}
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
