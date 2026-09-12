import { SignUp } from "@clerk/nextjs";
import { clerkAppearance } from "../../../../lib/clerk-appearance";
import { AuthFrame } from "../../auth-frame";
import { authRedirectPath, authRouteWithNext } from "../../auth-redirects";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const redirectUrl = authRedirectPath(params);
  const signInUrl = authRouteWithNext("/auth", redirectUrl);

  return (
    <AuthFrame title="Create an account" detail="One Google sign-in. Then you reserve a permanent name.">
      <SignUp
        routing="path"
        path="/auth/sign-up"
        signInUrl={signInUrl}
        forceRedirectUrl={redirectUrl}
        fallbackRedirectUrl="/admin"
        appearance={clerkAppearance}
      />
    </AuthFrame>
  );
}
