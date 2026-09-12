import { SignIn } from "@clerk/nextjs";
import { clerkAppearance } from "../../../lib/clerk-appearance";
import { AuthFrame } from "../auth-frame";
import { authRedirectPath, authRouteWithNext } from "../auth-redirects";

export default async function AuthPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const redirectUrl = authRedirectPath(params);
  const signUpUrl = authRouteWithNext("/auth/sign-up", redirectUrl);

  return (
    <AuthFrame title="Sign in" detail="Continue to claim or manage your LinkQT name.">
      <SignIn
        routing="path"
        path="/auth"
        signUpUrl={signUpUrl}
        forceRedirectUrl={redirectUrl}
        fallbackRedirectUrl="/admin"
        appearance={clerkAppearance}
      />
    </AuthFrame>
  );
}
