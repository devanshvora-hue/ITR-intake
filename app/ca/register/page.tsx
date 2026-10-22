import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard, authLink } from "@/components/ca/AuthCard";
import { RegisterForm } from "@/components/ca/RegisterForm";

export const metadata: Metadata = { title: "Register a CA account · ITR Intake" };

export default function CaRegisterPage() {
  return (
    <AuthCard
      wide
      eyebrow="CA onboarding"
      title="Register your firm"
      intro={
        <>
          Your firm and account are ready as soon as you register, and you are signed in straight
          away. Please use synthetic details in this prototype.
        </>
      }
      footer={
        <p>
          Already registered?{" "}
          <Link href="/ca/login" className={authLink}>
            Sign in
          </Link>
        </p>
      }
    >
      <RegisterForm />
    </AuthCard>
  );
}
