import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type BuilderLink = { label: string; url: string };
type BuilderProject = { id: string; title: string };
type BuilderRun = { id: string; status: "pending" | "completed" | "failed"; document: string; links?: BuilderLink[]; parent_run_id?: string | null };
type StreamEvent = { event: string; data: unknown };
type ToolEvent = {
  id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  tool_name: string | null;
  status: string;
  message: string;
  args_json: string;
  result_json: string;
  document_hash: string | null;
};
type Scenario = {
  slug: string;
  title: string;
  links: BuilderLink[];
  baseDocument: string;
  steps: Array<{ slug: string; prompt: string; mustInclude?: string[]; mustIncludeAny?: string[][]; mustAvoidTools?: string[] }>;
};

const artifactDir = resolve(".cache/linkqt-ai-e2e/latest");
const providedBaseUrl = process.env.LINKQT_API_URL?.replace(/\/$/, "");
const port = Number(process.env.LINKQT_E2E_PORT ?? 4062);
const baseUrl = providedBaseUrl ?? `http://localhost:${port}`;
const shouldCleanup = providedBaseUrl ? process.env.LINKQT_E2E_DELETE_PROJECT === "true" : false;
const idToken = process.env.LINKQT_AUTH_TOKEN ?? (providedBaseUrl ? "" : "linkqt-dev-demo-token");
if (!idToken) {
  console.error("LINKQT_AUTH_TOKEN is required when LINKQT_API_URL points at an existing API.");
  process.exit(1);
}

const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${idToken}`,
};

const scenario: Scenario = {
  slug: "space-linktree",
  title: "Focused Space Linktree E2E",
  links: [
    { label: "YouTube", url: "https://www.youtube.com/@yourhandle" },
    { label: "Instagram", url: "https://www.instagram.com/yourhandle/" },
    { label: "Personal Website", url: "https://example.com/" },
  ],
  baseDocument: socialLinktreeDocument(),
  steps: [
    {
      slug: "layered-space-background",
      prompt: "Add a layered animated space background with visible twinkling stars behind the Linktree card. Keep the existing links and card content, but make the background clearly feel like deep space.",
      mustIncludeAny: [["star", "starry", "sparkle", "twinkle", "radial-gradient", "box-shadow", "animation"]],
    },
  ],
};

let serverProcess: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
const createdProjects: BuilderProject[] = [];

try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });

  if (!providedBaseUrl) {
    const spawned = Bun.spawn(["bun", "run", "scripts/serve-linkqt-api.ts"], {
      env: {
        ...process.env,
        LINKQT_API_PORT: String(port),
        LINKQT_AI_MODEL: process.env.LINKQT_AI_MODEL ?? "muse-spark-1.3-contributor",
        LINKQT_AI_TIMEOUT_MS: process.env.LINKQT_AI_TIMEOUT_MS ?? "120000",
        LINKQT_TEST_AUTH: process.env.LINKQT_AUTH_TOKEN ? process.env.LINKQT_TEST_AUTH ?? "" : "true",
        LINKQT_AI_DAILY_LIMIT: process.env.LINKQT_AI_DAILY_LIMIT ?? "1000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    serverProcess = spawned;
    void logPipe(spawned.stdout, "api");
    void logPipe(spawned.stderr, "api:error");
    await waitForHealth();
  }

  const scenarioDir = resolve(artifactDir, scenario.slug);
  await mkdir(scenarioDir, { recursive: true });
  await writeFile(resolve(scenarioDir, "base.html"), scenario.baseDocument);

  const created = await fetchJson<{ project: BuilderProject; run: BuilderRun }>(`${baseUrl}/builder/manual-project`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ title: scenario.title, document: scenario.baseDocument, links: scenario.links }),
  });
  createdProjects.push(created.project);

  const step = scenario.steps[0];
  const stepDir = resolve(scenarioDir, `1-${step.slug}`);
  await mkdir(stepDir, { recursive: true });
  await writeFile(resolve(stepDir, "before.html"), scenario.baseDocument);

  const streamEvents = await streamRevision(created.run.id, step.prompt, scenario.links);
  const resultPayload = lastPayload<{ project: BuilderProject; run: BuilderRun }>(streamEvents, "result");
  if (!resultPayload?.run) throw new Error(`${scenario.slug}/${step.slug}: stream did not return a saved run result.`);
  const finalRun = resultPayload.run;
  const persisted = await fetchJson<{ events: ToolEvent[] }>(`${baseUrl}/builder/runs/${encodeURIComponent(finalRun.id)}/tool-events`, { headers: authHeaders });
  const streamToolEvents = streamEvents.filter((event) => event.event === "tool");

  await writeFile(resolve(stepDir, "result.html"), finalRun.document);
  await writeFile(resolve(stepDir, "stream-events.json"), JSON.stringify(streamEvents, null, 2));
  await writeFile(resolve(stepDir, "tool-events.json"), JSON.stringify(persisted.events, null, 2));
  await writeFile(resolve(stepDir, "diff.txt"), simpleLineDiff(scenario.baseDocument, finalRun.document));
  await writeFile(resolve(stepDir, "summary.json"), JSON.stringify({
    scenario: scenario.slug,
    step: step.slug,
    prompt: step.prompt,
    sourceRunId: created.run.id,
    finalRunId: finalRun.id,
    streamToolEvents: streamToolEvents.length,
    persistedToolEvents: persisted.events.length,
    persistedToolErrors: persisted.events.filter((event) => event.status === "error").length,
    editTools: persisted.events.filter((event) => event.status === "success" && event.tool_name && event.tool_name !== "finish_revision" && event.tool_name !== "verify_revision").map((event) => event.tool_name),
    verifierEvents: persisted.events.filter((event) => event.tool_name === "verify_revision").map((event) => ({ status: event.status, message: event.message, result: event.result_json })),
  }, null, 2));

  assertRevision({
    scenario,
    step,
    previousRun: created.run,
    previousDocument: scenario.baseDocument,
    finalRun,
    streamToolEvents,
    persistedEvents: persisted.events,
  });

  const summary = [{ slug: scenario.slug, title: scenario.title, projectId: created.project.id, steps: [{ slug: step.slug, prompt: step.prompt, runId: finalRun.id, streamToolEvents: streamToolEvents.length, persistedToolEvents: persisted.events.length, persistedToolErrors: persisted.events.filter((event) => event.status === "error").length, result: `${scenario.slug}/1-${step.slug}/result.html` }] }];
  await writeFile(resolve(artifactDir, "run-summary.json"), JSON.stringify({ baseUrl, scenarios: summary }, null, 2));
  await writeFile(resolve(artifactDir, "index.html"), reviewIndex(summary));
  console.log("ai_patch_e2e_ok", {
    revisions: 1,
    review: resolve(artifactDir, "index.html"),
  });
} finally {
  if (shouldCleanup) {
    for (const project of createdProjects) {
      await fetch(`${baseUrl}/builder/delete-project`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ projectId: project.id }),
      }).catch(() => undefined);
    }
  }
  serverProcess?.kill();
}

function assertRevision(input: { scenario: Scenario; step: Scenario["steps"][number]; previousRun: BuilderRun; previousDocument: string; finalRun: BuilderRun; streamToolEvents: StreamEvent[]; persistedEvents: ToolEvent[] }) {
  const label = `${input.scenario.slug}/${input.step.slug}`;
  assert(input.finalRun.status === "completed", `${label}: expected completed final run, got ${input.finalRun.status}`);
  assert(input.finalRun.parent_run_id === input.previousRun.id, `${label}: final run parent does not point at previous run.`);
  assert(isCompleteHtml(input.finalRun.document), `${label}: final document is not complete HTML.`);
  assert(input.finalRun.document !== input.previousDocument, `${label}: final document did not change.`);
  for (const text of input.step.mustInclude ?? []) {
    assert(input.finalRun.document.toLowerCase().includes(text.toLowerCase()), `${label}: final document missing expected text "${text}".`);
  }
  for (const group of input.step.mustIncludeAny ?? []) {
    assert(group.some((text) => input.finalRun.document.toLowerCase().includes(text.toLowerCase())), `${label}: final document missing any expected text from [${group.join(", ")}].`);
  }
  assertAllowedExternalUrls(input.finalRun.document, input.scenario.links.map((link) => link.url));
  assert(input.streamToolEvents.length > 0, `${label}: no tool activity arrived over SSE.`);
  assert(input.streamToolEvents.some((event) => toolName(event) && toolName(event) !== "finish_revision"), `${label}: SSE did not include an editing tool call.`);
  assert(input.persistedEvents.some((event) => event.event_type === "agent_started"), `${label}: persisted trace has no agent_started event.`);
  assert(input.persistedEvents.some((event) => event.event_type === "tool_start"), `${label}: persisted trace has no tool_start event.`);
  assert(input.persistedEvents.some((event) => event.event_type === "tool_result"), `${label}: persisted trace has no tool_result event.`);
  assert(input.persistedEvents.some((event) => event.event_type === "validation_started"), `${label}: persisted trace has no validation_started event.`);
  assert(input.persistedEvents.some((event) => event.event_type === "run_completed"), `${label}: persisted trace has no run_completed event.`);
  assert(input.persistedEvents.some((event) => event.status === "success" && event.tool_name && event.tool_name !== "finish_revision" && event.tool_name !== "verify_revision"), `${label}: persisted trace has no successful edit tool.`);
  assert(input.persistedEvents.some((event) => event.tool_name === "verify_revision" && event.status === "success"), `${label}: persisted trace has no successful verify_revision event.`);
  assert(input.streamToolEvents.some((event) => toolName(event) === "verify_revision"), `${label}: SSE did not include verify_revision tool activity.`);
  assert(!input.persistedEvents.some((event) => event.event_type === "run_failed"), `${label}: persisted trace contains run_failed.`);
  for (const tool of input.step.mustAvoidTools ?? ["replace_document"]) {
    assert(!input.persistedEvents.some((event) => event.tool_name === tool), `${label}: used disallowed tool ${tool}.`);
  }
}

async function streamRevision(runId: string, prompt: string, links: BuilderLink[]) {
  const response = await fetch(`${baseUrl}/builder/revise/stream`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runId, links, prompt }),
  });
  if (!response.ok) throw new Error(`revise stream failed ${response.status}: ${await response.text()}`);
  if (!response.body) throw new Error("revise stream returned no body");

  const events: StreamEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseFrame(frame);
      if (event) events.push(event);
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) {
    const event = parseSseFrame(buffer);
    if (event) events.push(event);
  }
  if (events.some((event) => event.event === "error")) throw new Error(`stream error: ${JSON.stringify(events.find((event) => event.event === "error")?.data)}`);
  return events;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${input} failed with ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function parseSseFrame(frame: string): StreamEvent | null {
  const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
  const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data.trim()) return null;
  return { event, data: safeJson(data) ?? data };
}

function lastPayload<T>(events: StreamEvent[], eventName: string): T | null {
  const event = [...events].reverse().find((candidate) => candidate.event === eventName);
  return event?.data as T ?? null;
}

function toolName(event: StreamEvent) {
  return typeof event.data === "object" && event.data && "name" in event.data ? String((event.data as { name?: unknown }).name ?? "") : "";
}

async function waitForHealth() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`API did not become healthy at ${baseUrl}`);
}

async function logPipe(pipe: ReadableStream<Uint8Array>, label: string) {
  const decoder = new TextDecoder();
  for await (const chunk of pipe) {
    const text = decoder.decode(chunk).trim();
    if (text) console.log(`[${label}] ${text}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isCompleteHtml(value: string) {
  return /^(?:<!doctype html>\s*)?<html\b[\s\S]*<\/html>\s*$/i.test(value.trim());
}

function assertAllowedExternalUrls(document: string, allowedUrls: string[]) {
  const allowed = new Set(allowedUrls.map(comparableUrl));
  // Outbound navigation (<a>, form action, external <script src>) must be an approved link.
  const navUrls = navigationalDocumentUrls(document);
  const navKeys = new Set(navUrls.map(comparableUrl));
  const unapproved = navUrls.filter((url) => !allowed.has(comparableUrl(url)));
  if (unapproved.length > 0) throw new Error(`Unexpected outbound link URLs: ${[...new Set(unapproved)].join(", ")}`);
  // Resource loads (images, fonts, stylesheets, media) may point anywhere but must be https.
  const insecure = allExternalUrls(document)
    .filter((url) => !navKeys.has(comparableUrl(url)))
    .filter((url) => !/^https:/i.test(url));
  if (insecure.length > 0) throw new Error(`Insecure external resource URLs (must be https): ${[...new Set(insecure)].join(", ")}`);
}

function navigationalDocumentUrls(document: string) {
  const urls = new Set<string>();
  const patterns = [
    /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    /<form\b[^>]*?\saction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  ];
  for (const pattern of patterns) {
    for (const match of document.matchAll(pattern)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!value || value.startsWith("#") || value.startsWith("/") || value.startsWith("mailto:") || value.startsWith("tel:")) continue;
      if (/^https?:\/\//i.test(value)) urls.add(value);
    }
  }
  return [...urls];
}

function allExternalUrls(document: string) {
  const urls = new Set<string>();
  for (const match of document.matchAll(/https?:\/\/[^\s"'<>)]*/gi)) urls.add(match[0].replace(/[.,;]+$/g, ""));
  return [...urls];
}

function comparableUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function simpleLineDiff(before: string, after: string) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  const out = [];
  for (let index = 0; index < max; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (beforeLines[index] !== undefined) out.push(`-${index + 1}: ${beforeLines[index]}`);
    if (afterLines[index] !== undefined) out.push(`+${index + 1}: ${afterLines[index]}`);
  }
  return out.join("\n");
}

function reviewIndex(summary: Array<{ slug: string; title: string; steps: Array<{ slug: string; prompt: string; result: string }> }>) {
  const sections = summary.map((scenario) => `
    <section>
      <h2>${escapeHtml(scenario.title)}</h2>
      <div class="grid">
        ${scenario.steps.map((step, index) => `
          <article>
            <h3>${index + 1}. ${escapeHtml(step.slug)}</h3>
            <p>${escapeHtml(step.prompt)}</p>
            <iframe src="${escapeHtml(step.result)}"></iframe>
          </article>
        `).join("")}
      </div>
    </section>
  `).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>LinkQT AI Patch Review</title><style>body{margin:0;padding:24px;font-family:Inter,system-ui,sans-serif;background:#f4f4f5;color:#18181b}section{margin-bottom:32px}h1,h2,h3{margin:.2em 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}article{border:1px solid #ddd;border-radius:12px;background:white;padding:12px}iframe{width:100%;height:520px;border:1px solid #ddd;border-radius:8px;background:white}p{color:#52525b;font-size:13px}</style></head><body><h1>LinkQT AI Patch Review</h1>${sections}</body></html>`;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function safeJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function socialLinktreeDocument() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My Links</title><style>:root{color-scheme:dark;--ink:#f8fafc;--muted:rgba(248,250,252,.68);--line:rgba(255,255,255,.16);--panel:rgba(15,23,42,.62)}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 18% 12%,rgba(236,72,153,.34),transparent 32%),radial-gradient(circle at 82% 20%,rgba(14,165,233,.30),transparent 34%),linear-gradient(145deg,#09090b 0%,#111827 48%,#18181b 100%);color:var(--ink)}main{width:min(100%,440px);border:1px solid var(--line);border-radius:32px;padding:28px;background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.06));box-shadow:0 30px 90px rgba(0,0,0,.38);backdrop-filter:blur(24px)}.avatar{width:92px;height:92px;margin:0 auto 18px;display:grid;place-items:center;border-radius:28px;border:1px solid var(--line);background:linear-gradient(135deg,#f97316,#ec4899 48%,#38bdf8);font-size:38px;font-weight:900}h1{margin:0;text-align:center;font-size:64px;line-height:.92}p{margin:14px auto 24px;max-width:30ch;text-align:center;color:var(--muted);font-size:15px;line-height:1.65}nav{display:grid;gap:12px}a{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:58px;border:1px solid var(--line);border-radius:18px;padding:0 18px;background:var(--panel);color:white;text-decoration:none;font-weight:760}a span{color:var(--muted);font-size:13px}footer{margin-top:22px;text-align:center;color:rgba(248,250,252,.44);font-size:12px}</style></head><body><main><div class="avatar">+</div><h1>My Links</h1><p>Everything I make, all in one place.</p><nav aria-label="My links"><a href="https://www.youtube.com/@yourhandle">YouTube <span>@yourhandle</span></a><a href="https://www.instagram.com/yourhandle/">Instagram <span>@yourhandle</span></a><a href="https://example.com/">Personal Website <span>example.com</span></a></nav><footer>My Links</footer></main></body></html>`;
}
