import type { Metadata } from "next";
import RegisterForm from "@/components/RegisterForm";
import LoginStage from "@/components/LoginStage";

export const metadata: Metadata = {
  title: "Create a patient account — CareSpeak",
  description: "Register a CareSpeak patient account. Staff accounts are issued by your hospital.",
  robots: { index: false, follow: false },
};

/**
 * Same shell as `/login`, so the two pages are one surface with two forms rather
 * than two designs. `LoginStage` is a client component only because of the
 * pinwheel's open state; the form inside it is the client part that matters.
 */
export default function RegisterPage() {
  return (
    <LoginStage>
      <RegisterForm />
    </LoginStage>
  );
}
