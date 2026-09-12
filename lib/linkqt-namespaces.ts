export const RESERVED_LINKQT_NAMESPACES = [
  // Platform / app / infrastructure
  "admin", "administrator", "api", "apis", "app", "apps", "web", "mobile", "www",
  "root", "host", "internal", "gateway", "proxy", "origin", "edge", "cdn",
  "static", "assets", "asset", "media", "files", "content", "public", "bundle",
  "builder", "studio", "editor", "console", "panel", "portal", "dashboard",
  "site", "sites",
  // Auth / identity (same-site sensitive — highest priority)
  "auth", "oauth", "sso", "login", "signin", "sign-in", "logout", "signout",
  "sign-out", "signup", "sign-up", "register", "account", "accounts", "user",
  "users", "profile", "session", "identity", "verify", "password", "reset",
  "onboarding", "clerk", "clkmail",
  // Email / DNS / network
  "mail", "email", "webmail", "smtp", "imap", "mailer", "noreply", "no-reply",
  "bounce", "postmaster", "hostmaster", "webmaster", "autodiscover", "autoconfig",
  "dkim", "dmarc", "dns", "ftp", "sftp", "ssh", "vpn",
  // Product / billing / future surfaces
  "settings", "config", "setup", "manage", "manager", "billing", "payment",
  "payments", "pay", "checkout", "invoice", "order", "orders", "cart", "store",
  "shop", "subscribe", "subscription", "pricing", "plan", "plans", "pro", "plus",
  "premium", "enterprise", "business", "team", "teams", "org", "orgs",
  "organization", "workspace", "workspaces", "project", "projects", "credits",
  "search", "home", "new", "get",
  // Marketing / content / legal
  "blog", "news", "press", "about", "contact", "careers", "jobs", "legal",
  "terms", "privacy", "policy", "cookies", "copyright", "dmca", "trust", "faq",
  "docs", "documentation", "guide", "guides", "learn", "help", "helpdesk",
  "support", "community", "forum", "feedback", "roadmap", "changelog", "releases",
  "brand", "partners", "affiliates", "info", "hello", "official",
  // Status / monitoring / dev / deploy
  "status", "health", "healthz", "uptime", "ping", "monitor", "monitoring",
  "metrics", "stats", "analytics", "logs", "sentry", "debug", "test", "testing",
  "dev", "develop", "development", "staging", "prod", "production", "demo",
  "sandbox", "beta", "alpha", "canary", "preview", "deploy", "registry", "git",
  "webhook", "webhooks",
  // Security / abuse
  "security", "abuse", "spam", "phishing", "malware", "fraud", "report", "secure",
  "ssl", "tls", "cert", "acme", "well-known", "soc", "noc",
  // Brand
  "linkqt", "linqt", "link", "links", "bio",
  // Misc / service
  "service", "services", "system", "staff", "me", "v1",
] as const;

const RESERVED_LINKQT_NAMESPACE_SET = new Set<string>(RESERVED_LINKQT_NAMESPACES);

export function isReservedLinkqtNamespace(value: string) {
  return RESERVED_LINKQT_NAMESPACE_SET.has(value.toLowerCase());
}

export function isValidLinkqtNamespace(value: string) {
  if (!value || value.includes(".") || isReservedLinkqtNamespace(value)) return false;
  return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value);
}
