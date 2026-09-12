export type BuilderProject = {
  id: string;
  user_id: string;
  title: string;
  origin: "ai" | "manual";
  deployed_run_id?: string | null;
  deployed_at?: string | null;
  created_at: string;
  updated_at: string;
  runs: BuilderRun[];
  open_canvases?: BuilderRun[];
};

export type UserProfile = {
  user_id: string;
  email: string | null;
  subdomain: string | null;
  registration_complete: boolean;
  created_at: string;
  updated_at: string;
};

export type BuilderStats = {
  total_projects: number;
  total_runs: number;
  ai_runs: number;
  manual_runs: number;
  deployed_pages: number;
  ai_used_today: number;
  ai_daily_limit: number;
};

export type BuilderLink = {
  label: string;
  url: string;
};

export type BuilderRun = {
  id: string;
  project_id: string;
  user_id: string;
  parent_run_id: string | null;
  kind: "ai" | "manual";
  status: "pending" | "completed" | "failed";
  is_seed?: boolean;
  title: string | null;
  prompt: string | null;
  document: string;
  links: BuilderLink[];
  preview?: string;
  tool_event_count?: number;
  created_at: string;
};

export type Deployment = {
  id: string;
  user_id: string;
  site_key: string;
  project_id: string;
  run_id: string;
  document: string;
  deployed_at: string;
};

export type BuilderRunToolEvent = {
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

export type BuilderAiToolPayload = {
  message: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  hash?: string;
  error?: string;
};

export type BuilderAiStreamHandlers = {
  onStatus?: (message: string) => void;
  onToken?: (content: string) => void;
  onDocument?: (content: string) => void;
  onTool?: (payload: BuilderAiToolPayload) => void;
  onReset?: (message: string) => void;
  onStarted?: (result: { project: BuilderProject; run: BuilderRun }) => void;
};

const LINKQT_API_URL = (process.env.NEXT_PUBLIC_LINKQT_API_URL ?? "").replace(/\/$/, "");
const LINKQT_API_BASE = LINKQT_API_URL ? `${LINKQT_API_URL}/api` : "/api";

export async function getProfile(authToken: string): Promise<UserProfile> {
  const response = await fetchApi(`${LINKQT_API_BASE}/me/profile`, { headers: authHeaders(authToken) });
  if (!response.ok) throw await apiError(response, "Could not load profile");
  const payload = await response.json() as { profile: UserProfile };
  return payload.profile;
}

export async function getStats(authToken: string): Promise<BuilderStats> {
  const response = await fetchApi(`${LINKQT_API_BASE}/me/stats`, { headers: authHeaders(authToken) });
  if (!response.ok) throw await apiError(response, "Could not load stats");
  const payload = await response.json() as { stats: BuilderStats };
  return payload.stats;
}

export async function reserveSubdomain(authToken: string, subdomain: string): Promise<UserProfile> {
  const response = await fetchApi(`${LINKQT_API_BASE}/me/subdomain`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify({ subdomain }),
  });
  if (!response.ok) throw await apiError(response, "Could not reserve subdomain");
  const payload = await response.json() as { profile: UserProfile };
  return payload.profile;
}

export async function listProjects(authToken: string): Promise<BuilderProject[]> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/projects`, { headers: authHeaders(authToken) });
  if (!response.ok) throw await apiError(response, "Could not load projects");
  const payload = await response.json() as { projects?: BuilderProject[] };
  return payload.projects ?? [];
}

export async function createManualProject(authToken: string, input: { document: string; title?: string; links?: BuilderLink[] }): Promise<{ project: BuilderProject; run: BuilderRun }> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/manual-project`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await apiError(response, "Could not save manual project");
  return response.json();
}

export async function createBlankProject(authToken: string, input: { title?: string } = {}): Promise<{ project: BuilderProject; run: BuilderRun }> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/blank-project`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await apiError(response, "Could not create blank project");
  return response.json();
}

export async function createBlankRun(authToken: string, projectId: string): Promise<{ project: BuilderProject; run: BuilderRun }> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/blank-run`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify({ projectId }),
  });
  if (!response.ok) throw await apiError(response, "Could not create blank canvas");
  return response.json();
}

export async function renameProject(authToken: string, input: { projectId: string; title: string }): Promise<BuilderProject> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/rename-project`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await apiError(response, "Could not rename project");
  const payload = await response.json() as { project: BuilderProject };
  return payload.project;
}

export async function streamReviseRun(authToken: string, input: { runId: string; prompt: string; links?: BuilderLink[] }, handlers: BuilderAiStreamHandlers = {}): Promise<{ project: BuilderProject; run: BuilderRun }> {
  return streamBuilderAi(`${LINKQT_API_BASE}/builder/revise/stream`, authToken, input, handlers, "AI revision failed");
}

export async function listRunToolEvents(authToken: string, runId: string): Promise<BuilderRunToolEvent[]> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/runs/${encodeURIComponent(runId)}/tool-events`, {
    headers: authHeaders(authToken),
  });
  if (!response.ok) throw await apiError(response, "Could not load AI trace");
  const payload = await response.json() as { events?: BuilderRunToolEvent[] };
  return payload.events ?? [];
}

export async function saveVersion(authToken: string, input: { runId: string; document: string; links?: BuilderLink[] }): Promise<{ project: BuilderProject; run: BuilderRun }> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/version`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await apiError(response, "Could not save version");
  return response.json();
}

export async function cloneProject(authToken: string, runId: string): Promise<{ project: BuilderProject; run: BuilderRun }> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/clone-project`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify({ runId }),
  });
  if (!response.ok) throw await apiError(response, "Could not clone project");
  return response.json();
}

export async function deleteProject(authToken: string, projectId: string): Promise<void> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/delete-project`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify({ projectId }),
  });
  if (!response.ok) throw await apiError(response, "Could not delete project");
}

export async function deleteRun(authToken: string, runId: string): Promise<void> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/delete-run`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify({ runId }),
  });
  if (!response.ok) throw await apiError(response, "Could not delete run");
}

export async function deployRun(authToken: string, runId: string): Promise<Deployment> {
  const response = await fetchApi(`${LINKQT_API_BASE}/builder/deploy`, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify({ runId }),
  });
  if (!response.ok) throw await apiError(response, "Deploy failed");
  const payload = await response.json() as { deployment: Deployment };
  return payload.deployment;
}

async function fetchApi(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch (cause) {
    throw new Error(`Could not reach the LinkQT API at ${LINKQT_API_BASE}. ${errorMessage(cause)}`);
  }
}

async function streamBuilderAi(url: string, authToken: string, input: unknown, handlers: BuilderAiStreamHandlers, fallback: string) {
  const response = await fetchApi(url, {
    method: "POST",
    headers: mutatingHeaders(authToken),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await apiError(response, fallback);
  if (!response.body) throw new Error(`${fallback}: LinkQT API returned an empty stream`);

  const decoder = new TextDecoder();
  let buffer = "";
  let result: { project: BuilderProject; run: BuilderRun } | null = null;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      result = handleBuilderSseFrame(frame, handlers, result);
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) result = handleBuilderSseFrame(buffer, handlers, result);
  if (!result) throw new Error(`${fallback}: stream ended before saving a result`);
  return result;
}

function handleBuilderSseFrame(frame: string, handlers: BuilderAiStreamHandlers, current: { project: BuilderProject; run: BuilderRun } | null) {
  const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
  const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data.trim()) return current;

  const payload = safeJson(data) as { message?: unknown; content?: unknown; name?: unknown; args?: unknown; result?: unknown; hash?: unknown; error?: unknown; project?: BuilderProject; run?: BuilderRun } | null;
  if (event === "status" && typeof payload?.message === "string") handlers.onStatus?.(payload.message);
  if (event === "token" && typeof payload?.content === "string") handlers.onToken?.(payload.content);
  if (event === "document" && typeof payload?.content === "string") handlers.onDocument?.(payload.content);
  if (event === "tool" && typeof payload?.message === "string") {
    handlers.onTool?.({
      message: payload.message,
      name: typeof payload.name === "string" ? payload.name : undefined,
      args: payload.args,
      result: payload.result,
      hash: typeof payload.hash === "string" ? payload.hash : undefined,
      error: typeof payload.error === "string" ? payload.error : undefined,
    });
  }
  if (event === "reset") handlers.onReset?.(typeof payload?.message === "string" ? payload.message : "Retrying generation");
  if (event === "started" && payload?.project && payload.run) handlers.onStarted?.({ project: payload.project, run: payload.run });
  if (event === "error") {
    const message = typeof payload?.message === "string" && payload.message.trim() ? payload.message : "Streaming AI request failed.";
    throw new Error(sanitizeErrorText(message));
  }
  if (event === "result" && payload?.project && payload.run) return { project: payload.project, run: payload.run };
  return current;
}

async function apiError(response: Response, fallback: string) {
  const text = await response.text().catch(() => "");
  const parsed = safeJson(text) as { error?: { message?: unknown }; message?: unknown } | null;
  const message = parsed?.error?.message ?? parsed?.message;
  if (typeof message === "string" && message.trim()) return new Error(`${fallback}: ${sanitizeErrorText(message)}`);
  if (text.trim()) return new Error(`${fallback}: ${sanitizeErrorText(text)}`);
  return new Error(`${fallback}: LinkQT API returned ${response.status}`);
}

function authHeaders(authToken: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };
}

function mutatingHeaders(authToken: string) {
  return {
    ...authHeaders(authToken),
    "Idempotency-Key": crypto.randomUUID(),
  };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function sanitizeErrorText(value: string) {
  if (looksLikeInfrastructureError(value)) return "AI request failed. Please try again.";
  return value.trim().replace(/\s+/g, " ").slice(0, 240);
}

function looksLikeHtml(value: string) {
  const sample = value.trim().slice(0, 1000).toLowerCase();
  return sample.startsWith("<!doctype html") || sample.startsWith("<html") || sample.includes("<title>attention required! | cloudflare</title>") || sample.includes("cloudflare ray id");
}

function looksLikeInfrastructureError(value: string) {
  const sample = value.trim().slice(0, 1000).toLowerCase();
  return looksLikeHtml(value)
    || sample.includes("cloudflare")
    || sample.includes("upstream")
    || sample.includes("model endpoint")
    || sample.includes("bad gateway")
    || sample.includes("error code: 502")
    || sample.includes("deepseek")
    || sample.includes("openai")
    || sample.includes("anthropic")
    || sample.includes("muse-spark")
    || sample.includes("meta.ai")
    || sample.includes("neon")
    || sample.includes("postgres")
    || sample.includes("database_url")
    || sample.includes("api_key")
    || sample.includes("linkqt_upstream")
    || sample.includes("linkqt_ai_");
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
