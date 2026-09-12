"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { LinkqtMark } from "./linkqt-mark";
import { starterDocument } from "../lib/starter-document";

type Log = { id: string; name?: string; message: string };

const CLAIM_NAMES = ["jake", "sarah", "mina", "leo", "priya", "noah", "aria", "kai"];
const PROMPT = "A dark link page with my YouTube, Instagram, and site";
const FRAME_W = 1600;
const FRAME_H = 920;

export function LandingStudio({ signedIn }: { signedIn: boolean }) {
  const [html, setHtml] = useState(emptyCanvas);
  const [visibleHtml, setVisibleHtml] = useState(emptyCanvas);
  const [fade, setFade] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [ready, setReady] = useState(false);
  const [live, setLive] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [runLabel, setRunLabel] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const started = useRef(false);
  const slotRef = useRef<HTMLDivElement>(null);
  const claimed = useCyclingName(CLAIM_NAMES);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    const fit = () => {
      setScale(Math.min(1, slot.clientWidth / FRAME_W));
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(slot);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  useEffect(() => {
    if (!fade) return;
    const id = window.setTimeout(() => {
      setVisibleHtml(html);
      setFade(false);
    }, 280);
    return () => window.clearTimeout(id);
  }, [fade, html]);

  function showPage(next: string) {
    setHtml(next);
    setFade(true);
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const timers: number[] = [];
    const later = (ms: number, fn: () => void) => {
      timers.push(window.setTimeout(fn, ms));
    };

    later(600, () => {
      setStreaming(true);
      setDrawer(true);
      setPrompt(PROMPT);
      setLogs([{ id: "1", message: "Patch agent started" }]);
    });
    later(1400, () => setLogs((current) => [...current, { id: "2", name: "read_document", message: "Empty canvas" }]));
    later(2200, () => setLogs((current) => [...current, { id: "3", message: "Generating page" }]));
    later(3000, () => {
      setLogs((current) => [...current, { id: "4", name: "replace_text", message: "Wrote the page layout" }]);
      showPage(starterPage(CLAIM_NAMES[0]));
    });
    later(4200, () => setLogs((current) => [...current, { id: "5", name: "verify_revision", message: "Satisfied" }]));
    later(5000, () => {
      setLogs((current) => [...current, { id: "6", message: "Saved run" }]);
      setRunLabel("My Links");
      setStreaming(false);
      setReady(true);
    });
    later(6800, () => {
      setStreaming(true);
      setLogs((current) => [...current, { id: "7", message: "Revision started" }]);
    });
    later(7600, () => {
      setLogs((current) => [...current, { id: "8", name: "replace_text", message: "Updated the heading" }]);
      showPage(starterPage(CLAIM_NAMES[0], CLAIM_NAMES[0]));
    });
    later(8600, () => {
      setLogs((current) => [...current, { id: "9", name: "verify_revision", message: "Satisfied" }]);
      setRunLabel(CLAIM_NAMES[0]);
      setStreaming(false);
    });
    later(9800, () => setLive(true));

    return () => timers.forEach((id) => window.clearTimeout(id));
  }, []);

  return (
    <div className="min-h-screen text-foreground">
      <header className="mx-auto flex w-full max-w-[88rem] items-center justify-between px-5 py-5">
        <Link href="/" className="flex items-center gap-2.5">
          <LinkqtMark className="h-8 w-8" />
          <span className="text-sm font-semibold tracking-tight">LinkQT</span>
        </Link>
        <nav className="flex items-center gap-2">
          {signedIn ? (
            <Link href="/admin" className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
              Open builder
            </Link>
          ) : (
            <>
              <Link href="/auth" className="rounded-full px-4 py-2 text-sm text-muted hover:text-foreground">
                Sign in
              </Link>
              <Link href="/auth/sign-up" className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
                Get your name
              </Link>
            </>
          )}
        </nav>
      </header>

      <section className="mx-auto grid w-full max-w-[88rem] items-center gap-10 px-5 pb-12 pt-6 sm:pt-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.15fr)] lg:gap-16">
        <div>
          <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl xl:text-7xl">
            Claim a name.
            <br />
            Publish a page.
          </h1>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {signedIn ? (
              <Link href="/admin" className="rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500">
                Continue in the builder
              </Link>
            ) : (
              <>
                <Link href="/auth/sign-up" className="rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500">
                  Get started
                </Link>
                <Link href="/auth" className="rounded-full border border-line px-5 py-2.5 text-sm font-medium hover:bg-surface-muted">
                  I already have a name
                </Link>
              </>
            )}
          </div>
        </div>
        <NameTicker {...claimed} />
      </section>

      <section className="mx-auto w-full max-w-[98rem] px-4 pb-16">
        <div
          ref={slotRef}
          className="relative w-full overflow-hidden rounded-[1.75rem] border border-line bg-surface/85 shadow-[0_30px_90px_rgba(0,0,0,0.28)]"
          style={{ height: FRAME_H * scale }}
        >
          <div
            className="pointer-events-none origin-top-left"
            style={{
              width: FRAME_W,
              height: FRAME_H,
              transform: `scale(${scale})`,
            }}
          >
            <BuilderFrame
              fade={fade}
              live={live}
              drawer={drawer}
              logs={logs}
              prompt={prompt}
              streaming={streaming}
              ready={ready}
              runLabel={runLabel}
              visibleHtml={visibleHtml}
              claimedName={claimed.current}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function BuilderFrame({
  fade,
  live,
  drawer,
  logs,
  prompt,
  streaming,
  ready,
  runLabel,
  visibleHtml,
  claimedName,
}: {
  fade: boolean;
  live: boolean;
  drawer: boolean;
  logs: Log[];
  prompt: string;
  streaming: boolean;
  ready: boolean;
  runLabel: string | null;
  visibleHtml: string;
  claimedName: string;
}) {
  return (
    <div className="flex h-full flex-col gap-4 p-4 text-foreground">
      <header className="flex items-center justify-between gap-3 rounded-[2rem] border border-line bg-surface/85 px-5 py-4 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">LinkQT Admin</p>
          <h2 className="text-2xl font-semibold tracking-tight">Build {claimedName}.linkqt.me</h2>
          <p className="mt-1 text-xs text-muted">{runLabel ?? "No saved run selected"}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-muted">
            Download
          </span>
          <span className={`rounded-full px-5 py-2 text-sm font-semibold ${live ? "bg-indigo-600 text-white" : "bg-indigo-200 text-white dark:bg-indigo-900/40"}`}>
            {live ? "Deployed" : "Deploy"}
          </span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[20rem_22rem_minmax(0,1fr)_auto] gap-4">
        <aside className="overflow-hidden rounded-[2rem] border border-line bg-surface/85 p-4 shadow-sm">
          <h3 className="font-semibold tracking-tight">Projects</h3>
          <p className="text-xs text-muted">Saved pages and run history.</p>
          <div className="mt-4 grid grid-cols-3 gap-1.5 rounded-2xl border border-line bg-surface/70 p-1.5">
            {[
              ["Clone", "copy"],
              ["Default", "starter"],
              ["Blank", "draft"],
            ].map(([label, detail]) => (
              <span key={label} className="rounded-xl bg-indigo-50 px-2 py-2 text-center dark:bg-indigo-950/40">
                <span className="block text-xs font-semibold text-indigo-800 dark:text-indigo-200">{label}</span>
                <span className="block text-[10px] uppercase tracking-[0.12em] text-indigo-700/70 dark:text-indigo-300/70">{detail}</span>
              </span>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            <div className="rounded-2xl border border-dashed border-line px-3 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Empty canvas</p>
              <p className="mt-1 text-xs text-muted">Ready. Upload HTML or write a prompt.</p>
            </div>
            {runLabel && (
              <div className="relative rounded-2xl border border-indigo-400 bg-indigo-50 px-3 py-3 pl-4 transition-all duration-500 dark:border-indigo-700 dark:bg-indigo-950/40">
                <span className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-indigo-600" />
                <p className="text-sm font-semibold">{runLabel}</p>
                <p className="text-[11px] text-muted">{live ? "Live" : "Completed"}</p>
              </div>
            )}
          </div>
        </aside>

        <div className="flex min-h-0 flex-col rounded-[2rem] border border-line bg-surface/85 p-4 shadow-sm">
          <div className="mb-4 flex rounded-full bg-black/5 p-1 dark:bg-white/10">
            <span className="flex-1 rounded-full bg-surface px-3 py-1.5 text-center text-sm font-semibold shadow-sm">AI builder</span>
            <span className="flex-1 px-3 py-1.5 text-center text-sm text-muted">Upload HTML</span>
          </div>
          <p className="mb-2 text-sm font-semibold">{streaming ? "New prompt" : "Saved prompt"}</p>
          <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-surface p-4 text-sm leading-6 text-foreground">
            {prompt || <span className="text-muted">Select a run, then click Edit on it to start a new prompt.</span>}
          </div>
          <span className="mt-3 block rounded-2xl bg-indigo-600 px-4 py-3 text-center text-sm font-semibold text-white">
            {streaming ? "Generating" : "Run"}
          </span>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col rounded-[2rem] border border-line bg-surface/85 p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="font-semibold tracking-tight">Workspace</h3>
              <p className="text-xs text-muted">{live ? "Selected saved run." : streaming ? "Generating." : ready ? "Selected saved run." : "Empty canvas."}</p>
            </div>
            <div className="flex rounded-full bg-black/5 p-1 dark:bg-white/10">
              <span className="rounded-full bg-surface px-3 py-1 text-xs font-semibold shadow-sm">Preview</span>
              <span className="px-3 py-1 text-xs text-muted">Source</span>
            </div>
          </div>
          <div className={`min-h-0 flex-1 overflow-hidden rounded-2xl border border-line transition-opacity duration-500 ease-out ${fade ? "opacity-0" : "opacity-100"}`}>
            <iframe
              title="LinkQT document preview"
              srcDoc={visibleHtml}
              sandbox="allow-scripts"
              className="h-full w-full bg-surface"
            />
          </div>
        </div>

        <div className={`overflow-hidden transition-[width] duration-500 ease-[cubic-bezier(.22,1,.36,1)] ${drawer ? "w-[20rem]" : "w-0"}`}>
          <aside className="h-full w-[20rem] rounded-[2rem] border border-line bg-surface/85 p-4 shadow-sm">
            <h3 className="font-semibold tracking-tight">Tool calls</h3>
            <p className="text-xs text-muted">
              {streaming ? "Showing live tool calls." : logs.length ? "Saved tool trace." : ""}
            </p>
            <div className="mt-3 grid gap-2">
              {logs.map((log) => (
                <article key={log.id} className="animate-[fadeUp_.45s_ease] rounded-xl border border-line bg-surface px-3 py-2 text-xs leading-5">
                  <p className="font-semibold">
                    {log.name ? <span className="font-mono">{log.name}</span> : "status"}
                    <span className="font-normal text-muted"> {log.message}</span>
                  </p>
                </article>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

const TICKER_SLIDE_MS = 420;

function useCyclingName(names: string[], intervalMs = 1900) {
  const [index, setIndex] = useState(0);
  const [sliding, setSliding] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let slideTimer = 0;
    const id = window.setInterval(() => {
      if (media.matches) {
        setIndex((current) => (current + 1) % names.length);
        return;
      }
      setSliding(true);
      window.clearTimeout(slideTimer);
      slideTimer = window.setTimeout(() => {
        setIndex((current) => (current + 1) % names.length);
        setSliding(false);
      }, TICKER_SLIDE_MS);
    }, intervalMs);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(slideTimer);
    };
  }, [intervalMs, names.length]);

  return {
    current: names[index],
    next: names[(index + 1) % names.length],
    sliding,
  };
}

const HOST_TYPE =
  "whitespace-nowrap text-5xl font-extrabold leading-[1.2] tracking-tight sm:text-6xl lg:text-7xl";

function HostLine({ name }: { name: string }) {
  return (
    <span className={`inline-flex items-baseline ${HOST_TYPE}`}>
      <span className="inline-block rounded-[0.18em] bg-indigo-500 px-[0.22em] text-white dark:bg-indigo-500">
        {name}
      </span>
      <span className="text-foreground">.linkqt.me</span>
    </span>
  );
}

function NameTicker({
  current,
  next,
  sliding,
}: ReturnType<typeof useCyclingName>) {
  const frameRef = useRef<HTMLDivElement>(null);
  const naturalRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 1, height: 0 });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const natural = naturalRef.current;
    if (!frame || !natural) return;

    const measure = () => {
      const available = frame.clientWidth;
      const needed = natural.scrollWidth;
      const scale = available > 0 && needed > 0 ? Math.min(1, available / needed) : 1;
      setFit({ scale, height: natural.offsetHeight * scale });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(natural);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      className="w-full min-w-0 lg:justify-self-end"
      style={{ height: fit.height || undefined }}
    >
      <div className="h-full overflow-hidden [filter:drop-shadow(0_0_22px_rgba(99,102,241,0.55))]">
        <div
          ref={naturalRef}
          className="w-max origin-top-left py-6"
          style={{ transform: `scale(${fit.scale})` }}
        >
          <p className="sr-only">{`${current}.linkqt.me`}</p>
          <div className="relative overflow-hidden">
            <div aria-hidden className="invisible grid">
              {CLAIM_NAMES.map((name) => (
                <span key={name} className="col-start-1 row-start-1">
                  <HostLine name={name} />
                </span>
              ))}
            </div>
            <div aria-hidden className="absolute inset-0 overflow-hidden">
              <div
                className="flex h-[200%] flex-col"
                style={{
                  transform: sliding ? "translateY(-50%)" : "translateY(0)",
                  transition: sliding ? `transform ${TICKER_SLIDE_MS}ms cubic-bezier(.22, 1, .36, 1)` : "none",
                }}
              >
                <div className="flex h-1/2 items-center">
                  <HostLine name={current} />
                </div>
                <div className="flex h-1/2 items-center">
                  <HostLine name={next} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function emptyCanvas() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Start a project</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 28px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; background: radial-gradient(circle at 20% 0%, rgba(99,102,241,.18), transparent 30rem), linear-gradient(160deg, #0b0b0f 0%, #16161d 60%, #0b0b0f 100%); color: #e5e7eb; }
  main { width: min(100%, 440px); border: 1px solid rgba(255,255,255,.1); border-radius: 24px; padding: 32px; background: rgba(24,24,27,.6); backdrop-filter: blur(12px); }
  .badge { width: 52px; height: 52px; margin: 0 auto 18px; display: grid; place-items: center; border-radius: 16px; background: linear-gradient(135deg, #4f46e5, #7c3aed); font-size: 26px; font-weight: 800; color: #fff; }
  h1 { margin: 0; text-align: center; font-size: 24px; letter-spacing: -.02em; }
  p.sub { margin: 8px auto 0; max-width: 32ch; text-align: center; color: #a1a1aa; font-size: 14px; line-height: 1.6; }
</style></head><body><main><div class="badge">+</div><h1>Start a project</h1><p class="sub">Nothing here yet. Your live preview shows up here.</p></main></body></html>`;
}

function starterPage(name: string, heading = "My Links") {
  return starterDocument({ name, title: heading });
}
