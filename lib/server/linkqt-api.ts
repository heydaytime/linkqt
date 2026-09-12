import { createClerkClient, verifyToken } from "@clerk/backend";
import { isReservedLinkqtNamespace } from "../linkqt-namespaces";
import { currentDeploymentDocument, ensureSchema, failStalePendingRuns, queryAll, queryOne, queryRun } from "./db";

const UPSTREAM_URL = (process.env.LINKQT_UPSTREAM_URL ?? "https://api.meta.ai/v1").replace(/\/$/, "");
const AI_CHAT_COMPLETIONS_PATH = normalizeUpstreamPath(process.env.LINKQT_AI_CHAT_COMPLETIONS_PATH ?? "/chat/completions");
const AI_MODELS_PATH = normalizeUpstreamPath(process.env.LINKQT_AI_MODELS_PATH ?? "/models");
const AI_API_KEY = (process.env.MODEL_API_KEY ?? process.env.LINKQT_AI_API_KEY ?? "").trim();
const ENABLE_AI_PROXY = process.env.LINKQT_ENABLE_AI_PROXY === "true";
const ENABLE_TEST_AUTH = process.env.LINKQT_TEST_AUTH === "true" && process.env.VERCEL_ENV !== "production";
const TEST_AUTH_TOKEN = "linkqt-dev-demo-token";
const TEST_USER: JwtPayload = {
  sub: "test-linkqt-user",
  user_id: "test-linkqt-user",
  email: "test@linkqt.local",
};
const AI_MODEL = process.env.LINKQT_AI_MODEL ?? "muse-spark-1.3-contributor";
const AI_REASONING_EFFORT = process.env.LINKQT_AI_REASONING_EFFORT ?? "low";
const AI_DAILY_LIMIT = Number(process.env.LINKQT_AI_DAILY_LIMIT ?? 25);
const AI_TIMEOUT_MS = Number(process.env.LINKQT_AI_TIMEOUT_MS ?? 120_000);
const AI_RETRY_COUNT = envNumber("LINKQT_AI_RETRY_COUNT", 1, 0);
const AI_MAX_ATTEMPTS = AI_RETRY_COUNT + 1;
const AI_RETRY_BASE_MS = envNumber("LINKQT_AI_RETRY_BASE_MS", 750, 0);
const AI_MAX_TURNS = envNumber("LINKQT_AI_MAX_TURNS", 8, 1);
const SSE_HEARTBEAT_MS = Number(process.env.LINKQT_SSE_HEARTBEAT_MS ?? 5_000);
const MAX_DOCUMENT_CHARS = 750_000;

type JwtPayload = { sub: string; user_id?: string; email?: string | null };

type UserProfile = {
  user_id: string;
  email: string | null;
  subdomain: string | null;
  created_at: string;
  updated_at: string;
};

type BuilderProject = {
  id: string;
  user_id: string;
  title: string;
  origin: "ai" | "manual";
  deployed_run_id?: string | null;
  deployed_at?: string | null;
  created_at: string;
  updated_at: string;
};

type BuilderRun = {
  id: string;
  project_id: string;
  user_id: string;
  parent_run_id: string | null;
  kind: "ai" | "manual";
  status: "pending" | "completed" | "failed";
  is_seed: boolean;
  title: string | null;
  prompt: string | null;
  document: string;
  links_json: string;
  links?: BuilderLink[];
  tool_event_count?: number;
  created_at: string;
};

type BuilderLink = {
  label: string;
  url: string;
};

type AiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type BuilderAiLogContext = {
  requestId: string;
  path: string;
  userLabel: string;
  sourceRunId?: string;
  projectId?: string;
  promptPreview?: string;
};

type SelectedRunAiContext = {
  title: string | null;
  prompt: string | null;
  status: BuilderRun["status"];
  events: BuilderRunToolEvent[];
};

type AiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type AiAttemptOutput = {
  document: string;
  content: string;
  toolCalls: Map<number, AiToolCall>;
};

type StreamWorkMeta = {
  title: string;
  runId?: string;
};

type PatchAgentCommand = {
  tool: string;
  args?: Record<string, unknown>;
};

type PatchAgentResult = {
  message: string;
  document?: string;
  changed?: boolean;
};

type PatchVerification = {
  satisfied: boolean;
  reason: string;
  suggestions: Array<{ lineStart: number; lineEnd: number; issue: string; suggestion: string }>;
};

type BuilderRunToolEvent = {
  id: string;
  run_id: string;
  project_id: string;
  user_id: string;
  sequence: number;
  event_type: string;
  tool_name: string | null;
  status: string;
  message: string;
  args_json: string;
  result_json: string;
  document_hash: string | null;
  duration_ms: number | null;
  created_at: string;
};

type ToolTraceRecorder = (event: {
  eventType: string;
  toolName?: string | null;
  status?: string;
  message: string;
  args?: unknown;
  result?: unknown;
  documentHash?: string | null;
  durationMs?: number | null;
}) => void;

type StreamSender = (event: string, data: unknown) => boolean | void;

const clerkEmailCache = new Map<string, string | null>();
let clerkClient: ReturnType<typeof createClerkClient> | null = null;
export async function handleLinkqtRequest(request: Request): Promise<Response> {
  await ensureSchema();
  await failStalePendingRuns();
  const url = apiUrl(request);
    if (request.method === "OPTIONS") return withCors(request, new Response(null, { status: 204 }));

    try {
      if (url.pathname === "/health") return json(request, { ok: true });

      if (url.pathname === "/me/profile" && request.method === "GET") {
        const user = await requireClerkUser(request);
        return json(request, { profile: serializeProfile(await ensureUserProfile(user)) });
      }

      if (url.pathname === "/me/stats" && request.method === "GET") {
        const user = await requireClerkUser(request);
        return json(request, { stats: await computeUserStats(userId(user)) });
      }

      if (url.pathname === "/me/subdomain" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json() as { subdomain?: unknown };
        return json(request, { profile: serializeProfile(await reserveSubdomainForUser(user, body.subdomain)) });
      }

      if (url.pathname === "/v1/models" && request.method === "GET") {
        if (!ENABLE_AI_PROXY) return json(request, { error: { message: "Not found." } }, 404);
        const user = await requireClerkUser(request);
        await assertAiCreditAvailable(user);
        await consumeAiCredit(user);
        return proxy(request, "/v1/models", user);
      }

      if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
        if (!ENABLE_AI_PROXY) return json(request, { error: { message: "Not found." } }, 404);
        const user = await requireClerkUser(request);
        await assertAiCreditAvailable(user);
        await consumeAiCredit(user);
        return proxy(request, "/v1/chat/completions", user);
      }

      if (url.pathname === "/builder/projects" && request.method === "GET") {
        const user = await requireClerkUser(request);
        return json(request, { projects: await listProjects(userId(user)) });
      }

      if (url.pathname === "/builder/manual-project" && request.method === "POST") {
        const user = await requireClerkUser(request);
        assertContentLength(request, MAX_DOCUMENT_CHARS + 20_000);
        const body = await request.json() as { document?: unknown; title?: unknown; links?: unknown };
        const links = normalizeLinks(body.links);
        const document = assertAllowedLinks(normalizeDocument(body.document), { allowedLinks: links });
        const title = stringValue(body.title) || titleFromDocument(document) || "Manual document";
        return await jsonWithIdempotency(request, userId(user), url.pathname, body, async () => {
          return await createProjectWithRun({ userId: userId(user), origin: "manual", title, runTitle: title, kind: "manual", prompt: null, document, links });
        });
      }

      if (url.pathname === "/builder/blank-project" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json().catch(() => ({})) as { title?: unknown };
        const title = projectTitleValue(body.title) || "Blank project";
        return await jsonWithIdempotency(request, userId(user), url.pathname, body, async () => {
          return await createProjectWithRun({ userId: userId(user), origin: "manual", title, runTitle: title, kind: "manual", prompt: null, document: "", links: [], isSeed: true });
        });
      }

      if (url.pathname === "/builder/blank-run" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json().catch(() => ({})) as { projectId?: unknown };
        const projectId = stringValue(body.projectId);
        if (!projectId) return json(request, { error: { message: "projectId is required." } }, 400);
        return await jsonWithIdempotency(request, userId(user), url.pathname, body, async () => {
          const project = await getProjectForUser(userId(user), projectId);
          const run = await appendVersion({ userId: userId(user), projectId: project.id, parentRunId: null, kind: "manual", title: null, prompt: null, document: "", links: [], isSeed: true });
          return { run, project: await getProjectForUser(userId(user), project.id) };
        });
      }

      if (url.pathname === "/builder/rename-project" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json() as { projectId?: unknown; title?: unknown };
        const projectId = stringValue(body.projectId);
        const title = projectTitleValue(body.title);
        if (!projectId) return json(request, { error: { message: "projectId is required." } }, 400);
        if (!title) return json(request, { error: { message: "Project title is required." } }, 400);
        return json(request, { project: await renameProjectForUser(userId(user), projectId, title) });
      }

      if (url.pathname === "/builder/revise" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json() as { runId?: unknown; parentRunId?: unknown; prompt?: unknown; links?: unknown };
        const sourceRunId = stringValue(body.runId) || stringValue(body.parentRunId);
        const prompt = stringValue(body.prompt);
        if (!sourceRunId) return json(request, { error: { message: "runId is required." } }, 400);
        if (!prompt) return json(request, { error: { message: "Prompt is required." } }, 400);

        return await jsonWithIdempotency(request, userId(user), url.pathname, body, async () => {
          await assertAiCreditAvailable(user);
          const sourceRun = await getRunForUser(userId(user), sourceRunId);
          const links = normalizeLinks(body.links);
          const title = await versionTitleForPrompt(prompt, { requestId: crypto.randomUUID().slice(0, 8), path: url.pathname, userLabel: user.email ?? user.user_id ?? user.sub ?? "unknown", sourceRunId, projectId: sourceRun.project_id, promptPreview: truncate(prompt.replace(/\s+/g, " "), 160) });
          const document = assertAllowedLinks(await reviseDocument(sourceRun.document, prompt, links), { allowedLinks: links, existingDocument: sourceRun.document });
          const run = await appendVersion({ userId: userId(user), projectId: sourceRun.project_id, parentRunId: sourceRun.id, kind: "ai", title, prompt, document, links });
          await consumeAiCredit(user);
          return { run, project: await getProjectForUser(userId(user), sourceRun.project_id) };
        });
      }

      if (url.pathname === "/builder/revise/stream" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json() as { runId?: unknown; parentRunId?: unknown; prompt?: unknown; links?: unknown };
        const sourceRunId = stringValue(body.runId) || stringValue(body.parentRunId);
        const prompt = stringValue(body.prompt);
        if (!sourceRunId) return json(request, { error: { message: "runId is required." } }, 400);
        if (!prompt) return json(request, { error: { message: "Prompt is required." } }, 400);

        const replay = await replayOrClaimIdempotency(request, userId(user), url.pathname, body);
        if (replay.mode === "replay") return replayStreamResult(request, userId(user), replay.record);

        await assertAiCreditAvailable(user);
        const sourceRun = await getRunForUser(userId(user), sourceRunId);
        const links = normalizeLinks(body.links);
        const requestId = crypto.randomUUID().slice(0, 8);
        if (isBlankDocument(sourceRun.document)) {
          return streamAiDocument(request, {
            log: {
              requestId,
              path: url.pathname,
              userLabel: user.email ?? user.user_id ?? user.sub ?? "unknown",
              sourceRunId,
              projectId: sourceRun.project_id,
              promptPreview: truncate(prompt.replace(/\s+/g, " "), 160),
            },
            trace: { userId: userId(user), projectId: sourceRun.project_id },
            traceMode: "blank_generation",
            sourceDocument: sourceRun.document,
            system: streamingDocumentCreationSystem(),
            user: creationUserPrompt(prompt, links),
            async beforeWork(send) {
              send("status", { message: "Naming this run" });
              const title = await versionTitleForPrompt(prompt, {
                requestId,
                path: url.pathname,
                userLabel: user.email ?? user.user_id ?? user.sub ?? "unknown",
                sourceRunId,
                projectId: sourceRun.project_id,
                promptPreview: truncate(prompt.replace(/\s+/g, " "), 160),
              });
              const run = await appendVersion({ userId: userId(user), projectId: sourceRun.project_id, parentRunId: sourceRun.id, kind: "ai", status: "pending", title, prompt, document: sourceRun.document, links });
              await consumeAiCredit(user);
              await updateIdempotencyRecord(replay, { pending: true, runId: run.id });
              const project = await getProjectForUser(userId(user), sourceRun.project_id);
              send("started", { project, run });
              return { title, runId: run.id };
            },
            async save(content, meta) {
              const document = assertAllowedLinks(normalizeDocument(content), { allowedLinks: links, existingDocument: sourceRun.document });
              const run = meta.runId
                ? await completeRunVersion({ userId: userId(user), runId: meta.runId, document, links })
                : await appendVersion({ userId: userId(user), projectId: sourceRun.project_id, parentRunId: sourceRun.id, kind: "ai", title: meta.title, prompt, document, links });
              const result = { run, project: await getProjectForUser(userId(user), sourceRun.project_id) };
              await updateIdempotencyRecord(replay, result);
              return result;
            },
            async fail(meta) {
              if (meta?.runId) await markRunStatus(userId(user), meta.runId, "failed");
              await updateIdempotencyRecord(replay, { error: { message: "Streaming AI request failed." } }, 502);
            },
          });
        }
        return streamAiPatchDocument(request, {
          log: {
            requestId,
            path: url.pathname,
            userLabel: user.email ?? user.user_id ?? user.sub ?? "unknown",
            sourceRunId,
            projectId: sourceRun.project_id,
            promptPreview: truncate(prompt.replace(/\s+/g, " "), 160),
          },
          trace: { userId: userId(user), projectId: sourceRun.project_id },
          currentDocument: sourceRun.document,
          prompt,
          links,
          selectedRunContext: await selectedRunAiContext(userId(user), sourceRun),
          async beforeWork(send) {
            send("status", { message: "Naming this run" });
            const title = await versionTitleForPrompt(prompt, {
              requestId,
              path: url.pathname,
              userLabel: user.email ?? user.user_id ?? user.sub ?? "unknown",
              sourceRunId,
              projectId: sourceRun.project_id,
              promptPreview: truncate(prompt.replace(/\s+/g, " "), 160),
            });
            const run = await appendVersion({ userId: userId(user), projectId: sourceRun.project_id, parentRunId: sourceRun.id, kind: "ai", status: "pending", title, prompt, document: sourceRun.document, links });
            await consumeAiCredit(user);
            await updateIdempotencyRecord(replay, { pending: true, runId: run.id });
            const project = await getProjectForUser(userId(user), sourceRun.project_id);
            send("started", { project, run });
            return { title, runId: run.id };
          },
          async save(content, meta) {
            const document = assertAllowedLinks(normalizeDocument(content), { allowedLinks: links, existingDocument: sourceRun.document });
            const run = meta.runId
              ? await completeRunVersion({ userId: userId(user), runId: meta.runId, document, links })
              : await appendVersion({ userId: userId(user), projectId: sourceRun.project_id, parentRunId: sourceRun.id, kind: "ai", title: meta.title, prompt, document, links });
            const result = { run, project: await getProjectForUser(userId(user), sourceRun.project_id) };
            await updateIdempotencyRecord(replay, result);
            return result;
          },
          async fail(meta) {
            if (meta?.runId) await markRunStatus(userId(user), meta.runId, "failed");
            await updateIdempotencyRecord(replay, { error: { message: "Streaming AI request failed." } }, 502);
          },
        });
      }

      if (url.pathname === "/builder/version" && request.method === "POST") {
        const user = await requireClerkUser(request);
        assertContentLength(request, MAX_DOCUMENT_CHARS + 20_000);
        const body = await request.json() as { runId?: unknown; parentRunId?: unknown; document?: unknown; links?: unknown };
        const sourceRunId = stringValue(body.runId) || stringValue(body.parentRunId);
        if (!sourceRunId) return json(request, { error: { message: "runId is required." } }, 400);

        return await jsonWithIdempotency(request, userId(user), url.pathname, body, async () => {
          const sourceRun = await getRunForUser(userId(user), sourceRunId);
          const links = normalizeLinks(body.links);
          const document = assertAllowedLinks(normalizeDocument(body.document), { allowedLinks: links, existingDocument: sourceRun.document });
          const run = await appendVersion({ userId: userId(user), projectId: sourceRun.project_id, parentRunId: sourceRun.id, kind: "manual", title: titleFromDocument(document) || "Manual edit", prompt: null, document, links });
          return { run, project: await getProjectForUser(userId(user), sourceRun.project_id) };
        });
      }

      if (url.pathname === "/builder/clone-project" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json() as { runId?: unknown; title?: unknown };
        const runId = stringValue(body.runId);
        if (!runId) return json(request, { error: { message: "runId is required." } }, 400);
        return await jsonWithIdempotency(request, userId(user), url.pathname, body, async () => {
          return await cloneProjectFromRun(userId(user), runId, stringValue(body.title));
        });
      }

      if (url.pathname === "/builder/delete-project" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json() as { projectId?: unknown };
        const projectId = stringValue(body.projectId);
        if (!projectId) return json(request, { error: { message: "projectId is required." } }, 400);
        await deleteProjectForUser(userId(user), projectId);
        return json(request, { ok: true });
      }

      if (url.pathname === "/builder/delete-run" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json() as { runId?: unknown };
        const runId = stringValue(body.runId);
        if (!runId) return json(request, { error: { message: "runId is required." } }, 400);
        await deleteRunForUser(userId(user), runId);
        return json(request, { ok: true });
      }

      const toolEventsMatch = url.pathname.match(/^\/builder\/runs\/([^/]+)\/tool-events$/);
      if (toolEventsMatch && request.method === "GET") {
        const user = await requireClerkUser(request);
        const runId = decodeURIComponent(toolEventsMatch[1]);
        return json(request, { events: await listRunToolEvents(userId(user), runId) });
      }

      if (url.pathname === "/builder/deploy" && request.method === "POST") {
        const user = await requireClerkUser(request);
        const body = await request.json() as { runId?: unknown };
        const runId = stringValue(body.runId);
        if (!runId) return json(request, { error: { message: "runId is required." } }, 400);
        return await jsonWithIdempotency(request, userId(user), url.pathname, body, async () => {
          const profile = await requireCompleteProfile(userId(user));
          return { deployment: await deployRun(userId(user), profile.subdomain, runId) };
        });
      }

      const siteJsonMatch = url.pathname.match(/^\/site\/([^/]+)$/);
      if (siteJsonMatch && request.method === "GET") {
        const subdomain = normalizeSubdomainInput(decodeURIComponent(siteJsonMatch[1]));
        const deployment = await currentDeployment(subdomain);
        if (!deployment) return json(request, { error: { message: "Site not found." } }, 404);
        return json(request, { document: deployment.document });
      }

      const siteDocumentMatch = url.pathname.match(/^\/site\/([^/]+)\/document$/);
      if (siteDocumentMatch && request.method === "GET") {
        const subdomain = normalizeSubdomainInput(decodeURIComponent(siteDocumentMatch[1]));
        const deployment = await currentDeployment(subdomain);
        if (!deployment) return htmlDocument(notFoundDocument(subdomain), 404);
        return htmlDocument(deployment.document);
      }

      return json(request, { error: { message: `Unknown endpoint: ${url.pathname}` } }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = statusFromError(message);
      console.error(`${request.method} ${url.pathname} -> ${status} ${message}`);
      return json(request, { error: { message: clientErrorMessage(error) } }, status);
    }
}

async function ensureUserProfile(user: JwtPayload) {
  const id = userId(user);
  const email = typeof user.email === "string" && user.email.trim() ? user.email.trim() : null;
  const existing = await queryOne<UserProfile>("select user_id, email, subdomain, created_at, updated_at from user_profiles where user_id = ?", [id]);
  if (existing) {
    if (email && email !== existing.email) {
      await queryRun("update user_profiles set email = ?, updated_at = ? where user_id = ?", [email, new Date().toISOString(), id]);
      return await queryOne<UserProfile>("select user_id, email, subdomain, created_at, updated_at from user_profiles where user_id = ?", [id])!;
    }
    return existing;
  }
  const now = new Date().toISOString();
  await queryRun("insert into user_profiles (user_id, email, subdomain, created_at, updated_at) values (?, ?, null, ?, ?)", [id, email, now, now]);
  return await queryOne<UserProfile>("select user_id, email, subdomain, created_at, updated_at from user_profiles where user_id = ?", [id])!;
}

function serializeProfile(profile: UserProfile) {
  return {
    user_id: profile.user_id,
    email: profile.email,
    subdomain: profile.subdomain,
    registration_complete: Boolean(profile.subdomain),
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

async function reserveSubdomainForUser(user: JwtPayload, value: unknown) {
  const id = userId(user);
  const profile = await ensureUserProfile(user);
  const subdomain = normalizeSubdomainInput(value);
  if (profile.subdomain && profile.subdomain !== subdomain) throw new Error("Subdomain is already registered for this account.");
  const owner = await queryOne<{ user_id: string }>("select user_id from user_profiles where subdomain = ?", [subdomain]);
  if (owner && owner.user_id !== id) throw new Error("Subdomain is already taken.");
  const now = new Date().toISOString();
  await queryRun("update user_profiles set subdomain = ?, updated_at = ? where user_id = ?", [subdomain, now, id]);
  return await requireProfile(id);
}

async function requireProfile(userIdValue: string) {
  const profile = await queryOne<UserProfile>("select user_id, email, subdomain, created_at, updated_at from user_profiles where user_id = ?", [userIdValue]);
  if (!profile) throw new Error("User profile not found.");
  return profile;
}

async function requireCompleteProfile(userIdValue: string): Promise<UserProfile & { subdomain: string }> {
  const profile = await requireProfile(userIdValue);
  if (!profile.subdomain) throw new Error("Register a subdomain before deploying.");
  return { ...profile, subdomain: profile.subdomain };
}

async function listProjects(userIdValue: string): Promise<Array<BuilderProject & { runs: Array<BuilderRun & { preview: string }>; open_canvases: Array<BuilderRun & { preview: string }> }>> {
  const projects = await queryAll<BuilderProject>(`
    select id, user_id, title, origin, created_at, updated_at
    from builder_projects
    where user_id = ?
    order by updated_at desc
  `, [userIdValue]);
  const currentDeployment = await latestDeploymentForUser(userIdValue);

  const runs = await queryAll<BuilderRun>(`
    select
      id, project_id, user_id, parent_run_id, kind, status, is_seed, title, prompt, document, links_json, created_at,
      (
        select count(*)::int
        from builder_run_tool_events
        where builder_run_tool_events.run_id = builder_runs.id
      ) as tool_event_count
    from builder_runs
    where user_id = ?
    order by created_at asc
  `, [userIdValue]);

  return projects.map((project) => {
    const allRuns = projectRuns(runs, project.id);
    const parentIds = new Set(allRuns.map((run) => run.parent_run_id).filter((id): id is string => Boolean(id)));
    return {
      ...project,
      deployed_run_id: currentDeployment?.project_id === project.id ? currentDeployment.run_id : null,
      deployed_at: currentDeployment?.project_id === project.id ? currentDeployment.deployed_at : null,
      runs: allRuns.filter((run) => !run.is_seed),
      open_canvases: allRuns.filter((run) => run.is_seed && !parentIds.has(run.id)),
    };
  });
}

async function computeUserStats(userIdValue: string) {
  const totalProjects = (await queryOne<{ c: number }>("select count(*)::int as c from builder_projects where user_id = ?", [userIdValue]))?.c ?? 0;

  const runRows = await queryAll<{ kind: string; c: number }>("select kind, count(*)::int as c from builder_runs where user_id = ? and is_seed = 0 group by kind", [userIdValue]);
  const aiRuns = runRows.find((row) => row.kind === "ai")?.c ?? 0;
  const manualRuns = runRows.find((row) => row.kind === "manual")?.c ?? 0;

  const deployedPages = (await queryOne<{ c: number }>("select count(distinct project_id)::int as c from deployments where user_id = ?", [userIdValue]))?.c ?? 0;

  const today = new Date().toISOString().slice(0, 10);
  const aiUsedToday = (await queryOne<{ count: number }>("select count from ai_usage where user_id = ? and day = ?", [userIdValue, today]))?.count ?? 0;

  return {
    total_projects: totalProjects,
    total_runs: aiRuns + manualRuns,
    ai_runs: aiRuns,
    manual_runs: manualRuns,
    deployed_pages: deployedPages,
    ai_used_today: aiUsedToday,
    ai_daily_limit: AI_DAILY_LIMIT,
  };
}

async function latestDeploymentForUser(userIdValue: string) {
  return await queryOne<{ project_id: string; run_id: string; deployed_at: string }>(`
    select project_id, run_id, deployed_at
    from deployments
    where user_id = ?
    order by deployed_at desc
    limit 1
  `, [userIdValue]) ?? null;
}

function projectRuns(runs: BuilderRun[], projectId: string): Array<BuilderRun & { preview: string }> {
  return runs
    .filter((run) => run.project_id === projectId)
    .map((run) => ({ ...runWithLinks(run), preview: textPreview(run.document) }));
}

async function createProjectWithRun(input: { userId: string; origin: "ai" | "manual"; title: string; runTitle?: string; kind: "ai" | "manual"; prompt: string | null; document: string; links?: BuilderLink[]; isSeed?: boolean }) {
  const now = new Date().toISOString();
  const project: BuilderProject = { id: crypto.randomUUID(), user_id: input.userId, title: input.title, origin: input.origin, created_at: now, updated_at: now };
  await queryRun(`
    insert into builder_projects (id, user_id, title, origin, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?)
  `, [project.id, project.user_id, project.title, project.origin, project.created_at, project.updated_at]);
  const run = await createRun({ userId: input.userId, projectId: project.id, kind: input.kind, title: input.runTitle ?? input.title, prompt: input.prompt, document: input.document, links: input.links ?? [], isSeed: input.isSeed, now });
  return { project, run };
}

async function renameProjectForUser(userIdValue: string, projectId: string, title: string) {
  await getProjectForUser(userIdValue, projectId);
  await queryRun("update builder_projects set title = ?, updated_at = ? where id = ? and user_id = ?", [title, new Date().toISOString(), projectId, userIdValue]);
  return await getProjectForUser(userIdValue, projectId);
}

async function appendVersion(input: { userId: string; projectId: string; parentRunId?: string | null; kind: "ai" | "manual"; status?: BuilderRun["status"]; title?: string | null; prompt: string | null; document: string; links?: BuilderLink[]; isSeed?: boolean }) {
  const now = new Date().toISOString();
  const run = await createRun({ ...input, links: input.links ?? [], now });
  await queryRun("update builder_projects set updated_at = ? where id = ? and user_id = ?", [now, input.projectId, input.userId]);
  return run;
}

async function completeRunVersion(input: { userId: string; runId: string; document: string; links: BuilderLink[] }) {
  const run = await getRunForUser(input.userId, input.runId);
  const linksJson = JSON.stringify(normalizeLinks(input.links));
  const now = new Date().toISOString();
  await queryRun(`
    update builder_runs
    set document = ?, links_json = ?, status = 'completed'
    where id = ? and user_id = ?
  `, [input.document, linksJson, input.runId, input.userId]);
  await queryRun("update builder_projects set updated_at = ? where id = ? and user_id = ?", [now, run.project_id, input.userId]);
  return await getRunForUser(input.userId, input.runId);
}

async function markRunStatus(userIdValue: string, runId: string, status: BuilderRun["status"]) {
  const run = await getRunForUser(userIdValue, runId);
  await queryRun("update builder_runs set status = ? where id = ? and user_id = ?", [status, runId, userIdValue]);
  await queryRun("update builder_projects set updated_at = ? where id = ? and user_id = ?", [new Date().toISOString(), run.project_id, userIdValue]);
}

async function listRunToolEvents(userIdValue: string, runId: string) {
  await getRunForUser(userIdValue, runId);
  return (await queryAll<BuilderRunToolEvent>(`
    select id, run_id, project_id, user_id, sequence, event_type, tool_name, status, message, args_json, result_json, document_hash, duration_ms, created_at
    from builder_run_tool_events
    where run_id = ? and user_id = ?
    order by sequence asc
  `, [runId, userIdValue])).map((event) => ({
    ...event,
    event_type: event.event_type === "upstream_retry" ? "retry" : event.event_type,
    args_json: publicToolEventJson(event.args_json),
    result_json: publicToolEventJson(event.result_json),
    message: clientErrorMessage(event.message),
  }));
}

async function selectedRunAiContext(userIdValue: string, run: BuilderRun): Promise<SelectedRunAiContext> {
  return {
    title: run.title,
    prompt: run.prompt,
    status: run.status,
    events: await listRunToolEvents(userIdValue, run.id),
  };
}

async function recordRunToolEvent(input: {
  runId: string;
  projectId: string;
  userId: string;
  sequence: number;
  eventType: string;
  toolName?: string | null;
  status?: string;
  message: string;
  args?: unknown;
  result?: unknown;
  documentHash?: string | null;
  durationMs?: number | null;
}) {
  await queryRun(`
    insert into builder_run_tool_events (id, run_id, project_id, user_id, sequence, event_type, tool_name, status, message, args_json, result_json, document_hash, duration_ms, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [crypto.randomUUID(),
    input.runId,
    input.projectId,
    input.userId,
    input.sequence,
    input.eventType,
    input.toolName ?? null,
    input.status ?? "info",
    truncate(input.message, 1000),
    safeStringifyTrace(input.args ?? {}),
    safeStringifyTrace(input.result ?? {}),
    input.documentHash ?? null,
    input.durationMs ?? null,
    new Date().toISOString(),]);
}

async function cloneProjectFromRun(userIdValue: string, runId: string, requestedTitle: string) {
  const sourceRun = await getRunForUser(userIdValue, runId);
  assertVisibleCompletedRun(sourceRun);
  const sourceProject = await getProjectForUser(userIdValue, sourceRun.project_id);
  const title = requestedTitle || `${sourceProject.title} copy`;
  const links = sourceRun.links ?? linksFromJson(sourceRun.links_json);
  assertAllowedLinks(sourceRun.document, { allowedLinks: links, existingDocument: sourceRun.document });
  return await createProjectWithRun({
    userId: userIdValue,
    origin: sourceProject.origin,
    title,
    runTitle: sourceRun.title || title,
    kind: sourceRun.kind,
    prompt: sourceRun.prompt,
    document: sourceRun.document,
    links,
  });
}

async function createRun(input: { userId: string; projectId: string; parentRunId?: string | null; kind: "ai" | "manual"; status?: BuilderRun["status"]; title?: string | null; prompt: string | null; document: string; links: BuilderLink[]; isSeed?: boolean; now: string }): Promise<BuilderRun> {
  const run: BuilderRun = {
    id: crypto.randomUUID(),
    project_id: input.projectId,
    user_id: input.userId,
    parent_run_id: input.parentRunId ?? null,
    kind: input.kind,
    status: input.status ?? "completed",
    is_seed: Boolean(input.isSeed),
    title: input.title ?? null,
    prompt: input.prompt,
    document: input.document,
    links_json: JSON.stringify(input.links),
    links: input.links,
    created_at: input.now,
  };
  await queryRun(`
    insert into builder_runs (id, project_id, user_id, parent_run_id, kind, status, is_seed, title, prompt, document, links_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [run.id, run.project_id, run.user_id, run.parent_run_id, run.kind, run.status, run.is_seed ? 1 : 0, run.title, run.prompt, run.document, run.links_json, run.created_at]);
  return run;
}

async function getRunForUser(userIdValue: string, runId: string) {
  const run = await queryOne<BuilderRun>(`
    select id, project_id, user_id, parent_run_id, kind, status, is_seed, title, prompt, document, links_json, created_at
    from builder_runs
    where id = ? and user_id = ?
  `, [runId, userIdValue]);
  if (!run) throw new Error("Run not found.");
  return runWithLinks(run);
}

async function getProjectForUser(userIdValue: string, projectId: string) {
  const project = await queryOne<BuilderProject>(`
    select id, user_id, title, origin, created_at, updated_at
    from builder_projects
    where id = ? and user_id = ?
  `, [projectId, userIdValue]);
  if (!project) throw new Error("Project not found.");
  return project;
}

async function deleteProjectForUser(userIdValue: string, projectId: string) {
  await getProjectForUser(userIdValue, projectId);
  await queryRun("delete from deployments where project_id = ? and user_id = ?", [projectId, userIdValue]);
  await queryRun("delete from builder_runs where project_id = ? and user_id = ?", [projectId, userIdValue]);
  await queryRun("delete from builder_projects where id = ? and user_id = ?", [projectId, userIdValue]);
}

async function deleteRunForUser(userIdValue: string, runId: string) {
  const run = await queryOne<BuilderRun>(`
    select id, project_id, user_id, parent_run_id, kind, status, is_seed, title, prompt, document, links_json, created_at
    from builder_runs
    where id = ? and user_id = ?
  `, [runId, userIdValue]);
  if (!run) return;
  const children = (await queryOne<{ count: number }>("select count(*)::int as count from builder_runs where parent_run_id = ? and user_id = ?", [runId, userIdValue]))?.count ?? 0;
  if (children > 0) throw new Error("Cannot delete a run that still has child versions.");
  if (run.is_seed) {
    const total = (await queryOne<{ count: number }>("select count(*)::int as count from builder_runs where project_id = ? and user_id = ?", [run.project_id, userIdValue]))?.count ?? 0;
    if (total <= 1) throw new Error("Cannot delete the only canvas. Delete the project instead.");
  } else {
    const count = (await queryOne<{ count: number }>("select count(*)::int as count from builder_runs where project_id = ? and user_id = ? and is_seed = 0", [run.project_id, userIdValue]))?.count ?? 0;
    if (count <= 1) throw new Error("Cannot delete the only run. Delete the project instead.");
  }
  await queryRun("delete from deployments where run_id = ? and user_id = ?", [runId, userIdValue]);
  await queryRun("delete from builder_runs where id = ? and user_id = ?", [runId, userIdValue]);
  await queryRun("update builder_projects set updated_at = ? where id = ? and user_id = ?", [new Date().toISOString(), run.project_id, userIdValue]);
}

async function deployRun(userIdValue: string, siteKey: string, runId: string) {
  const run = await getRunForUser(userIdValue, runId);
  assertVisibleCompletedRun(run);
  assertAllowedLinks(run.document, { allowedLinks: run.links ?? linksFromJson(run.links_json), existingDocument: run.document });
  await assertCanDeploySite(userIdValue, siteKey);
  const latest = await queryOne<{ id: string; user_id: string; site_key: string; project_id: string; run_id: string; document: string; deployed_at: string }>(
    "select id, user_id, site_key, project_id, run_id, document, deployed_at from deployments where site_key = ? order by deployed_at desc limit 1",
    [siteKey],
  );
  if (latest?.run_id === run.id) return latest;
  const deployment = { id: crypto.randomUUID(), user_id: userIdValue, site_key: siteKey, project_id: run.project_id, run_id: run.id, document: run.document, deployed_at: new Date().toISOString() };
  await queryRun(`
    insert into deployments (id, user_id, site_key, project_id, run_id, document, deployed_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `, [deployment.id, deployment.user_id, deployment.site_key, deployment.project_id, deployment.run_id, deployment.document, deployment.deployed_at]);
  return deployment;
}

function assertCompletedRun(run: BuilderRun) {
  if (run.status !== "completed") throw new Error("Run must be completed before this action.");
}

function assertVisibleCompletedRun(run: BuilderRun) {
  assertCompletedRun(run);
  if (run.is_seed) throw new Error("Blank project seeds are internal and cannot be used for this action.");
}

async function assertCanDeploySite(userIdValue: string, siteKey: string) {
  const profile = await requireCompleteProfile(userIdValue);
  if (profile.subdomain !== siteKey) throw new Error(`Site ${siteKey} is owned by another user.`);
  const owner = await queryOne<{ user_id: string }>("select user_id from deployment_targets where site_key = ?", [siteKey]);
  if (owner) {
    if (owner.user_id !== userIdValue) throw new Error(`Site ${siteKey} is owned by another user.`);
    return;
  }
  await queryRun("insert into deployment_targets (site_key, user_id, created_at) values (?, ?, ?)", [siteKey, userIdValue, new Date().toISOString()]);
}

async function currentDeployment(siteKey: string): Promise<{ document: string } | null> {
  return await currentDeploymentDocument(siteKey) ?? null;
}

async function reviseDocument(currentDocument: string, prompt: string, links: BuilderLink[] = []) {
  if (isBlankDocument(currentDocument)) {
    return aiDocument({
      system: documentCreationSystem(),
      user: creationUserPrompt(prompt, links),
    });
  }
  return aiDocument({
    system: documentRevisionSystem(),
    user: revisionUserPrompt(currentDocument, prompt, links),
  });
}

async function versionTitleForPrompt(prompt: string, log?: BuilderAiLogContext) {
  try {
    console.log(`${log?.requestId ?? "title"} ${log?.path ?? "/builder/revise"} ai_title_start model=${AI_MODEL} prompt="${truncate(prompt.replace(/\s+/g, " "), 160)}"`);
    const title = sanitizeVersionTitle(await aiText({
      system: [
        "Create a concise title for a saved website revision.",
        "Use the user's prompt only.",
        "Return only the title text.",
        "Do not use quotes, markdown, punctuation-only labels, or explanations.",
        "Maximum 48 characters.",
      ].join(" "),
      user: prompt,
      log,
    }));
    console.log(`${log?.requestId ?? "title"} ${log?.path ?? "/builder/revise"} ai_title_success title="${title}"`);
    return title;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown title error";
    const fallback = fallbackVersionTitle(prompt);
    console.error(`${log?.requestId ?? "title"} ${log?.path ?? "/builder/revise"} ai_title_failed error=${message} fallback="${fallback}"`);
    return fallback;
  }
}

function documentRevisionSystem() {
  return [
    "You are editing a complete single-file website for LinkQT.",
    "You must call the replace_document tool with the full revised document.",
    "The tool document argument must be one complete HTML document, not a diff.",
    "Preserve working parts of the current page unless the user asks to change them.",
    "Repurpose and improve the current document instead of replacing it with a generic demo template.",
    "Keep it as one complete self-contained HTML file with inline CSS and JS.",
    linkSystemRules(),
    "Do not answer in prose, markdown, or Ask mode. Use the tool call.",
  ].join(" ");
}

function documentCreationSystem() {
  return [
    "You are creating the first complete single-file website for a new empty LinkQT project.",
    "You must call the replace_document tool with the full generated document.",
    "The tool document argument must be one complete HTML document, not a diff.",
    "Start from the user's request and approved links only; there is no existing HTML to preserve.",
    "Keep it as one complete self-contained HTML file with inline CSS and JS.",
    linkSystemRules(),
    "Do not answer in prose, markdown, or Ask mode. Use the tool call.",
  ].join(" ");
}

function streamingDocumentCreationSystem() {
  return [
    "You are creating the first complete single-file website for a new empty LinkQT project.",
    "Return the full generated document directly as plain text.",
    "The response must be one complete HTML document, not a diff.",
    "Start with <!doctype html> and include the full <html> document.",
    "Start from the user's request and approved links only; there is no existing HTML to preserve.",
    "Use inline CSS and JS only.",
    linkSystemRules(),
    "Do not answer in prose, markdown, JSON, code fences, or Ask mode.",
  ].join(" ");
}

function linkSystemRules() {
  return [
    "For outbound clickable <a> links and form actions, use only URLs provided in ALLOWED_LINKS or URLs already present in the current document.",
    "Never invent fake, placeholder, example, demo, or guessed outbound link URLs.",
    "You may freely reference external https resources by URL: images, fonts, stylesheets, and media (img, link, CSS url(), video/audio). Always use https for these.",
    "Favicons are supported: add a <link rel=\"icon\"> using an inline SVG data: URI (data:image/svg+xml,...) or an https image. Inline SVG is fine and the xmlns \"http://www.w3.org/2000/svg\" namespace is allowed (it is a namespace identifier, not an outbound resource).",
    "Do not add external <script src> URLs unless they are in ALLOWED_LINKS or already present in the document.",
    "If an outbound link is needed but no matching allowed URL is provided, render non-clickable text or omit it.",
    "For revisions, preserve existing real content and URLs unless the user explicitly asks to change them.",
  ].join(" ");
}

function creationUserPrompt(prompt: string, links: BuilderLink[]) {
  return [
    "CURRENT_DOCUMENT_START",
    "(empty project - no HTML exists yet)",
    "CURRENT_DOCUMENT_END",
    "",
    allowedLinksBlock(links),
    "",
    "CHANGE_REQUEST_START",
    prompt,
    "CHANGE_REQUEST_END",
  ].join("\n");
}

function revisionUserPrompt(currentDocument: string, prompt: string, links: BuilderLink[]) {
  return `CURRENT_DOCUMENT_START\n${currentDocument}\nCURRENT_DOCUMENT_END\n\n${allowedLinksBlock(links)}\n\nCHANGE_REQUEST_START\n${prompt}\nCHANGE_REQUEST_END`;
}

function allowedLinksBlock(links: BuilderLink[]) {
  if (links.length === 0) return "ALLOWED_LINKS_START\nNo outbound link URLs were provided. Do not create outbound clickable links or form actions unless preserving existing links during a revision. You may still use external https images, fonts, stylesheets, and media.\nALLOWED_LINKS_END";
  return [
    "ALLOWED_LINKS_START",
    ...links.map((link, index) => `${index + 1}. Label: ${link.label || "Untitled"}\n   URL: ${link.url}`),
    "ALLOWED_LINKS_END",
  ].join("\n");
}

function revisionTools() {
  return [{
    type: "function",
    function: {
      name: "replace_document",
      description: "Save the full revised LinkQT HTML document.",
      parameters: {
        type: "object",
        properties: {
          document: {
            type: "string",
            description: "A complete self-contained HTML document starting with <!doctype html>.",
          },
        },
        required: ["document"],
        additionalProperties: false,
      },
    },
  }];
}

function replaceDocumentToolChoice() {
  return { type: "function", function: { name: "replace_document" } };
}

async function aiDocument(input: { system: string; user: string }) {
  const text = await fetchAiChatCompletionText({
    phase: "document",
    timeoutMs: AI_TIMEOUT_MS,
    body: {
      model: AI_MODEL,
      stream: false,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      tools: revisionTools(),
      tool_choice: replaceDocumentToolChoice(),
    },
  });
  return normalizeDocument(extractAssistantDocument(text));
}

async function aiText(input: { system: string; user: string; log?: BuilderAiLogContext }) {
  const text = await fetchAiChatCompletionText({
    phase: "title",
    log: input.log,
    timeoutMs: Math.min(AI_TIMEOUT_MS, 20_000),
    body: {
      model: AI_MODEL,
      stream: false,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    },
  });
  return extractAssistantText(text);
}

async function fetchAiChatCompletionText(input: { phase: string; body: unknown; timeoutMs: number; log?: BuilderAiLogContext; turn?: number; send?: StreamSender; record?: ToolTraceRecorder; documentHash?: string | null }) {
  return withAiRetries({
    phase: input.phase,
    log: input.log,
    turn: input.turn,
    send: input.send,
    record: input.record,
    documentHash: input.documentHash,
  }, async (attempt) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    const startedAt = Date.now();
    const turnPart = input.turn ? ` turn=${input.turn}` : "";
    const prefix = aiLogPrefix(input.log);
    const url = aiChatCompletionsUrl();
    try {
      console.log(`${prefix} upstream_ai_${input.phase}_request_start${turnPart} attempt=${attempt} url=${url} model=${AI_MODEL} stream=false timeout_ms=${input.timeoutMs}`);
      const response = await fetch(url, {
        method: "POST",
        headers: aiRequestHeaders(),
        signal: controller.signal,
        body: JSON.stringify(stableAiRequestBody(input.body)),
      });
      const text = await response.text();
      console.log(`${prefix} upstream_ai_${input.phase}_response${turnPart} attempt=${attempt} status=${response.status} duration=${Date.now() - startedAt}ms chars=${text.length}`);
      if (!response.ok) {
        console.error(`${prefix} upstream_ai_${input.phase}_error${turnPart} attempt=${attempt} status=${response.status} body=${truncate(text.replace(/\s+/g, " ").trim(), 1000)}`);
        throw aiHttpFailure(response.status, text);
      }
      return text;
    } catch (error) {
      const failure = normalizeAiRequestFailure(error);
      console.error(`${prefix} upstream_ai_${input.phase}_failed${turnPart} attempt=${attempt} duration=${Date.now() - startedAt}ms error=${failure.message}`);
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  });
}

function streamAiPatchDocument(request: Request, input: { log: BuilderAiLogContext; trace: { userId: string; projectId: string }; currentDocument: string; prompt: string; links: BuilderLink[]; selectedRunContext?: SelectedRunAiContext; beforeWork?: (send: (event: string, data: unknown) => void) => Promise<StreamWorkMeta>; save: (content: string, meta: StreamWorkMeta) => Promise<{ project: BuilderProject; run: BuilderRun }>; fail?: (meta: StreamWorkMeta | null, error: unknown) => void | Promise<void> }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let streamClosed = false;
      const send = (event: string, data: unknown) => {
        if (streamClosed) return false;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch (error) {
          streamClosed = true;
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`${input.log.requestId} ${input.log.path} ai_patch_sse_closed event=${event} error=${message}`);
          return false;
        }
      };
      const heartbeat = setInterval(() => {
        send("heartbeat", { at: new Date().toISOString() });
      }, SSE_HEARTBEAT_MS);

      let meta: StreamWorkMeta | null = null;
      let record: ToolTraceRecorder | null = null;
      try {
        console.log(`${input.log.requestId} ${input.log.path} ai_patch_start user=${input.log.userLabel} model=${AI_MODEL} source_run=${input.log.sourceRunId ?? "unknown"} project=${input.log.projectId ?? "unknown"} prompt="${input.log.promptPreview ?? ""}"`);
        send("status", { message: "Starting patch agent" });
        meta = input.beforeWork ? await input.beforeWork(send) : { title: "AI revision" };
        if (meta.runId) {
          let sequence = 0;
          record = (event) => {
            sequence += 1;
            void recordRunToolEvent({
              runId: meta?.runId ?? "",
              projectId: input.trace.projectId,
              userId: input.trace.userId,
              sequence,
              ...event,
            });
          };
          record({ eventType: "agent_started", status: "started", message: "Patch agent started", args: { prompt: input.log.promptPreview }, documentHash: documentHash(input.currentDocument) });
        }
        const content = await runPatchAgent(input, send, record ?? undefined);
        console.log(`${input.log.requestId} ${input.log.path} ai_patch_document_ready chars=${content.length}`);
        send("status", { message: "Checking document safety" });
        record?.({ eventType: "validation_started", status: "started", message: "Checking document safety", documentHash: documentHash(content), result: { documentChars: content.length } });
        const result = await input.save(content, meta);
        console.log(`${input.log.requestId} ${input.log.path} ai_patch_saved project=${result.project.id} run=${result.run.id} document_chars=${result.run.document.length}`);
        record?.({ eventType: "run_completed", status: "success", message: "AI revision saved", documentHash: documentHash(result.run.document), result: { runId: result.run.id, documentChars: result.run.document.length } });
        send("document", { content: result.run.document });
        send("status", { message: "Saved run" });
        send("result", result);
        send("status", { message: "Done" });
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown patch agent error";
        console.error(`${input.log.requestId} ${input.log.path} ai_patch_failed user=${input.log.userLabel} source_run=${input.log.sourceRunId ?? "unknown"} project=${input.log.projectId ?? "unknown"} error=${message}`);
        if (error instanceof Error && error.stack) console.error(`${input.log.requestId} ${input.log.path} ai_patch_stack ${error.stack}`);
        record?.({ eventType: "run_failed", status: "error", message, result: { error: message } });
        try {
          await input.fail?.(meta, error);
        } catch (failError) {
          const failMessage = failError instanceof Error ? failError.message : String(failError);
          console.error(`${input.log.requestId} ${input.log.path} ai_patch_fail_marker_error ${failMessage}`);
        }
        send("error", { message: message.includes("timed out") ? "AI request timed out. Please try again." : "AI request failed. Please try again." });
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }
      } finally {
        clearInterval(heartbeat);
      }
    },
    cancel() {
      // The browser can close the SSE connection while the upstream model call is
      // still running. Tool execution should continue; only client delivery stops.
    },
  });

  return withCors(request, new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    },
  }));
}

async function runPatchAgent(input: { log: BuilderAiLogContext; currentDocument: string; prompt: string; links: BuilderLink[]; selectedRunContext?: SelectedRunAiContext }, send: (event: string, data: unknown) => void, record?: ToolTraceRecorder) {
  let draft = normalizeDocument(input.currentDocument);
  let changed = false;
  const messages: AiChatMessage[] = [
    { role: "system", content: patchAgentSystem() },
    { role: "user", content: patchAgentInitialUserPrompt(input.prompt, input.links, draft, input.selectedRunContext) },
  ];

  for (let turn = 1; turn <= AI_MAX_TURNS; turn += 1) {
    const hash = documentHash(draft);
    send("status", { message: `Agent turn ${turn}` });
    console.log(`${input.log.requestId} ${input.log.path} ai_patch_turn_start turn=${turn} hash=${hash} document_chars=${draft.length}`);
    const content = await aiPatchCommandText(messages, input.log, turn, send, record, hash);
    let command: PatchAgentCommand;
    try {
      command = parsePatchCommand(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool command.";
      console.error(`${input.log.requestId} ${input.log.path} ai_patch_command_invalid turn=${turn} error=${message} content=${truncate(content.replace(/\s+/g, " "), 800)}`);
      record?.({ eventType: "command_parse_failed", status: "error", message, args: { turn, content }, documentHash: hash });
      send("tool", { message: "Invalid tool command. Asking AI to correct it.", error: message, hash });
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: [
          "Your previous response was invalid.",
          message,
          "Return exactly one JSON object with shape {\"tool\":\"tool_name\",\"args\":{...}}.",
          `Current documentHash: ${hash}`,
        ].join("\n"),
      });
      continue;
    }
    const toolStartedAt = Date.now();
    const summarizedArgs = summarizeToolArgs(command.args ?? {});
    record?.({ eventType: "tool_start", toolName: command.tool, status: "started", message: toolActivityLabel(command), args: { turn, ...summarizedArgs }, documentHash: hash });
    send("tool", { message: toolActivityLabel(command), name: command.tool, args: summarizedArgs });
    console.log(`${input.log.requestId} ${input.log.path} ai_patch_tool turn=${turn} tool=${command.tool} args=${truncate(JSON.stringify(command.args ?? {}), 800)}`);

    let result: PatchAgentResult;
    try {
      if (command.tool === "finish_revision" && !changed) throw new Error("No edits have been applied yet. Use a patch tool before finishing.");
      result = executePatchCommand(command, draft);
      if (typeof result.document === "string") {
        draft = normalizeDocument(result.document);
        changed = true;
        const nextHash = documentHash(draft);
        if (isCompleteHtmlDocument(draft)) send("document", { content: draft, hash: nextHash });
        record?.({ eventType: "tool_result", toolName: command.tool, status: "success", message: result.message, args: summarizedArgs, result: summarizeToolResult(result), documentHash: nextHash, durationMs: Date.now() - toolStartedAt });
        send("tool", { message: `${command.tool} applied`, name: command.tool, result: result.message, hash: nextHash });
      } else {
        record?.({ eventType: "tool_result", toolName: command.tool, status: "success", message: result.message, args: summarizedArgs, result: summarizeToolResult(result), documentHash: hash, durationMs: Date.now() - toolStartedAt });
        send("tool", { message: result.message, name: command.tool, result: result.message, hash });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool failed.";
      result = { message: `ERROR: ${message}` };
      console.error(`${input.log.requestId} ${input.log.path} ai_patch_tool_failed turn=${turn} tool=${command.tool} error=${message}`);
      record?.({ eventType: "tool_error", toolName: command.tool, status: "error", message, args: summarizedArgs, result: { error: message }, documentHash: hash, durationMs: Date.now() - toolStartedAt });
      send("tool", { message: `${command.tool} failed: ${message}`, name: command.tool, error: message, hash });
    }

    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: patchToolResultMessage(command, result, draft) });

    if (command.tool === "finish_revision" && !result.message.startsWith("ERROR:")) {
      const finalDocument = assertAllowedLinks(normalizeDocument(draft), { allowedLinks: input.links, existingDocument: input.currentDocument });
      if (!changed) console.log(`${input.log.requestId} ${input.log.path} ai_patch_finished_without_changes hash=${documentHash(finalDocument)}`);
      const verificationStartedAt = Date.now();
      send("tool", { message: "Checking requested change", name: "verify_revision", args: { summary: stringValue(command.args?.summary) || result.message } });
      record?.({ eventType: "tool_start", toolName: "verify_revision", status: "started", message: "Checking requested change", args: { turn, summary: stringValue(command.args?.summary) || result.message }, documentHash: documentHash(finalDocument) });
      const verification = await verifyPatchRevision({ log: input.log, prompt: input.prompt, document: finalDocument, summary: stringValue(command.args?.summary) || result.message, send, record });
      const verificationStatus = verification.satisfied ? "success" : "error";
      const verificationMessage = verification.satisfied ? `Satisfied: ${verification.reason}` : `Needs fix: ${verification.reason}`;
      record?.({ eventType: "tool_result", toolName: "verify_revision", status: verificationStatus, message: verificationMessage, args: { turn }, result: verification, documentHash: documentHash(finalDocument), durationMs: Date.now() - verificationStartedAt });
      send("tool", { message: verificationMessage, name: "verify_revision", result: verification, hash: documentHash(finalDocument) });
      if (verification.satisfied) return finalDocument;
      messages.push({ role: "user", content: patchVerificationFailureMessage(verification, finalDocument) });
      continue;
    }
  }

  if (changed && isCompleteHtmlDocument(draft)) {
    const finalDocument = assertAllowedLinks(normalizeDocument(draft), { allowedLinks: input.links, existingDocument: input.currentDocument });
    console.log(`${input.log.requestId} ${input.log.path} ai_patch_turn_limit_saved hash=${documentHash(finalDocument)} document_chars=${finalDocument.length}`);
    send("status", { message: "Reached edit limit — saving latest draft (unverified)." });
    send("tool", { message: "Saving latest draft without verifier confirmation", name: "verify_revision", hash: documentHash(finalDocument) });
    record?.({ eventType: "turn_limit_reached", status: "warning", message: "Reached edit limit; saving latest draft without verifier confirmation", documentHash: documentHash(finalDocument), result: { turnLimited: true } });
    return finalDocument;
  }
  throw new Error("AI patch agent did not finish within the tool limit.");
}

function patchAgentSystem() {
  return [
    "You are a precise website editing agent for LinkQT.",
    "You edit one existing self-contained HTML document by requesting server tools.",
    "Return exactly one JSON object per turn. No markdown, no prose, no code fences.",
    "JSON shape: {\"tool\":\"tool_name\",\"args\":{...}}.",
    "JSON string values must be valid JSON: escape newlines as \\n and quotes as \\\".",
    "Available tools:",
    "- read_document: args {startLine?: number, endLine?: number}. Read numbered lines.",
    "- search_document: args {query: string, mode?: \"text\"|\"regex\"}. Find relevant snippets.",
    "- replace_text: args {documentHash: string, oldText: string, newText: string, expectedOccurrences?: number}. Exact replacement of the given number of occurrences.",
    "- replace_all: args {documentHash: string, oldText: string, newText: string}. Replace every occurrence of oldText.",
    "- replace_range: args {documentHash: string, startLine: number, endLine: number, newText: string}. Replace full numbered lines.",
    "- insert_after_line: args {documentHash: string, line: number, newText: string}. Insert new lines after the given line number (use 0 to prepend).",
    "- finish_revision: args {summary?: string}. Use only after the draft fully satisfies the user.",
    "Prefer read/search first if you are unsure.",
    "Use replace_text, replace_all, replace_range, or insert_after_line edits only. Do not regenerate or replace the full document.",
    "To add new content, prefer insert_after_line instead of repeating an existing anchor inside replace_text.",
    "If a large layout change is needed, apply it as one or more replace_range/replace_text patches.",
    "For visual/background/layout/CSS/JS requests, read the changed area after editing before finishing.",
    "Do not call finish_revision just because an edit succeeded. Finish only when the final rendered page should visibly satisfy the user's request.",
    "If verifier feedback says the revision is not satisfied, use its line numbers and suggestions to patch the existing draft; do not restart the task.",
    "Preserve existing design, content, URLs, CSS, and JS unless the user asks to change them.",
    linkSystemRules(),
    "Never invent URLs. Use only ALLOWED_LINKS or URLs already present in the current document.",
    "After each tool result, continue with the next JSON command until done, then call finish_revision.",
  ].join("\n");
}

function patchAgentInitialUserPrompt(prompt: string, links: BuilderLink[], document: string, selectedRunContext?: SelectedRunAiContext) {
  return [
    allowedLinksBlock(links),
    selectedRunContextBlock(selectedRunContext),
    "CURRENT_DOCUMENT_SNAPSHOT_START",
    `documentHash: ${documentHash(document)}`,
    numberedDocument(document),
    "CURRENT_DOCUMENT_SNAPSHOT_END",
    "CHANGE_REQUEST_START",
    prompt,
    "CHANGE_REQUEST_END",
  ].join("\n");
}

function selectedRunContextBlock(context?: SelectedRunAiContext) {
  const lines = [
    "SELECTED_BASE_VERSION_CONTEXT_START",
    "This describes the selected base version being revised. Use it as context only; the current document snapshot below is authoritative.",
  ];
  if (!context) {
    lines.push("No selected base version context was available.");
  } else {
    lines.push(`status: ${context.status}`);
    if (context.title) lines.push(`title: ${truncate(context.title.replace(/\s+/g, " "), 160)}`);
    if (context.prompt) {
      lines.push("previous_user_prompt:");
      lines.push(truncate(context.prompt.replace(/\s+/g, " "), 1200));
    } else {
      lines.push("previous_user_prompt: none");
    }
    if (context.events.length === 0) {
      lines.push("previous_tool_trace: none");
    } else {
      lines.push(`previous_tool_trace_count: ${context.events.length}`);
      lines.push("previous_tool_trace:");
      for (const event of compactToolTraceEvents(context.events)) lines.push(event);
    }
  }
  lines.push("SELECTED_BASE_VERSION_CONTEXT_END");
  return truncateContextBlock(lines, 8_000);
}

function compactToolTraceEvents(events: BuilderRunToolEvent[]) {
  const important = events.filter((event) => event.status === "error" || event.event_type === "command_parse_failed" || event.event_type === "run_failed" || event.tool_name === "replace_text" || event.tool_name === "replace_range" || event.tool_name === "read_document" || event.tool_name === "search_document" || event.tool_name === "verify_revision" || event.tool_name === "finish_revision" || event.event_type === "run_completed");
  const selected = important.length > 0 ? important : events;
  return selected.slice(-40).map((event) => {
    const tool = event.tool_name ? ` tool=${event.tool_name}` : "";
    const hash = event.document_hash ? ` hash=${event.document_hash}` : "";
    const args = compactTraceJson(event.args_json);
    const result = compactTraceJson(event.result_json);
    return [
      `#${event.sequence} event=${event.event_type}${tool} status=${event.status}${hash}`,
      `message=${truncate(event.message.replace(/\s+/g, " "), 260)}`,
      args ? `args=${args}` : "",
      result ? `result=${result}` : "",
    ].filter(Boolean).join(" | ");
  });
}

function compactTraceJson(value: string) {
  const parsed = safeJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const input = parsed as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["turn", "query", "mode", "startLine", "endLine", "line", "expectedOccurrences", "documentChars", "changed", "error", "summary", "runId"]) {
    if (input[key] !== undefined) output[key] = input[key];
  }
  for (const key of ["oldText", "newText", "preview", "message"]) {
    if (typeof input[key] === "string") output[key] = truncate(input[key].replace(/\s+/g, " "), 240);
  }
  const text = JSON.stringify(output);
  return text === "{}" ? "" : text;
}

function truncateContextBlock(lines: string[], maxChars: number) {
  const output: string[] = [];
  let size = 0;
  for (const line of lines) {
    const nextSize = size + line.length + 1;
    if (nextSize > maxChars) {
      output.push("...selected base version context truncated...");
      break;
    }
    output.push(line);
    size = nextSize;
  }
  if (output[output.length - 1] !== "SELECTED_BASE_VERSION_CONTEXT_END") output.push("SELECTED_BASE_VERSION_CONTEXT_END");
  return output.join("\n");
}

async function verifyPatchRevision(input: { log: BuilderAiLogContext; prompt: string; document: string; summary: string; send?: StreamSender; record?: ToolTraceRecorder }): Promise<PatchVerification> {
  const text = await fetchAiChatCompletionText({
    phase: "verify",
    log: input.log,
    send: input.send,
    record: input.record,
    documentHash: documentHash(input.document),
    timeoutMs: AI_TIMEOUT_MS,
    body: {
      model: AI_MODEL,
      stream: false,
      messages: [
        { role: "system", content: patchVerificationSystem() },
        { role: "user", content: patchVerificationUserPrompt(input.prompt, input.document, input.summary) },
      ],
    },
  });
  return parsePatchVerification(extractAssistantText(text));
}

function patchVerificationSystem() {
  return [
    "You are a strict final reviewer for a LinkQT HTML patch agent.",
    "Decide whether the final complete HTML document satisfies the user's change request.",
    "Return exactly one JSON object. No markdown, no prose, no code fences.",
    "JSON shape: {\"satisfied\":boolean,\"reason\":\"short explanation\",\"suggestions\":[{\"lineStart\":number,\"lineEnd\":number,\"issue\":\"what is wrong\",\"suggestion\":\"specific fix\"}]}",
    "If satisfied is false, suggestions must identify exact line ranges in the numbered document and concrete fixes so the patch agent can continue without rereading everything.",
    "For visual/background/layout/CSS/JS requests, inspect whether selectors, pseudo-elements, z-index/layering, opacity, animation, and DOM structure can actually render the requested effect.",
    "Do not require pixel perfection, but reject superficial edits that do not plausibly fulfill the user request.",
  ].join(" ");
}

function patchVerificationUserPrompt(prompt: string, document: string, summary: string) {
  return [
    "CHANGE_REQUEST_START",
    prompt,
    "CHANGE_REQUEST_END",
    "",
    "AGENT_SUMMARY_START",
    summary,
    "AGENT_SUMMARY_END",
    "",
    "FINAL_DOCUMENT_NUMBERED_START",
    `documentHash: ${documentHash(document)}`,
    numberedDocument(document),
    "FINAL_DOCUMENT_NUMBERED_END",
  ].join("\n");
}

function parsePatchVerification(content: string): PatchVerification {
  const stripped = stripCodeFence(content);
  const parsed = safeJson(stripped) ?? safeJson(extractFirstJsonObject(stripped)) ?? safeJson(escapeJsonStringNewlines(extractFirstJsonObject(stripped)));
  if (!parsed || typeof parsed !== "object") throw new Error(`AI verifier did not return valid JSON: ${truncate(content.replace(/\s+/g, " "), 300)}`);
  const record = parsed as { satisfied?: unknown; reason?: unknown; suggestions?: unknown };
  const suggestions = Array.isArray(record.suggestions) ? record.suggestions.map(normalizeVerificationSuggestion).filter((item): item is PatchVerification["suggestions"][number] => Boolean(item)) : [];
  if (record.satisfied === false && suggestions.length === 0) throw new Error("AI verifier rejected the draft without line-numbered suggestions.");
  return {
    satisfied: record.satisfied === true,
    reason: typeof record.reason === "string" && record.reason.trim() ? truncate(record.reason.trim(), 500) : record.satisfied === true ? "The final document satisfies the request." : "The final document does not satisfy the request.",
    suggestions,
  };
}

function normalizeVerificationSuggestion(value: unknown): PatchVerification["suggestions"][number] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { lineStart?: unknown; lineEnd?: unknown; issue?: unknown; suggestion?: unknown };
  const lineStart = typeof record.lineStart === "number" && Number.isInteger(record.lineStart) ? record.lineStart : Number(record.lineStart);
  const lineEnd = typeof record.lineEnd === "number" && Number.isInteger(record.lineEnd) ? record.lineEnd : Number(record.lineEnd);
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) return null;
  const issue = typeof record.issue === "string" && record.issue.trim() ? truncate(record.issue.trim(), 500) : "Verifier reported an issue.";
  const suggestion = typeof record.suggestion === "string" && record.suggestion.trim() ? truncate(record.suggestion.trim(), 800) : "Patch this range to satisfy the request.";
  return { lineStart, lineEnd, issue, suggestion };
}

function patchVerificationFailureMessage(verification: PatchVerification, document: string) {
  return [
    "VERIFY_REVISION_RESULT_START",
    "satisfied: false",
    `reason: ${verification.reason}`,
    `documentHash: ${documentHash(document)}`,
    "suggestions:",
    ...verification.suggestions.map((item, index) => [
      `${index + 1}. lines ${item.lineStart}-${item.lineEnd}`,
      `issue: ${item.issue}`,
      `suggestion: ${item.suggestion}`,
      "current_lines:",
      numberedDocument(document, item.lineStart, item.lineEnd),
    ].join("\n")),
    "Use these line-numbered suggestions to patch the current draft. Continue with exactly one JSON tool command.",
    "VERIFY_REVISION_RESULT_END",
  ].join("\n");
}

async function aiPatchCommandText(messages: AiChatMessage[], log: BuilderAiLogContext, turn: number, send: StreamSender, record: ToolTraceRecorder | undefined, currentHash: string) {
  const text = await fetchAiChatCompletionText({
    phase: "patch",
    log,
    turn,
    send,
    record,
    documentHash: currentHash,
    timeoutMs: AI_TIMEOUT_MS,
    body: {
      model: AI_MODEL,
      stream: false,
      messages,
    },
  });
  return extractAssistantText(text);
}

function parsePatchCommand(content: string): PatchAgentCommand {
  const stripped = stripCodeFence(content);
  const firstJsonText = extractFirstJsonObject(stripped);
  const jsonText = extractJsonObject(stripped) || stripped;
  const parsed = safeJson(stripped) ?? safeJson(firstJsonText) ?? safeJson(escapeJsonStringNewlines(firstJsonText)) ?? safeJson(jsonText) ?? safeJson(escapeJsonStringNewlines(jsonText));
  if (!parsed || typeof parsed !== "object") throw new Error(`AI did not return a valid tool command: ${truncate(content.replace(/\s+/g, " "), 300)}`);
  const record = parsed as { tool?: unknown; args?: unknown };
  if (typeof record.tool !== "string" || !record.tool.trim()) throw new Error("AI tool command is missing tool.");
  return {
    tool: record.tool.trim(),
    args: record.args && typeof record.args === "object" && !Array.isArray(record.args) ? record.args as Record<string, unknown> : {},
  };
}

function extractJsonObject(value: string) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : "";
}

function extractFirstJsonObject(value: string) {
  const start = value.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return "";
}

function escapeJsonStringNewlines(value: string) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      result += char;
      continue;
    }
    if (inString && char === "\n") {
      result += "\\n";
      continue;
    }
    if (inString && char === "\r") {
      result += "\\r";
      continue;
    }
    result += char;
  }
  return result;
}

function executePatchCommand(command: PatchAgentCommand, document: string): PatchAgentResult {
  const args = command.args ?? {};
  if (command.tool === "read_document") {
    const range = lineRange(args, document);
    return { message: numberedDocument(document, range.startLine, range.endLine) };
  }
  if (command.tool === "search_document") {
    return { message: searchDocument(document, stringArg(args.query, "query"), stringValue(args.mode) === "regex" ? "regex" : "text") };
  }
  if (command.tool === "replace_text") {
    assertDocumentHash(document, stringArg(args.documentHash, "documentHash"));
    const oldText = stringArg(args.oldText, "oldText");
    const newText = typeof args.newText === "string" ? args.newText : "";
    const expectedOccurrences = numberArg(args.expectedOccurrences, "expectedOccurrences", 1);
    const count = countOccurrences(document, oldText);
    if (count !== expectedOccurrences) throw new Error(`replace_text expected ${expectedOccurrences} occurrence(s), found ${count}.`);
    return { message: `Replaced ${count} occurrence(s).`, document: document.split(oldText).join(newText), changed: true };
  }
  if (command.tool === "replace_all") {
    assertDocumentHash(document, stringArg(args.documentHash, "documentHash"));
    const oldText = stringArg(args.oldText, "oldText");
    const newText = typeof args.newText === "string" ? args.newText : "";
    const count = countOccurrences(document, oldText);
    if (count === 0) throw new Error("replace_all found no occurrences of oldText.");
    return { message: `Replaced all ${count} occurrence(s).`, document: document.split(oldText).join(newText), changed: true };
  }
  if (command.tool === "replace_range") {
    assertDocumentHash(document, stringArg(args.documentHash, "documentHash"));
    const lines = splitLines(document);
    const startLine = numberArg(args.startLine, "startLine");
    const endLine = numberArg(args.endLine, "endLine");
    if (startLine < 1 || endLine < startLine || endLine > lines.length) throw new Error(`Invalid line range ${startLine}-${endLine}.`);
    const newText = typeof args.newText === "string" ? args.newText : "";
    const replacement = splitLines(newText);
    const nextLines = [...lines.slice(0, startLine - 1), ...replacement, ...lines.slice(endLine)];
    return { message: `Replaced lines ${startLine}-${endLine}.`, document: nextLines.join("\n"), changed: true };
  }
  if (command.tool === "insert_after_line") {
    assertDocumentHash(document, stringArg(args.documentHash, "documentHash"));
    const lines = splitLines(document);
    const line = numberArg(args.line, "line");
    if (line < 0 || line > lines.length) throw new Error(`Invalid insert line ${line}. Use 0 to prepend or up to ${lines.length} to append.`);
    const newText = typeof args.newText === "string" ? args.newText : "";
    const insertion = splitLines(newText);
    const nextLines = [...lines.slice(0, line), ...insertion, ...lines.slice(line)];
    return { message: `Inserted ${insertion.length} line(s) after line ${line}.`, document: nextLines.join("\n"), changed: true };
  }
  if (command.tool === "replace_document") throw new Error("replace_document is not available for revisions. Use replace_text, replace_all, replace_range, or insert_after_line patches.");
  if (command.tool === "finish_revision") {
    if (!isCompleteHtmlDocument(document)) throw new Error("Draft is not a complete HTML document.");
    return { message: stringValue(args.summary) || "Revision finished." };
  }
  throw new Error(`Unknown tool: ${command.tool}`);
}

function patchToolResultMessage(command: PatchAgentCommand, result: PatchAgentResult, document: string) {
  return [
    "TOOL_RESULT_START",
    `tool: ${command.tool}`,
    `documentHash: ${documentHash(document)}`,
    result.message,
    result.document ? documentContextAfterEdit(document) : "",
    "TOOL_RESULT_END",
  ].filter(Boolean).join("\n");
}

function documentContextAfterEdit(document: string) {
  const lines = splitLines(document);
  if (lines.length <= 120) return numberedDocument(document);
  const tailStart = lines.length - 39;
  return [
    "DOCUMENT_CONTEXT_START",
    "The edit was applied. Use read_document or search_document if you need more context.",
    numberedLines(lines.slice(0, 40), 1),
    "...",
    numberedLines(lines.slice(-40), tailStart),
    "DOCUMENT_CONTEXT_END",
  ].join("\n");
}

function numberedDocument(document: string, startLine = 1, endLine?: number) {
  const lines = splitLines(document);
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine ?? lines.length);
  return numberedLines(lines.slice(from - 1, to), from);
}

function numberedLines(lines: string[], startLine: number) {
  return lines.map((line, index) => `${String(startLine + index).padStart(4, " ")}| ${line}`).join("\n");
}

function lineRange(args: Record<string, unknown>, document: string) {
  const lines = splitLines(document);
  const startLine = numberArg(args.startLine, "startLine", 1);
  const endLine = numberArg(args.endLine, "endLine", Math.min(lines.length, startLine + 119));
  if (startLine < 1 || endLine < startLine || startLine > lines.length) throw new Error(`Invalid line range ${startLine}-${endLine}.`);
  return { startLine, endLine: Math.min(endLine, lines.length) };
}

function searchDocument(document: string, query: string, mode: "text" | "regex") {
  const lines = splitLines(document);
  const matches: string[] = [];
  let regex: RegExp | null = null;
  if (mode === "regex") {
    try {
      regex = new RegExp(query, "i");
    } catch {
      throw new Error(`Invalid regex query: ${query}`);
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matched = regex ? regex.test(line) : line.toLowerCase().includes(query.toLowerCase());
    if (!matched) continue;
    const from = Math.max(1, index);
    const to = Math.min(lines.length, index + 2);
    matches.push(numberedDocument(document, from, to));
    if (matches.length >= 8) break;
  }
  return matches.length > 0 ? matches.join("\n---\n") : `No matches for ${mode} query: ${query}`;
}

function assertDocumentHash(document: string, expected: string) {
  const actual = documentHash(document);
  if (expected !== actual) throw new Error(`Stale documentHash. Expected current hash ${actual}.`);
}

function documentHash(document: string) {
  let hash = 2166136261;
  for (let index = 0; index < document.length; index += 1) {
    hash ^= document.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `d${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function splitLines(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function countOccurrences(value: string, needle: string) {
  if (!needle) throw new Error("oldText cannot be empty.");
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function stringArg(value: unknown, name: string) {
  if (typeof value !== "string" || !value.length) throw new Error(`${name} is required.`);
  return value;
}

function numberArg(value: unknown, name: string, fallback?: number) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required.`);
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`);
  return number;
}

function toolActivityLabel(command: PatchAgentCommand) {
  if (command.tool === "read_document") return "Reading document";
  if (command.tool === "search_document") return `Searching for ${truncate(stringValue(command.args?.query) || "text", 80)}`;
  if (command.tool === "replace_text") return "Applying exact text patch";
  if (command.tool === "replace_all") return "Applying global text patch";
  if (command.tool === "replace_range") return "Applying line patch";
  if (command.tool === "insert_after_line") return "Inserting new lines";
  if (command.tool === "replace_document") return "Rejected full document replacement";
  if (command.tool === "finish_revision") return "Finishing revision";
  return `Calling ${command.tool}`;
}

function summarizeToolArgs(args: Record<string, unknown>) {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "document" && typeof value === "string") summary[key] = { documentChars: value.length, preview: truncate(value.replace(/\s+/g, " "), 160), truncated: true };
    else if (typeof value === "string") summary[key] = truncate(value.replace(/\s+/g, " "), key === "oldText" || key === "newText" ? 220 : 240);
    else summary[key] = value;
  }
  return summary;
}

function summarizeToolResult(result: PatchAgentResult) {
  return {
    message: result.message,
    changed: Boolean(result.changed || result.document),
    documentChars: result.document?.length,
  };
}

function safeStringifyTrace(value: unknown) {
  return JSON.stringify(redactTraceValue(value));
}

function redactTraceValue(value: unknown): unknown {
  if (typeof value === "string") return truncate(value.replace(/\s+/g, " "), 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map(redactTraceValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "document" && typeof nested === "string") {
      result[key] = { documentChars: nested.length, preview: truncate(nested.replace(/\s+/g, " "), 240), truncated: true };
    } else {
      result[key] = redactTraceValue(nested);
    }
  }
  return result;
}

function normalizeJsonText(value: string) {
  return safeStringifyTrace(safeJson(value) ?? {});
}

function streamAiDocument(request: Request, input: { log: BuilderAiLogContext; system: string; user: string; trace?: { userId: string; projectId: string }; traceMode?: string; sourceDocument?: string; beforeWork?: (send: (event: string, data: unknown) => void) => Promise<StreamWorkMeta>; save: (content: string, meta: StreamWorkMeta) => Promise<{ project: BuilderProject; run: BuilderRun }>; fail?: (meta: StreamWorkMeta | null, error: unknown) => void | Promise<void> }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let streamClosed = false;
      const send = (event: string, data: unknown) => {
        if (streamClosed) return false;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch (error) {
          streamClosed = true;
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`${input.log.requestId} ${input.log.path} ai_stream_sse_closed event=${event} error=${message}`);
          return false;
        }
      };
      const heartbeat = setInterval(() => {
        send("heartbeat", { at: new Date().toISOString() });
      }, SSE_HEARTBEAT_MS);

      let meta: StreamWorkMeta | null = null;
      let record: ToolTraceRecorder | null = null;
      try {
        console.log(`${input.log.requestId} ${input.log.path} ai_stream_start user=${input.log.userLabel} model=${AI_MODEL} source_run=${input.log.sourceRunId ?? "unknown"} project=${input.log.projectId ?? "unknown"} prompt="${input.log.promptPreview ?? ""}"`);
        send("status", { message: "Starting AI request" });
        meta = input.beforeWork ? await input.beforeWork(send) : { title: "AI revision" };
        if (meta.runId && input.trace) {
          let sequence = 0;
          record = (event) => {
            sequence += 1;
            void recordRunToolEvent({
              runId: meta?.runId ?? "",
              projectId: input.trace?.projectId ?? "",
              userId: input.trace?.userId ?? "",
              sequence,
              ...event,
            });
          };
          record({ eventType: "agent_started", status: "started", message: "Document generator started", args: { prompt: input.log.promptPreview, mode: input.traceMode ?? "document_stream" }, documentHash: documentHash(input.sourceDocument ?? "") });
        }
        console.log(`${input.log.requestId} ${input.log.path} ai_stream_title title="${meta.title}"`);
        const generationStartedAt = Date.now();
        send("tool", { message: "Streaming full HTML document", name: "generate_document", args: { mode: input.traceMode ?? "document_stream" } });
        record?.({ eventType: "generation_started", toolName: "generate_document", status: "started", message: "Streaming full HTML document", args: { mode: input.traceMode ?? "document_stream" }, documentHash: documentHash(input.sourceDocument ?? "") });
        const content = await streamAssistantContent(input, send, record ?? undefined);
        console.log(`${input.log.requestId} ${input.log.path} ai_stream_document_received chars=${content.length}`);
        record?.({ eventType: "generation_completed", toolName: "generate_document", status: "success", message: "Generated full HTML document", result: { documentChars: content.length }, documentHash: documentHash(content), durationMs: Date.now() - generationStartedAt });
        send("tool", { message: "Generated full HTML document", name: "generate_document", result: "Generated full HTML document", hash: documentHash(content) });
        send("status", { message: "Parsing generated document" });
        record?.({ eventType: "validation_started", status: "started", message: "Validating generated document", documentHash: documentHash(content), result: { documentChars: content.length } });
        const result = await input.save(content, meta);
        console.log(`${input.log.requestId} ${input.log.path} ai_stream_saved project=${result.project.id} run=${result.run.id} document_chars=${result.run.document.length}`);
        record?.({ eventType: "run_completed", status: "success", message: "AI document generation saved", documentHash: documentHash(result.run.document), result: { runId: result.run.id, documentChars: result.run.document.length } });
        send("document", { content: result.run.document });
        send("status", { message: "Saved run" });
        send("result", result);
        send("status", { message: "Done" });
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown streaming error";
        console.error(`${input.log.requestId} ${input.log.path} ai_stream_failed user=${input.log.userLabel} source_run=${input.log.sourceRunId ?? "unknown"} project=${input.log.projectId ?? "unknown"} error=${message}`);
        if (error instanceof Error && error.stack) console.error(`${input.log.requestId} ${input.log.path} ai_stream_stack ${error.stack}`);
        record?.({ eventType: "run_failed", status: "error", message, result: { error: message } });
        try {
          await input.fail?.(meta, error);
        } catch (failError) {
          const failMessage = failError instanceof Error ? failError.message : String(failError);
          console.error(`${input.log.requestId} ${input.log.path} ai_stream_fail_marker_error ${failMessage}`);
        }
        send("error", { message: message.includes("timed out") ? "AI request timed out. Please try again." : "AI request failed. Please try again." });
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }
      } finally {
        clearInterval(heartbeat);
      }
    },
    cancel() {
      // Browser disconnects should stop delivery, not the persisted AI work.
    },
  });

  return withCors(request, new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    },
  }));
}

async function streamAssistantContent(input: { log: BuilderAiLogContext; system: string; user: string }, send: StreamSender, record?: ToolTraceRecorder) {
  const messages: AiChatMessage[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];
  let lastInvalid: { message: string; output?: AiAttemptOutput } | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      send("status", { message: attempt === 1 ? "Generating page" : "Retrying" });
      const output = await withAiRetries({
        phase: "stream",
        log: input.log,
        send,
        record,
        onRetry() {
          send("reset", { message: "Retrying" });
        },
      }, (requestAttempt) => streamAssistantAttempt(input, send, messages, attempt, requestAttempt));
      return output.document;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown AI stream error";
      if (!isRepairableDocumentError(message) || attempt === 2) throw error;
      const output = error instanceof AiDocumentParseError ? error.output : undefined;
      lastInvalid = { message, output };
      console.error(`${input.log.requestId} ${input.log.path} upstream_ai_invalid_document attempt=${attempt} error=${message} content=${truncate(output?.content.replace(/\s+/g, " ").trim() || "", 500)} tool_args=${truncate(toolArgumentsPreview(output?.toolCalls), 500)}`);
      send("reset", { message: "Discarding invalid streamed output" });
      messages.push({
        role: "assistant",
        content: invalidAssistantSummary(lastInvalid),
      });
      messages.push({
        role: "user",
        content: [
          `Your previous response was invalid because: ${message}`,
          "Return one complete self-contained HTML document as plain text.",
          "Do not use markdown fences, JSON, explanations, diffs, or partial code.",
          "Start with <!doctype html> and include the full <html> document.",
        ].join("\n"),
      });
    }
  }

  throw new Error("AI response did not include a valid document field.");
}

async function streamAssistantAttempt(input: { log: BuilderAiLogContext; system: string; user: string }, send: StreamSender, messages: AiChatMessage[], attempt: number, requestAttempt: number): Promise<AiAttemptOutput> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const resetTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  };
  resetTimeout();

  try {
    const url = aiChatCompletionsUrl();
    console.log(`${input.log.requestId} ${input.log.path} upstream_ai_request_start attempt=${attempt} request_attempt=${requestAttempt} url=${url} model=${AI_MODEL} stream=true tools=none timeout_ms=${AI_TIMEOUT_MS}`);
    const response = await fetch(url, {
      method: "POST",
      headers: aiRequestHeaders(),
      signal: controller.signal,
      body: JSON.stringify(stableAiRequestBody({
        model: AI_MODEL,
        stream: true,
        messages,
      })),
    });

    const contentType = response.headers.get("Content-Type") ?? "unknown";
    console.log(`${input.log.requestId} ${input.log.path} upstream_ai_response_status attempt=${attempt} request_attempt=${requestAttempt} status=${response.status} content_type=${contentType} duration=${Date.now() - startedAt}ms`);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`${input.log.requestId} ${input.log.path} upstream_ai_error attempt=${attempt} request_attempt=${requestAttempt} status=${response.status} content_type=${contentType} duration=${Date.now() - startedAt}ms body=${truncate(text.replace(/\s+/g, " ").trim(), 1000)}`);
      throw aiHttpFailure(response.status, text);
    }
    if (!response.body) throw new Error("AI stream returned an empty response body.");

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let receivingContent = false;
    let receivingTool = false;
    const toolCalls = new Map<number, AiToolCall>();

    for await (const chunk of response.body) {
      resetTimeout();
      buffer += decoder.decode(chunk, { stream: true });
      const parsedFrames = drainSseFrames(buffer);
      buffer = parsedFrames.buffer;
      for (const frame of parsedFrames.frames) {
        const parsed = parseUpstreamSseFrame(frame);
        if (parsed.done) return resolveAttemptOutput(input.log, attempt, content, toolCalls, "done");
        assertAllowedFinishReasons(parsed.finishReasons);
        if (parsed.toolCalls.length > 0) {
          mergeToolCallDeltas(toolCalls, parsed.toolCalls);
          if (!receivingTool) {
            console.log(`${input.log.requestId} ${input.log.path} upstream_ai_tool_call_started attempt=${attempt} tool=unexpected`);
            send("tool", { message: "Receiving unexpected tool call" });
            send("status", { message: "Receiving tool arguments" });
            receivingTool = true;
          }
        }
        if (parsed.content) {
          if (!receivingContent) {
            send("status", { message: "Receiving HTML" });
            receivingContent = true;
          }
          content += parsed.content;
          send("token", { content: parsed.content });
        }
      }
    }

    buffer += decoder.decode();
    const parsed = parseUpstreamSseFrame(normalizeSseFrame(buffer));
    assertAllowedFinishReasons(parsed.finishReasons);
    if (parsed.toolCalls.length > 0) {
      mergeToolCallDeltas(toolCalls, parsed.toolCalls);
      if (!receivingTool) {
        console.log(`${input.log.requestId} ${input.log.path} upstream_ai_tool_call_started attempt=${attempt} tool=unexpected`);
        send("tool", { message: "Receiving unexpected tool call" });
      }
    }
    if (parsed.content) {
      content += parsed.content;
      send("token", { content: parsed.content });
    }
    return resolveAttemptOutput(input.log, attempt, content, toolCalls, "closed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown AI stream error";
    const failure = normalizeAiRequestFailure(error);
    console.error(`${input.log.requestId} ${input.log.path} upstream_ai_stream_error attempt=${attempt} request_attempt=${requestAttempt} duration=${Date.now() - startedAt}ms error=${message}`);
    if (!failure.transient && !(error instanceof AiRequestFailure)) throw error;
    throw failure;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function drainSseFrames(buffer: string) {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frames: string[] = [];
  let remainder = normalized;
  let boundary = remainder.indexOf("\n\n");
  while (boundary !== -1) {
    frames.push(remainder.slice(0, boundary));
    remainder = remainder.slice(boundary + 2);
    boundary = remainder.indexOf("\n\n");
  }
  return { frames, buffer: remainder };
}

function normalizeSseFrame(frame: string) {
  return frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseUpstreamSseFrame(frame: string) {
  const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
  if (!data) return { done: false, content: "", toolCalls: [] as AiToolCall[], finishReasons: [] as string[] };
  if (data === "[DONE]") return { done: true, content: "", toolCalls: [] as AiToolCall[], finishReasons: [] as string[] };

  const payload = safeJson(data) as {
    error?: { message?: unknown };
    choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
  } | null;
  const errorMessage = payload?.error?.message;
  if (typeof errorMessage === "string" && errorMessage.trim()) throw new Error(errorMessage);
  const content = payload?.choices?.map((choice) => choice.delta?.content).filter((value): value is string => typeof value === "string").join("") ?? "";
  const toolCalls = payload?.choices?.flatMap((choice) => normalizeToolCallDeltas(choice.delta?.tool_calls)) ?? [];
  const finishReasons = payload?.choices?.map((choice) => choice.finish_reason).filter((value): value is string => typeof value === "string" && value.length > 0) ?? [];
  return { done: false, content, toolCalls, finishReasons };
}

function assertAllowedFinishReasons(finishReasons: string[]) {
  const disallowed = finishReasons.filter((reason) => reason !== "stop" && reason !== "tool_calls" && reason !== "function_call");
  if (disallowed.length > 0) throw new Error(`AI response ended before a complete document was available: ${disallowed.join(", ")}`);
}

class AiDocumentParseError extends Error {
  output: AiAttemptOutput;

  constructor(message: string, output: AiAttemptOutput) {
    super(message);
    this.name = "AiDocumentParseError";
    this.output = output;
  }
}

function resolveAttemptOutput(log: BuilderAiLogContext, attempt: number, content: string, toolCalls: Map<number, AiToolCall>, endReason: "done" | "closed"): AiAttemptOutput {
  console.log(`${log.requestId} ${log.path} upstream_ai_${endReason} attempt=${attempt} content_chars=${content.length} tool_calls=${toolCalls.size} tool_arg_chars=${toolArgumentLength(toolCalls)}`);
  const output = { content, toolCalls, document: "" };
  try {
    output.document = resolveAssistantDocument(content, toolCalls);
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI response did not include a valid document field.";
    throw new AiDocumentParseError(message, output);
  }
}

function isRepairableDocumentError(message: string) {
  return message.includes("valid document") || message.includes("replace_document") || message.includes("Document is required") || message.includes("did not include") || message.includes("complete document");
}

function invalidAssistantSummary(input: { message: string; output?: AiAttemptOutput }) {
  return [
    "INVALID_PREVIOUS_RESPONSE_START",
    `ERROR: ${input.message}`,
    "CONTENT:",
    truncate(input.output?.content ?? "", 2000),
    "TOOL_ARGUMENTS:",
    truncate(toolArgumentsPreview(input.output?.toolCalls), 2000),
    "INVALID_PREVIOUS_RESPONSE_END",
  ].join("\n");
}

function toolArgumentsPreview(toolCalls?: Map<number, AiToolCall>) {
  if (!toolCalls || toolCalls.size === 0) return "";
  return [...toolCalls.values()].map((call) => `${call.function?.name ?? "unknown"}: ${call.function?.arguments ?? ""}`).join("\n");
}

function extractAssistantDocument(responseText: string) {
  const payload = safeJson(responseText) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> } | null;
  const toolDocument = documentFromToolCalls(normalizeToolCallDeltas(payload?.choices?.[0]?.message?.tool_calls));
  if (toolDocument) return toolDocument;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("AI returned no document content.");
  return extractDocument(content);
}

function extractAssistantText(responseText: string) {
  const payload = safeJson(responseText) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("AI returned no text content.");
  return content;
}

function resolveAssistantDocument(content: string, toolCalls: Map<number, AiToolCall>) {
  const toolDocument = documentFromToolCalls([...toolCalls.values()]);
  if (toolDocument) return toolDocument;
  return extractDocument(content);
}

function normalizeToolCallDeltas(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = item as { index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
    return {
      index: typeof record.index === "number" ? record.index : 0,
      id: typeof record.id === "string" ? record.id : undefined,
      type: typeof record.type === "string" ? record.type : undefined,
      function: record.function ? {
        name: typeof record.function.name === "string" ? record.function.name : undefined,
        arguments: typeof record.function.arguments === "string" ? record.function.arguments : undefined,
      } : undefined,
    };
  });
}

function mergeToolCallDeltas(target: Map<number, AiToolCall>, deltas: Array<AiToolCall & { index?: number }>) {
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    const current = target.get(index) ?? {};
    target.set(index, {
      id: delta.id ?? current.id,
      type: delta.type ?? current.type,
      function: {
        name: delta.function?.name ?? current.function?.name,
        arguments: `${current.function?.arguments ?? ""}${delta.function?.arguments ?? ""}`,
      },
    });
  }
}

function toolArgumentLength(toolCalls: Map<number, AiToolCall>) {
  return [...toolCalls.values()].reduce((sum, call) => sum + (call.function?.arguments?.length ?? 0), 0);
}

function documentFromToolCalls(toolCalls: AiToolCall[]) {
  const replaceDocumentCall = toolCalls.find((call) => call.function?.name === "replace_document");
  if (!replaceDocumentCall) return "";
  const argsText = replaceDocumentCall.function?.arguments ?? "";
  const args = safeJson(argsText) as { document?: unknown } | null;
  if (typeof args?.document === "string" && args.document.trim()) return extractDocument(args.document);
  throw new Error("AI called replace_document without a valid document argument.");
}

function extractDocument(content: string) {
  const stripped = stripCodeFence(content);
  const parsed = safeJson(stripped) as { document?: unknown } | null;
  if (typeof parsed?.document === "string") return extractDocument(parsed.document);
  if (isCompleteHtmlDocument(stripped)) return stripped;
  throw new Error("AI response did not include a valid document field.");
}

function stripCodeFence(value: string) {
  return value.trim().replace(/^```(?:json|html)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function isCompleteHtmlDocument(value: string) {
  return /^(?:<!doctype html>\s*)?<html\b[\s\S]*<\/html>\s*$/i.test(value.trim());
}

function isBlankDocument(value: string) {
  return value.trim().length === 0;
}

function normalizeDocument(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Document is required.");
  const document = value.trim();
  if (document.length > MAX_DOCUMENT_CHARS) throw new Error("Document is too large for the dev MVP limit.");
  if (!/<html[\s>]/i.test(document)) return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${document}</body></html>`;
  return document;
}

function normalizeLinks(value: unknown) {
  if (!Array.isArray(value)) return [];
  const links: BuilderLink[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (links.length >= 20) break;
    if (!item || typeof item !== "object") continue;
    const record = item as { label?: unknown; url?: unknown };
    const label = stringValue(record.label).slice(0, 120);
    const rawUrl = stringValue(record.url);
    if (!rawUrl) continue;
    const url = normalizeHttpUrl(rawUrl);
    const key = comparableUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ label: label || hostnameLabel(url), url });
  }
  return links;
}

function normalizeHttpUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid link URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Link URL must start with http:// or https://: ${value}`);
  parsed.hash = parsed.hash;
  return parsed.toString();
}

function hostnameLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Link";
  }
}

function runWithLinks(run: BuilderRun): BuilderRun {
  const links = linksFromJson(run.links_json);
  return { ...run, is_seed: Boolean(run.is_seed), links, links_json: JSON.stringify(links) };
}

function linksFromJson(value: string) {
  const parsed = safeJson(value);
  return Array.isArray(parsed) ? normalizeLinks(parsed) : [];
}

function assertAllowedLinks(document: string, input: { allowedLinks: BuilderLink[]; existingDocument?: string }) {
  const allowed = new Set(input.allowedLinks.map((link) => comparableUrl(link.url)));
  if (input.existingDocument) {
    for (const url of externalDocumentUrls(input.existingDocument)) allowed.add(comparableUrl(url));
  }

  // Outbound navigation surface (clickable <a>, form actions, external <script src>) stays strict:
  // it must be an approved link or already present in the existing document. This is the anti-phishing
  // / anti-exfiltration / anti-supply-chain control.
  const navigational = navigationalDocumentUrls(document);
  const navigationalKeys = new Set(navigational.map((url) => comparableUrl(url)));
  const invented = navigational.filter((url) => !allowed.has(comparableUrl(url)));
  if (invented.length > 0) {
    throw new Error(`Unapproved outbound link${invented.length === 1 ? "" : "s"}: ${[...new Set(invented)].slice(0, 5).join(", ")}`);
  }

  // Everything else is a resource load (images, fonts, stylesheets, media). These may point anywhere
  // as long as they are https (matching the served-page CSP); pre-existing resources are grandfathered.
  const insecureResources = externalDocumentUrls(document)
    .filter((url) => !navigationalKeys.has(comparableUrl(url)))
    .filter((url) => !isHttpsResourceUrl(url) && !allowed.has(comparableUrl(url)));
  if (insecureResources.length > 0) {
    throw new Error(`Insecure external resource URL${insecureResources.length === 1 ? "" : "s"} (use https): ${[...new Set(insecureResources)].slice(0, 5).join(", ")}`);
  }
  return document;
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
      if (!value || isSafeLocalHref(value)) continue;
      if (/^(javascript|data|vbscript):/i.test(value)) {
        urls.add(value);
        continue;
      }
      try {
        const parsed = value.startsWith("//") ? new URL(`https:${value}`) : new URL(value);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") urls.add(parsed.toString());
        else urls.add(value);
      } catch {
        urls.add(value);
      }
    }
  }
  return [...urls];
}

function isHttpsResourceUrl(value: string) {
  try {
    const parsed = value.startsWith("//") ? new URL(`https:${value}`) : new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// XML namespace URIs (e.g. the SVG xmlns) are parser identifiers, never fetched over the
// network, so they are not outbound resources and are exempt from the https-resource check.
const XML_NAMESPACE_URIS = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1998/math/mathml",
  "http://www.w3.org/xml/1998/namespace",
  "http://www.w3.org/2000/xmlns",
]);

function isXmlNamespaceUrl(value: string) {
  return XML_NAMESPACE_URIS.has(comparableUrl(value));
}

function externalDocumentUrls(document: string) {
  const urls = new Set<string>();
  const pattern = /\b(?:href|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of document.matchAll(pattern)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!href || isSafeLocalHref(href)) continue;
    try {
      const parsed = href.startsWith("//") ? new URL(`https:${href}`) : new URL(href);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") urls.add(parsed.toString());
    } catch {
      urls.add(href);
    }
  }
  for (const match of document.matchAll(/https?:\/\/[^\s"'<>)]*/gi)) {
    urls.add(cleanExtractedUrl(match[0]));
  }
  for (const match of document.matchAll(/(?<!:)\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)) {
    urls.add(cleanExtractedUrl(`https:${match[0]}`));
  }
  return [...urls].filter((url) => !isXmlNamespaceUrl(url));
}

function cleanExtractedUrl(value: string) {
  return value.replace(/[.,;]+$/g, "");
}

function isSafeLocalHref(href: string) {
  const normalized = href.toLowerCase();
  return normalized.startsWith("#") || (normalized.startsWith("/") && !normalized.startsWith("//")) || normalized.startsWith("mailto:") || normalized.startsWith("tel:");
}

function comparableUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function userId(user: JwtPayload) {
  return user.user_id ?? user.sub ?? "unknown";
}

function normalizeSubdomainInput(value: unknown) {
  const subdomain = stringValue(value).toLowerCase();
  if (!subdomain) throw new Error("Subdomain is required.");
  if (subdomain.length < 3 || subdomain.length > 63) throw new Error("Subdomain must be between 3 and 63 characters.");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain)) throw new Error("Subdomain can only use lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen.");
  if (isReservedLinkqtNamespace(subdomain)) throw new Error("Subdomain is reserved.");
  return subdomain;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function projectTitleValue(value: unknown) {
  return truncate(stringValue(value).replace(/\s+/g, " "), 80);
}

function assertContentLength(request: Request, maxBytes: number) {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > maxBytes) throw new Error("Request body is too large.");
}

type IdempotencyRecord = {
  user_id: string;
  route: string;
  key: string;
  body_hash: string;
  status_code: number;
  response_json: string;
  created_at: string;
};

type IdempotencyClaim = {
  mode: "fresh";
  key: string;
  route: string;
  userId: string;
  bodyHash: string;
};

type IdempotencyReplay = {
  mode: "replay";
  record: IdempotencyRecord;
};

async function jsonWithIdempotency(request: Request, userIdValue: string, route: string, body: unknown, produce: () => Promise<unknown>, status = 200) {
  const claimed = await replayOrClaimIdempotency(request, userIdValue, route, body);
  if (claimed.mode === "replay") {
    const latest = await waitForIdempotencyTerminal(claimed.record.user_id, claimed.record.route, claimed.record.key) ?? claimed.record;
    const payload = safeJson(latest.response_json) as { claimed?: boolean } | null;
    if (!payload || payload.claimed) throw new Error("Request with this Idempotency-Key is still in progress.");
    return json(request, payload, latest.status_code || 200);
  }
  try {
    const payload = await produce();
    await updateIdempotencyRecord(claimed, payload, status);
    return json(request, payload, status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await updateIdempotencyRecord(claimed, { error: { message: clientErrorMessage(error) } }, statusFromError(message));
    throw error;
  }
}

async function replayOrClaimIdempotency(request: Request, userIdValue: string, route: string, body: unknown): Promise<IdempotencyClaim | IdempotencyReplay> {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  const bodyHash = documentHash(JSON.stringify(body ?? {}));
  if (!key) return { mode: "fresh", key: "", route, userId: userIdValue, bodyHash };
  const inserted = await queryOne<{ key: string }>(`
    insert into idempotency_keys (user_id, route, key, body_hash, status_code, response_json, created_at)
    values (?, ?, ?, ?, 0, ?, ?)
    on conflict (user_id, route, key) do nothing
    returning key
  `, [userIdValue, route, key, bodyHash, JSON.stringify({ claimed: true }), new Date().toISOString()]);
  if (inserted) return { mode: "fresh", key, route, userId: userIdValue, bodyHash };
  const existing = await loadIdempotency(userIdValue, route, key);
  if (!existing) return { mode: "fresh", key, route, userId: userIdValue, bodyHash };
  if (existing.body_hash !== bodyHash) throw new Error("Idempotency-Key was reused with a different request body.");
  return { mode: "replay", record: existing };
}

async function loadIdempotency(userIdValue: string, route: string, key: string) {
  return await queryOne<IdempotencyRecord>(
    "select user_id, route, key, body_hash, status_code, response_json, created_at from idempotency_keys where user_id = ? and route = ? and key = ?",
    [userIdValue, route, key],
  ) ?? null;
}

async function updateIdempotencyRecord(claim: IdempotencyClaim | IdempotencyReplay, payload: unknown, status = 200) {
  if (claim.mode !== "fresh" || !claim.key) return;
  await queryRun(
    "update idempotency_keys set status_code = ?, response_json = ? where user_id = ? and route = ? and key = ?",
    [status, JSON.stringify(payload), claim.userId, claim.route, claim.key],
  );
}

function replayStreamResult(request: Request, userIdValue: string, record: IdempotencyRecord) {
  return streamStoredIdempotency(request, userIdValue, record);
}

function streamStoredIdempotency(request: Request, userIdValue: string, record: IdempotencyRecord) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const payload = JSON.parse(record.response_json) as { claimed?: boolean; pending?: boolean; runId?: string; error?: { message?: string }; project?: BuilderProject; run?: BuilderRun };
        if (payload.error?.message) {
          send("error", { message: payload.error.message });
          controller.close();
          return;
        }
        if (payload.project && payload.run) {
          send("started", { project: payload.project, run: payload.run });
          send("result", { project: payload.project, run: payload.run });
          controller.close();
          return;
        }
        if (payload.pending && payload.runId) {
          const run = await waitForRunNotPending(userIdValue, payload.runId);
          const project = await getProjectForUser(userIdValue, run.project_id);
          send("started", { project, run });
          if (run.status === "failed") send("error", { message: "Streaming AI request failed." });
          else send("result", { project, run });
          controller.close();
          return;
        }
        const latest = await waitForIdempotencyTerminal(record.user_id, record.route, record.key);
        if (latest && latest.response_json !== record.response_json) {
          const nested = streamStoredIdempotency(request, userIdValue, latest);
          const body = nested.body;
          if (body) {
            const reader = body.getReader();
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (chunk.value) controller.enqueue(chunk.value);
            }
          }
          controller.close();
          return;
        }
        send("error", { message: "Request with this Idempotency-Key is still in progress." });
      } catch (error) {
        send("error", { message: error instanceof Error ? error.message : "Idempotency replay failed." });
      }
      controller.close();
    },
  });
  return withCors(request, new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } }));
}

async function waitForRunNotPending(userIdValue: string, runId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 240_000) {
    const run = await getRunForUser(userIdValue, runId);
    if (run.status !== "pending") return run;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return await getRunForUser(userIdValue, runId);
}

async function waitForIdempotencyTerminal(userIdValue: string, route: string, key: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const row = await loadIdempotency(userIdValue, route, key);
    if (!row) return null;
    const payload = safeJson(row.response_json) as { claimed?: boolean; pending?: boolean } | null;
    if (!payload?.claimed) return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return await loadIdempotency(userIdValue, route, key);
}

async function assertAiCreditAvailable(user: JwtPayload) {
  const key = userId(user);
  const day = new Date().toISOString().slice(0, 10);
  const row = await queryOne<{ count: number }>("select count from ai_usage where user_id = ? and day = ?", [key, day]);
  if ((row?.count ?? 0) >= AI_DAILY_LIMIT) throw new Error("AI daily limit reached.");
}

async function consumeAiCredit(user: JwtPayload) {
  await assertAiCreditAvailable(user);
  const key = userId(user);
  const day = new Date().toISOString().slice(0, 10);
  const row = await queryOne<{ count: number }>(`
    insert into ai_usage (user_id, day, count)
    values (?, ?, 1)
    on conflict(user_id, day) do update set count = ai_usage.count + 1
    returning count
  `, [key, day]);
  if ((row?.count ?? 1) > AI_DAILY_LIMIT) {
    await queryRun("update ai_usage set count = greatest(count - 1, 0) where user_id = ? and day = ?", [key, day]);
    throw new Error("AI daily limit reached.");
  }
}

function titleFromDocument(document: string) {
  const title = document.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.replace(/\s+/g, " ").trim();
  return title?.slice(0, 48) ?? "";
}

function sanitizeVersionTitle(value: string) {
  const title = value
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(title || "AI revision", 48);
}

function fallbackVersionTitle(prompt: string) {
  return sanitizeVersionTitle(prompt) || "AI revision";
}

function textPreview(document: string) {
  return document.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "Untitled document";
}

export function notFoundDocument(subdomain: string) {
  const escaped = subdomain.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LinkQT page not found</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f7; color: #171717; }
      main { max-width: 32rem; text-align: center; }
      h1 { margin: 0; font-size: clamp(2.5rem, 10vw, 5rem); letter-spacing: -0.06em; }
      p { margin: 1rem 0 0; color: #737373; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>404</h1>
      <p>No LinkQT page is published for ${escaped}.linkqt.me.</p>
    </main>
  </body>
</html>`;
}

async function proxy(request: Request, path: string, user: JwtPayload) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  const userLabel = user.email ?? user.user_id ?? user.sub ?? "unknown";
  const headers = aiRequestHeaders();
  headers.set("Content-Type", request.headers.get("Content-Type") ?? "application/json");
  headers.set("Accept", request.headers.get("Accept") ?? "*/*");
  const upstreamUrl = upstreamProxyUrl(path);
  console.log(`${requestId} ${request.method} ${path} user=${userLabel} upstream=${upstreamUrl}`);

  let upstream: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    upstream = await fetch(upstreamUrl, { method: request.method, headers, signal: controller.signal, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown upstream fetch error";
    console.error(`${requestId} ${request.method} ${path} upstream_fetch_failed duration=${Date.now() - startedAt}ms error=${message}`);
    throw sanitizedAiFetchError(error);
  } finally {
    clearTimeout(timeout);
  }

  const contentType = upstream.headers.get("Content-Type") ?? "";
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    console.error(`${requestId} ${request.method} ${path} upstream_status=${upstream.status} duration=${Date.now() - startedAt}ms body=${truncate(body, 500)}`);
    return json(request, { error: { message: upstreamErrorMessage(upstream.status, body) } }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
  }
  if (!upstream.body) return json(request, { error: { message: "AI request failed. Please try again." } }, 502);

  return withCors(request, new Response(loggedBody(upstream.body, { requestId, method: request.method, path, status: upstream.status, contentType, startedAt }), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: proxyHeaders(upstream.headers),
  }));
}

function upstreamProxyUrl(path: string) {
  if (path === "/v1/models") return aiModelsUrl();
  if (path === "/v1/chat/completions") return aiChatCompletionsUrl();
  return `${UPSTREAM_URL}${normalizeUpstreamPath(path)}`;
}

function loggedBody(body: ReadableStream<Uint8Array>, input: { requestId: string; method: string; path: string; status: number; contentType: string; startedAt: number }) {
  let bytes = 0;
  let chunks = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of body) {
          chunks += 1;
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        }
        const duration = Date.now() - input.startedAt;
        const level = bytes === 0 ? console.warn : console.log;
        level(`${input.requestId} ${input.method} ${input.path} upstream_status=${input.status} duration=${duration}ms bytes=${bytes} chunks=${chunks} content_type=${input.contentType || "unknown"}`);
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown stream error";
        console.error(`${input.requestId} ${input.method} ${input.path} stream_failed duration=${Date.now() - input.startedAt}ms bytes=${bytes} error=${message}`);
        controller.error(error);
      }
    },
  });
}

async function requireClerkUser(request: Request): Promise<JwtPayload> {
  const token = bearerTokenFromAuthorization(request);
  if (ENABLE_TEST_AUTH && token === TEST_AUTH_TOKEN) {
    await ensureUserProfile(TEST_USER);
    return TEST_USER;
  }
  if (!token) throw new Error("Unauthorized: missing Clerk session token");
  const user = clerkUserFromClaims(await verifyClerkSessionToken(token));
  user.email = user.email || await clerkPrimaryEmail(user.sub);
  await ensureUserProfile(user);
  return user;
}

function bearerTokenFromAuthorization(request: Request) {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

async function verifyClerkSessionToken(token: string) {
  const options = clerkVerifyOptions();
  try {
    return await verifyToken(token, options);
  } catch {
    throw new Error("Unauthorized: invalid Clerk session token");
  }
}

function clerkVerifyOptions() {
  const options: { secretKey?: string; jwtKey?: string; authorizedParties?: string[] } = {};
  const jwtKey = stringValue(process.env.CLERK_JWT_KEY).replace(/\\n/g, "\n");
  const secretKey = stringValue(process.env.CLERK_SECRET_KEY);
  const authorizedParties = clerkAuthorizedParties();
  if (jwtKey) options.jwtKey = jwtKey;
  if (secretKey) options.secretKey = secretKey;
  if (authorizedParties.length > 0) options.authorizedParties = authorizedParties;
  if (!options.jwtKey && !options.secretKey) throw new Error("Clerk token verification is not configured.");
  return options;
}

function clerkAuthorizedParties() {
  return stringValue(process.env.CLERK_AUTHORIZED_PARTIES)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function clerkUserFromClaims(claims: unknown): JwtPayload {
  const record = claims && typeof claims === "object" ? claims as Record<string, unknown> : {};
  const sub = stringValue(record.sub);
  if (!sub) throw new Error("Unauthorized: Clerk token has no subject");
  const email = stringValue(record.email) || stringValue(record.email_address) || stringValue(record.primary_email_address);
  return { sub, user_id: sub, email: email || null };
}

async function clerkPrimaryEmail(userIdValue: string) {
  if (clerkEmailCache.has(userIdValue)) return clerkEmailCache.get(userIdValue) ?? null;
  const client = clerkBackendClient();
  if (!client) {
    clerkEmailCache.set(userIdValue, null);
    return null;
  }
  try {
    const user = await client.users.getUser(userIdValue);
    const primaryEmail = user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
    clerkEmailCache.set(userIdValue, primaryEmail);
    return primaryEmail;
  } catch (error) {
    console.warn(`clerk_email_lookup_failed user=${userIdValue} error=${error instanceof Error ? error.message : String(error)}`);
    clerkEmailCache.set(userIdValue, null);
    return null;
  }
}

function clerkBackendClient() {
  const secretKey = stringValue(process.env.CLERK_SECRET_KEY);
  if (!secretKey) return null;
  clerkClient ??= createClerkClient({ secretKey });
  return clerkClient;
}

function proxyHeaders(headers: Headers) {
  const next = new Headers();
  const contentType = headers.get("Content-Type");
  const cacheControl = headers.get("Cache-Control");
  if (contentType) next.set("Content-Type", contentType);
  if (cacheControl) next.set("Cache-Control", cacheControl);
  return next;
}

function json(request: Request, payload: unknown, status = 200) {
  return withCors(request, new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }));
}

export function htmlDocument(document: string, status = 200) {
  return new Response(document, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "sandbox allow-scripts allow-forms allow-popups",
        "default-src 'self' https: data: blob:",
        "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
        "style-src 'unsafe-inline' https:",
        "img-src https: data: blob:",
        "font-src https: data:",
        "connect-src https:",
        "frame-src https:",
        "form-action https:",
        "base-uri 'none'",
      ].join("; "),
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function statusFromError(message: string) {
  if (message.startsWith("Unauthorized")) return 401;
  if (message.includes("owned by another")) return 403;
  if (message.includes("Idempotency-Key") || message.includes("still in progress")) return 409;
  if (message.includes("already taken")) return 409;
  if (message.includes("Subdomain") || message.includes("subdomain")) return 400;
  if (message.includes("not found")) return 404;
  if (message.includes("too large")) return 413;
  if (message.includes("daily limit")) return 429;
  if (message.includes("timed out")) return 504;
  if (message.includes("AI request failed")) return 502;
  if (message.includes("must be completed")) return 400;
  if (message.includes("seed") || message.includes("Blank project seeds")) return 400;
  if (message.includes("Cannot delete")) return 400;
  if (message.includes("Unapproved outbound") || message.includes("Insecure external") || message.includes("Document is required") || message.includes("Invalid link URL") || message.includes("Link URL must start")) return 400;
  return 500;
}

class AiRequestFailure extends Error {
  status?: number;
  transient: boolean;

  constructor(message: string, input: { status?: number; transient?: boolean } = {}) {
    super(message);
    this.name = "AiRequestFailure";
    this.status = input.status;
    this.transient = Boolean(input.transient);
  }
}

async function withAiRetries<T>(input: { phase: string; log?: BuilderAiLogContext; turn?: number; send?: StreamSender; record?: ToolTraceRecorder; documentHash?: string | null; onRetry?: (input: { attempt: number; nextAttempt: number; error: AiRequestFailure }) => void | Promise<void> }, operation: (attempt: number) => Promise<T>) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= AI_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const failure = normalizeAiRequestFailure(error);
      lastError = failure;
      if (!failure.transient) throw error instanceof AiRequestFailure ? sanitizedAiFetchError(failure) : error;
      if (attempt >= AI_MAX_ATTEMPTS) break;
      const nextAttempt = attempt + 1;
      const delayMs = aiRetryDelayMs(attempt);
      const message = `Request failed. Retrying ${nextAttempt}/${AI_MAX_ATTEMPTS}...`;
      console.warn(`${aiLogPrefix(input.log)} upstream_ai_retry phase=${input.phase} turn=${input.turn ?? "none"} attempt=${attempt} next_attempt=${nextAttempt} delay_ms=${delayMs} status=${failure.status ?? "none"} error=${failure.message}`);
      input.send?.("status", { message });
      input.record?.({
        eventType: "upstream_retry",
        status: "retrying",
        message,
        args: {
          phase: input.phase,
          turn: input.turn,
          attempt,
          nextAttempt,
          maxAttempts: AI_MAX_ATTEMPTS,
        },
        result: {
          error: sanitizedAiFetchError(failure).message,
        },
        documentHash: input.documentHash ?? null,
      });
      await input.onRetry?.({ attempt, nextAttempt, error: failure });
      await sleep(delayMs);
    }
  }
  throw sanitizedAiFetchError(lastError);
}

function aiHttpFailure(status: number, body: string) {
  return new AiRequestFailure(upstreamErrorMessage(status, body), {
    status,
    transient: isRetryableAiStatus(status) || looksLikeInfrastructureError(body),
  });
}

function normalizeAiRequestFailure(error: unknown) {
  if (error instanceof AiRequestFailure) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AiRequestFailure("AI request timed out. Please try again.", { transient: true });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AiRequestFailure(message || "AI request failed. Please try again.", {
    transient: isRetryableAiMessage(message),
  });
}

function isRetryableAiStatus(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 599);
}

function isRetryableAiMessage(message: string) {
  const sample = message.toLowerCase();
  return sample.includes("timed out") || sample.includes("ai request failed") || looksLikeInfrastructureError(message) || looksLikeNetworkError(message);
}

function aiRetryDelayMs(attempt: number) {
  return Math.round(AI_RETRY_BASE_MS * Math.min(8, 2 ** Math.max(0, attempt - 1)));
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aiLogPrefix(log?: BuilderAiLogContext) {
  return log ? `${log.requestId} ${log.path}` : "ai";
}

function aiChatCompletionsUrl() {
  return `${UPSTREAM_URL}${AI_CHAT_COMPLETIONS_PATH}`;
}

function aiModelsUrl() {
  return `${UPSTREAM_URL}${AI_MODELS_PATH}`;
}

function aiRequestHeaders() {
  const headers = new Headers({ "Content-Type": "application/json" });
  const key = upstreamApiKey();
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return headers;
}

function upstreamApiKey() {
  if (AI_API_KEY) return AI_API_KEY;
  if (isLocalTestUpstream()) return "";
  throw new AiRequestFailure("AI is not configured.", { transient: false });
}

function isLocalTestUpstream() {
  try {
    const hostname = new URL(UPSTREAM_URL).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function normalizeUpstreamPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function stableAiRequestBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record.reasoning_effort !== undefined) return body;
  return { ...record, reasoning_effort: AI_REASONING_EFFORT };
}

function upstreamErrorMessage(_status: number, _body: string) {
  return "AI request failed. Please try again.";
}

function clientErrorMessage(error: unknown): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "Request failed.";
  if (!message.trim()) return "Request failed.";
  if (looksLikeInternalDetail(message)) return "Request failed. Please try again.";
  return message;
}

function publicToolEventJson(value: string): string {
  const parsed = safeJson(normalizeJsonText(value));
  if (parsed == null) return "{}";
  return JSON.stringify(redactInternalClientValue(parsed));
}

function redactInternalClientValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInternalClientValue);
  if (!value || typeof value !== "object") {
    return typeof value === "string" && looksLikeInternalDetail(value) ? "[redacted]" : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (normalized === "model" || normalized.includes("upstream") || normalized.includes("api_key") || normalized.includes("api-key")) continue;
    out[key] = redactInternalClientValue(nested);
  }
  return out;
}

function looksLikeInternalDetail(value: string): boolean {
  const sample = value.toLowerCase();
  if (looksLikeInfrastructureError(value) || looksLikeNetworkError(value)) return true;
  return [
    "deepseek",
    "openai",
    "anthropic",
    "muse-spark",
    "meta.ai",
    "neon",
    "postgres",
    "database_url",
    "api_key",
    "process.env",
    "linkqt_upstream",
    "linkqt_ai_",
    "api.deepseek.com",
    "api.meta.ai",
  ].some((pattern) => sample.includes(pattern));
}

function sanitizedAiFetchError(error: unknown) {
  if (error instanceof AiRequestFailure && error.transient) return new Error("AI request failed. Please try again.");
  if (error instanceof DOMException && error.name === "AbortError") return new Error("AI request timed out. Please try again.");
  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim() || looksLikeInternalDetail(message)) return new Error("AI request failed. Please try again.");
  return error instanceof Error ? error : new Error(message);
}

function safeJson(text: string) {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function looksLikeHtml(value: string) {
  const sample = value.trim().slice(0, 1000).toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html") || sample.includes("<title>attention required! | cloudflare</title>") || sample.includes("cloudflare ray id");
}

function looksLikeInfrastructureError(value: string) {
  const sample = value.trim().slice(0, 1000).toLowerCase();
  return looksLikeHtml(value) || sample.includes("cloudflare") || sample.includes("upstream") || sample.includes("model endpoint") || sample.includes("bad gateway") || sample.includes("error code: 502");
}

function looksLikeNetworkError(value: string) {
  const sample = value.trim().slice(0, 1000).toLowerCase();
  return [
    "unable to connect",
    "typo in the url or port",
    "could not resolve",
    "dns",
    "econnrefused",
    "econnreset",
    "enotfound",
    "network",
    "socket",
    "connection",
    "connect timeout",
    "fetch failed",
  ].some((pattern) => sample.includes(pattern));
}

function envNumber(name: string, fallback: number, min?: number) {
  const value = Number(process.env[name] ?? fallback);
  const normalized = Number.isFinite(value) ? value : fallback;
  return min === undefined ? normalized : Math.max(min, normalized);
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function withCors(request: Request, response: Response) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("Origin");
  const allowedOrigins = new Set(["http://localhost:3000", "https://linkqt.me", "https://www.linkqt.me"]);
  headers.set("Access-Control-Allow-Origin", origin && allowedOrigins.has(origin) ? origin : "http://localhost:3000");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization,Idempotency-Key");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function apiUrl(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/api") url.pathname = "/";
  else if (url.pathname.startsWith("/api/")) url.pathname = url.pathname.slice(4);
  return url;
}

export async function publishedDocument(siteKey: string) {
  await ensureSchema();
  return currentDeploymentDocument(siteKey);
}

