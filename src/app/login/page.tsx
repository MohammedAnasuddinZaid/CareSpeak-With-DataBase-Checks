import type { Metadata } from "next";
import AuthPanel from "@/components/AuthPanel";
import LoginStage from "@/components/LoginStage";

export const metadata: Metadata = {
  title: "Sign in — CareSpeak",
  description: "Sign in to your CareSpeak bedside console or ward dashboard.",
  robots: { index: false, follow: false },
};

/**
 * `?next=` is read here, on the server, and handed to the panel as a prop.
 * Letting the panel call `useSearchParams` instead would wrap this route in a
 * Suspense boundary, and because the shell is a client component the boundary
 * takes the entire page with it: the server would ship an empty background
 * block and the sign-in surface would appear only after hydration. Reading one
 * query parameter costs a dynamic render; rendering an empty page costs the
 * patient their first impression of the product.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; authError?: string | string[] }>;
}) {
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  return (
    <LoginStage>
      <AuthPanel nextPath={one(raw.next) ?? null} authError={one(raw.authError) ?? null} />
    </LoginStage>
  );
}
