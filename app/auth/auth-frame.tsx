import Link from "next/link";
import type { ReactNode } from "react";
import { LinkqtMark } from "../linkqt-mark";

export function AuthFrame({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen px-4 py-6 text-foreground sm:px-6 sm:py-8">
      <div className="mx-auto flex w-full max-w-md flex-col gap-8">
        <header className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <LinkqtMark className="h-8 w-8" />
            <span className="text-sm font-semibold tracking-tight">LinkQT</span>
          </Link>
          <Link href="/" className="text-sm text-muted hover:text-foreground">
            Back
          </Link>
        </header>
        <section className="rounded-[2rem] border border-line bg-surface/90 p-6 shadow-sm backdrop-blur-xl sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            LinkQT
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 mb-6 text-sm leading-6 text-muted">{detail}</p>
          {children}
        </section>
      </div>
    </main>
  );
}
