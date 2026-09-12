const ADMIN_REDIRECT_PATH = "/admin";

type AuthRedirectSearchParams = {
  next?: string;
  redirectUrl?: string;
  redirect_url?: string;
  sign_in_force_redirect_url?: string;
  sign_up_force_redirect_url?: string;
  sign_in_fallback_redirect_url?: string;
  sign_up_fallback_redirect_url?: string;
};

export function authRedirectPath(params: AuthRedirectSearchParams) {
  return (
    safeRedirectPath(params.next) ??
    safeRedirectPath(params.sign_in_force_redirect_url) ??
    safeRedirectPath(params.sign_up_force_redirect_url) ??
    safeRedirectPath(params.sign_in_fallback_redirect_url) ??
    safeRedirectPath(params.sign_up_fallback_redirect_url) ??
    safeRedirectPath(params.redirectUrl) ??
    safeRedirectPath(params.redirect_url) ??
    ADMIN_REDIRECT_PATH
  );
}

export function authRouteWithNext(path: string, redirectPath: string) {
  return `${path}?next=${encodeURIComponent(redirectPath)}`;
}

function safeRedirectPath(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/" || trimmed.startsWith("//")) return null;
  if (trimmed.startsWith("/")) return trimmed;

  try {
    const url = new URL(trimmed);
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path === "/" ? null : path;
  } catch {
    return null;
  }
}
