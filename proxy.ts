import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { isReservedLinkqtNamespace, isValidLinkqtNamespace } from "./lib/linkqt-namespaces";

const ROOT_DOMAINS = new Set(["localhost", "127.0.0.1", "linkqt.me", "www.linkqt.me"]);
const PLATFORM_SUBDOMAINS = new Set(["admin", "www"]);
const isAdminRoute = createRouteMatcher(["/admin(.*)"]);

const linkqtProxy = clerkMiddleware(async (auth, request) => {
  const pathname = request.nextUrl.pathname;
  if (isFrameworkPath(pathname)) return NextResponse.next();

  const host = normalizedHost(request);
  if (host === "admin.linkqt.me") {
    const path = pathname === "/" ? "/admin" : pathname.startsWith("/admin") ? pathname : `/admin${pathname}`;
    return NextResponse.redirect(new URL(`https://www.linkqt.me${path}${request.nextUrl.search}`), 302);
  }
  const hostNamespace = namespaceFromHost(host);
  if (hostNamespace) {
    if (pathname !== "/") return rewriteNotFound(request);
    return rewriteToSite(request, hostNamespace);
  }

  const pathNamespace = namespaceFromRootPath(host, pathname);
  if (pathNamespace) return rewriteToSite(request, pathNamespace);
  if (isNestedNamespacePath(host, pathname)) return rewriteNotFound(request);

  if (isAdminRoute(request)) {
    const { isAuthenticated } = await auth();
    if (!isAuthenticated) {
      const url = request.nextUrl.clone();
      url.pathname = "/auth";
      url.search = `?next=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
});

export default linkqtProxy;

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function normalizedHost(request: NextRequest) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host") || "";
  return host.toLowerCase().replace(/:\d+$/, "");
}

function namespaceFromHost(host: string) {
  if (!host || ROOT_DOMAINS.has(host)) return "";
  if (host.endsWith(".localhost")) return platformSafeNamespace(host.slice(0, -".localhost".length));
  if (!host.endsWith(".linkqt.me")) return "";
  return platformSafeNamespace(host.slice(0, -".linkqt.me".length));
}

function namespaceFromRootPath(host: string, pathname: string) {
  if (!ROOT_DOMAINS.has(host)) return "";
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 1) return "";
  return platformSafeNamespace(parts[0]);
}

function isNestedNamespacePath(host: string, pathname: string) {
  if (!ROOT_DOMAINS.has(host)) return false;
  const parts = pathname.split("/").filter(Boolean);
  return parts.length > 1 && Boolean(platformSafeNamespace(parts[0]));
}

function platformSafeNamespace(value: string) {
  const namespace = value.toLowerCase();
  if (PLATFORM_SUBDOMAINS.has(namespace) || isReservedLinkqtNamespace(namespace)) return "";
  return isValidLinkqtNamespace(namespace) ? namespace : "";
}

function rewriteToSite(request: NextRequest, namespace: string) {
  const url = request.nextUrl.clone();
  url.pathname = `/site/${namespace}`;
  url.search = "";
  return NextResponse.rewrite(url);
}

function isFrameworkPath(pathname: string) {
  return pathname.startsWith("/_next/") || pathname === "/favicon.ico";
}

function rewriteNotFound(request: NextRequest) {
  const host = normalizedHost(request);
  return new NextResponse(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title></head><body><main style="min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#171717;background:#f5f5f7"><section style="text-align:center"><h1 style="font-size:4rem;margin:0">404</h1><p>No LinkQT page exists at this path on ${host}.</p></section></main></body></html>`, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
