"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { useTheme } from "next-themes";
import {
  getProfile,
  getStats,
  type BuilderStats,
  type UserProfile,
} from "../../../lib/builder-client";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2";
const cardClass =
  "rounded-3xl border border-line bg-surface p-6 shadow-sm backdrop-blur-xl";

export default function SettingsPage() {
  const { isLoaded, isSignedIn, user: clerkUser } = useUser();
  const { getToken } = useAuth();
  const { signOut, openUserProfile } = useClerk();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<BuilderStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resetIn, setResetIn] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getToken();
        if (!token)
          throw new Error("Clerk session is unavailable. Please sign in again.");
        const [nextProfile, nextStats] = await Promise.all([
          getProfile(token),
          getStats(token),
        ]);
        if (cancelled) return;
        setProfile(nextProfile);
        setStats(nextStats);
      } catch (cause) {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "Could not load settings.",
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, getToken]);

  useEffect(() => {
    const update = () => setResetIn(formatResetCountdown());
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, []);

  if (!isLoaded)
    return <CenteredNote title="Loading settings" detail="Checking your session." />;

  if (!isSignedIn || !clerkUser)
    return (
      <CenteredNote title="Settings" detail="Sign in to view your settings.">
        <a
          href="/auth?next=/admin/settings"
          className={`inline-flex rounded-full bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 ${focusRing}`}
        >
          Sign in
        </a>
      </CenteredNote>
    );

  const subdomain = profile?.subdomain ?? null;
  const liveUrl = subdomain ? `https://${subdomain}.linkqt.me` : null;
  const joined = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "—";
  const email =
    profile?.email ?? clerkUser.primaryEmailAddress?.emailAddress ?? "—";
  const name =
    clerkUser.fullName ??
    clerkUser.primaryEmailAddress?.emailAddress ??
    "Your account";
  const aiPct =
    stats && stats.ai_daily_limit
      ? Math.min(100, Math.round((stats.ai_used_today / stats.ai_daily_limit) * 100))
      : 0;
  const aiBarColor =
    aiPct >= 100
      ? "bg-red-500"
      : aiPct >= 80
        ? "bg-amber-500"
        : "bg-indigo-600 dark:bg-indigo-400";

  return (
    <main className="min-h-screen px-4 py-6 text-foreground sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              LinkQT
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          </div>
          <Link
            href="/admin"
            className={`rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium transition hover:bg-surface-muted ${focusRing}`}
          >
            ← Builder
          </Link>
        </header>

        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Profile */}
        <section className={cardClass}>
          <div className="flex items-center gap-4">
            {clerkUser.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={clerkUser.imageUrl}
                alt=""
                className="size-16 rounded-full border border-line object-cover"
              />
            ) : (
              <div className="grid size-16 place-items-center rounded-full bg-indigo-600 text-2xl font-bold text-white">
                {(name[0] ?? "?").toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{name}</h2>
              <p className="truncate text-sm text-muted">{email}</p>
            </div>
          </div>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
                Joined
              </dt>
              <dd className="mt-1 text-sm font-medium">{joined}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
                Your page
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {liveUrl ? (
                  <a
                    href={liveUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
                  >
                    {subdomain}.linkqt.me ↗
                  </a>
                ) : (
                  <span className="text-muted">Not reserved yet</span>
                )}
              </dd>
            </div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openUserProfile()}
              className={`rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 ${focusRing}`}
            >
              Manage account
            </button>
            <button
              type="button"
              onClick={() => signOut({ redirectUrl: "/auth" })}
              className={`rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium transition hover:bg-surface-muted ${focusRing}`}
            >
              Sign out
            </button>
          </div>
        </section>

        {/* Usage */}
        <section className={cardClass}>
          <h2 className="text-sm font-semibold">Usage</h2>
          <p className="text-xs leading-5 text-muted">Your activity on LinkQT.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <StatCard
              label="Projects"
              value={loading ? "…" : String(stats?.total_projects ?? 0)}
            />
            <StatCard
              label="Runs"
              value={loading ? "…" : String(stats?.total_runs ?? 0)}
              hint={
                stats ? `${stats.ai_runs} AI · ${stats.manual_runs} manual` : undefined
              }
            />
            <StatCard
              label="Deployed pages"
              value={loading ? "…" : String(stats?.deployed_pages ?? 0)}
            />
            <div className="rounded-2xl border border-line bg-surface-muted p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                AI today
              </p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">
                {loading
                  ? "…"
                  : `${stats?.ai_used_today ?? 0} / ${stats?.ai_daily_limit ?? 0}`}
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                <div
                  className={`h-full rounded-full transition-all ${aiBarColor}`}
                  style={{ width: `${aiPct}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] text-muted">
                {resetIn ? `Resets in ${resetIn} · midnight UTC` : " "}
              </p>
            </div>
          </div>
        </section>

        {/* Appearance */}
        <section className={cardClass}>
          <h2 className="text-sm font-semibold">Appearance</h2>
          <p className="text-xs leading-5 text-muted">
            Choose how the LinkQT admin looks on this device.
          </p>
          <ThemeSwitcher />
        </section>
      </div>
    </main>
  );
}

function formatResetCountdown(): string {
  const now = new Date();
  const nextUtcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  const minutes = Math.max(
    0,
    Math.floor((nextUtcMidnight - now.getTime()) / 60000),
  );
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface-muted p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const options = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  return (
    <div className="mt-4 inline-flex rounded-full border border-line bg-surface-muted p-1">
      {options.map((opt) => {
        const active = mounted && theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setTheme(opt.value)}
            aria-pressed={active}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${active ? "bg-indigo-600 text-white dark:bg-indigo-500" : "text-muted hover:text-foreground"} ${focusRing}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function CenteredNote({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="grid min-h-screen place-items-center px-4 text-foreground">
      <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-8 text-center shadow-sm backdrop-blur-xl">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted">{detail}</p>
        {children && <div className="mt-5">{children}</div>}
      </div>
    </main>
  );
}
