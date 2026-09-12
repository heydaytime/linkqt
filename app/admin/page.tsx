"use client";

import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import Link from "next/link";
import {
  BuilderAiToolPayload,
  BuilderLink,
  BuilderProject,
  BuilderRun,
  BuilderRunToolEvent,
  UserProfile,
  cloneProject,
  createBlankProject,
  createBlankRun,
  createManualProject,
  deleteProject,
  deleteRun,
  deployRun,
  getProfile,
  listProjects,
  listRunToolEvents,
  renameProject,
  reserveSubdomain,
  saveVersion,
  streamReviseRun,
} from "../../lib/builder-client";
import { STARTER_DOCUMENT } from "../../lib/starter-document";

const DEFAULT_LINKS: BuilderLink[] = [
  { label: "YouTube", url: "https://www.youtube.com/@yourhandle" },
  { label: "Instagram", url: "https://www.instagram.com/yourhandle/" },
  { label: "Personal Website", url: "https://example.com/" },
];

const EMPTY_STATE_DOCUMENT = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Start a project</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 28px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; background: radial-gradient(circle at 20% 0%, rgba(99,102,241,.18), transparent 30rem), linear-gradient(160deg, #0b0b0f 0%, #16161d 60%, #0b0b0f 100%); color: #e5e7eb; }
      main { width: min(100%, 440px); border: 1px solid rgba(255,255,255,.1); border-radius: 24px; padding: 32px; background: rgba(24,24,27,.6); backdrop-filter: blur(12px); box-shadow: 0 30px 80px rgba(0,0,0,.4); }
      .badge { width: 52px; height: 52px; margin: 0 auto 18px; display: grid; place-items: center; border-radius: 16px; background: linear-gradient(135deg, #4f46e5, #7c3aed); font-size: 26px; font-weight: 800; color: #fff; }
      h1 { margin: 0; text-align: center; font-size: 24px; letter-spacing: -.02em; }
      p.sub { margin: 8px auto 24px; max-width: 32ch; text-align: center; color: #a1a1aa; font-size: 14px; line-height: 1.6; }
      ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
      li { display: flex; gap: 12px; align-items: flex-start; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 12px 14px; background: rgba(255,255,255,.03); }
      .n { flex: 0 0 auto; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 999px; background: rgba(99,102,241,.2); color: #c7d2fe; font-size: 12px; font-weight: 700; }
      .t { font-size: 13.5px; line-height: 1.5; color: #a1a1aa; }
      .t b { color: #f4f4f5; font-weight: 650; }
    </style>
  </head>
  <body>
    <main>
      <div class="badge">+</div>
      <h1>Start a project</h1>
      <p class="sub">Nothing here yet. Pick how you want to begin — your live preview shows up here.</p>
      <ol>
        <li><span class="n">1</span><span class="t"><b>Default</b> — start from a ready-made linktree template.</span></li>
        <li><span class="n">2</span><span class="t"><b>Blank canvas</b> — then describe your page to the AI or upload your own HTML.</span></li>
        <li><span class="n">3</span><span class="t"><b>Upload HTML</b> — bring an existing page in as a new project.</span></li>
      </ol>
    </main>
  </body>
</html>`;

type Tab = "ai" | "manual";
type WorkspaceView = "preview" | "source";
type StreamPhase = "idle" | "streaming" | "completed" | "error";
type StreamLog = {
  id: string;
  message: string;
  at: string;
  kind: "status" | "tool";
  eventType?: string;
  name?: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  hash?: string;
  error?: string;
  durationMs?: number | null;
};
type AdminUser = {
  email: string | null;
  uid: string;
  getAuthToken: () => Promise<string>;
};

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2";

// Prettier's in-browser build is ~1.5-2MB, so it is lazy-imported on first use
// (never statically imported) and cached so the chunk loads only once.
let prettierBundle:
  | Promise<{
      format: (source: string, options: Record<string, unknown>) => Promise<string>;
      plugins: unknown[];
    }>
  | null = null;

function loadPrettier() {
  if (!prettierBundle) {
    prettierBundle = Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/html"),
      import("prettier/plugins/postcss"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]).then(([standalone, html, postcss, babel, estree]) => ({
      format: standalone.format as unknown as (
        source: string,
        options: Record<string, unknown>,
      ) => Promise<string>,
      plugins: [html, postcss, babel, estree] as unknown[],
    }));
  }
  return prettierBundle;
}

export default function AdminPage() {
  const { isLoaded, isSignedIn, user: clerkUser } = useUser();
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [subdomainDraft, setSubdomainDraft] = useState("");
  const [projects, setProjects] = useState<BuilderProject[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("ai");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("preview");
  const [prompt, setPrompt] = useState("");
  const [editingBaseRunId, setEditingBaseRunId] = useState<string | null>(null);
  const [links, setLinks] = useState<BuilderLink[]>(DEFAULT_LINKS);
  const [document, setDocument] = useState("");
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [formatState, setFormatState] = useState<"idle" | "formatting" | "error">("idle");
  const [linksModalOpen, setLinksModalOpen] = useState(false);
  const [editConfirmOpen, setEditConfirmOpen] = useState(false);
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const [pendingReplacements, setPendingReplacements] = useState<
    { label: string; from: string; to: string }[]
  >([]);
  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamPhase, setStreamPhase] = useState<StreamPhase>("idle");
  const [streamDrawerOpen, setStreamDrawerOpen] = useState(false);
  const [streamTitle, setStreamTitle] = useState("AI generation");
  const [streamLogs, setStreamLogs] = useState<StreamLog[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamHtmlOutput, setStreamHtmlOutput] = useState("");
  const [streamHtmlOutputEnabled, setStreamHtmlOutputEnabled] = useState(false);
  const [runToolEvents, setRunToolEvents] = useState<BuilderRunToolEvent[]>([]);
  const [toolTraceLoading, setToolTraceLoading] = useState(false);
  const [traceDrawerRequested, setTraceDrawerRequested] = useState(false);
  const streamAutoClosedRef = useRef(false);
  const streamTokenBufferRef = useRef("");
  const authLoading = !isLoaded;
  const user = useMemo<AdminUser | null>(() => {
    if (!isLoaded || !isSignedIn || !clerkUser) return null;
    return {
      email:
        clerkUser.primaryEmailAddress?.emailAddress ??
        clerkUser.emailAddresses[0]?.emailAddress ??
        null,
      uid: clerkUser.id,
      async getAuthToken() {
        const token = await getToken();
        if (!token)
          throw new Error(
            "Clerk session is unavailable. Please sign in again.",
          );
        return token;
      },
    };
  }, [isLoaded, isSignedIn, clerkUser, getToken]);

  const selectedRun = useMemo(
    () =>
      allProjectRuns(projects).find((run) => run.id === selectedRunId) ?? null,
    [projects, selectedRunId],
  );
  const selectedProject = useMemo(
    () =>
      projects.find((project) => project.id === selectedRun?.project_id) ??
      null,
    [projects, selectedRun],
  );
  const linkValidation = useMemo(() => validateLinks(links), [links]);
  const isAiStreaming = streamPhase === "streaming";
  const selectedRunIsSeed = isSeedRun(selectedRun);
  const isEditingPrompt = Boolean(
    selectedRun && editingBaseRunId === selectedRun.id,
  );
  const selectedRunPrompt = selectedRun?.prompt?.trim() ?? "";
  const promptInputValue = isEditingPrompt ? prompt : selectedRunPrompt;
  const historicalTraceLogs = useMemo(
    () => runToolEvents.map((event) => streamLogFromToolEvent(event)),
    [runToolEvents],
  );
  const drawerLogs = streamPhase !== "idle" ? streamLogs : historicalTraceLogs;
  const hasStreamActivity =
    traceDrawerRequested ||
    toolTraceLoading ||
    streamPhase !== "idle" ||
    streamLogs.length > 0 ||
    historicalTraceLogs.length > 0;
  const reserveStreamDrawer = hasStreamActivity && streamDrawerOpen;
  const hasUnsavedDocument = selectedRun
    ? document !== selectedRun.document
    : document !== "";
  const aiPromptBlockedReason = aiBuilderBlockedReason(
    selectedRun,
    hasUnsavedDocument,
    isBusy,
    isAiStreaming,
    isEditingPrompt,
  );
  const aiControlsDisabled = Boolean(aiPromptBlockedReason);
  // Viewing a completed saved run: instead of hard-blocking the prompt, let the
  // user interact and confirm whether to edit this run or start on a blank canvas.
  const canEditSelectedRun = Boolean(
    selectedRun &&
      !isEditingPrompt &&
      !selectedRunIsSeed &&
      selectedRun.status === "completed" &&
      !isAiStreaming &&
      !isBusy &&
      !hasUnsavedDocument,
  );
  // There are unsaved edits (links and/or source) on a real run that can be saved
  // as a new run without an AI prompt.
  const canSaveEdits = Boolean(
    selectedRun &&
      !selectedRunIsSeed &&
      draftDirty &&
      document.trim() &&
      !linkValidation.error &&
      !isBusy,
  );
  // Uploading HTML only makes sense on a blank canvas (or before any run exists)
  // — never as a way to "edit" an existing run with unrelated markup. When a real
  // run is selected, force the AI builder tab and hide Upload HTML.
  const canUploadHtml = !selectedRun || selectedRunIsSeed;
  const activeTab: Tab = canUploadHtml ? tab : "ai";
  const drawerTitle =
    streamPhase === "idle"
      ? selectedRun
        ? `Tool calls for ${versionLabel(selectedRun)}`
        : "Saved AI trace"
      : streamTitle;
  const drawerHtmlOutput =
    streamHtmlOutputEnabled && streamPhase !== "idle" ? streamHtmlOutput : "";
  const promptPlaceholder = isEditingPrompt
    ? selectedRunIsSeed
      ? "Describe the page you want to build."
      : "Describe the next change to make from this run."
    : selectedRun
      ? "No AI prompt was saved for this run."
      : "Select a run, then click Edit on it to start a new prompt.";

  useEffect(() => {
    if (!isLoaded || isSignedIn) return;
    setProfile(null);
    setProjects([]);
    setSelectedRunId(null);
    setEditingBaseRunId(null);
  }, [isLoaded, isSignedIn]);

  useEffect(() => {
    if (!linksModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLinksModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [linksModalOpen]);

  useEffect(() => {
    if (!editConfirmOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditConfirmOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editConfirmOpen]);

  useEffect(() => {
    if (!saveConfirmOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSaveConfirmOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveConfirmOpen]);

  useEffect(() => {
    if (!user) return;
    refreshProfile(user).catch((cause) => setError(errorMessage(cause)));
  }, [user]);

  useEffect(() => {
    if (!user || !profile?.registration_complete) return;
    refreshProjects(user).catch((cause) => setError(errorMessage(cause)));
  }, [user, profile?.registration_complete]);

  useEffect(() => {
    if (!user || !selectedRun || selectedRun.kind !== "ai") {
      setRunToolEvents([]);
      setToolTraceLoading(false);
      return;
    }
    let cancelled = false;
    setToolTraceLoading(true);
    user
      .getAuthToken()
      .then((authToken) => listRunToolEvents(authToken, selectedRun.id))
      .then((events) => {
        if (!cancelled) setRunToolEvents(events);
      })
      .catch(() => {
        if (!cancelled) setRunToolEvents([]);
      })
      .finally(() => {
        if (!cancelled) setToolTraceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, selectedRun?.id]);

  async function refreshProjects(currentUser = user) {
    if (!currentUser) return;
    setProjectsLoading(true);
    const authToken = await currentUser.getAuthToken();
    try {
      const nextProjects = await listProjects(authToken);
      setProjects(nextProjects);
      const selectedStillExists =
        selectedRunId && hasSelectableRun(nextProjects, selectedRunId);
      if (!selectedStillExists) {
        const firstRun = latestRun(nextProjects[0]);
        if (firstRun) selectRun(firstRun, false);
        else resetToDefaultDraft();
      }
    } finally {
      setProjectsLoading(false);
    }
  }

  async function refreshProfile(currentUser = user) {
    if (!currentUser) return;
    setProfileLoading(true);
    setError(null);
    try {
      const authToken = await currentUser.getAuthToken();
      const nextProfile = await getProfile(authToken);
      setProfile(nextProfile);
      setSubdomainDraft(nextProfile.subdomain ?? "");
    } finally {
      setProfileLoading(false);
    }
  }

  async function handleSignOut() {
    await signOut({ redirectUrl: "/auth" });
  }

  async function handleRegisterSubdomain(event: FormEvent) {
    event.preventDefault();
    if (!user || profileLoading || isBusy) return;
    setProfileLoading(true);
    setError(null);
    setStatus(null);
    try {
      const authToken = await user.getAuthToken();
      const nextProfile = await reserveSubdomain(authToken, subdomainDraft);
      setProfile(nextProfile);
      setStatus(`Registered ${nextProfile.subdomain}.linkqt.me.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setProfileLoading(false);
    }
  }

  async function handleRevise(event?: FormEvent) {
    event?.preventDefault();
    if (
      !user ||
      !selectedRun ||
      editingBaseRunId !== selectedRun.id ||
      !prompt.trim() ||
      linkValidation.error ||
      hasUnsavedDocument ||
      selectedRun.status !== "completed"
    )
      return;
    const baseRun = selectedRun;
    const startsFromBlank =
      isSeedRun(baseRun) || baseRun.document.trim().length === 0;
    await runAiStream(
      startsFromBlank ? "Building from blank project" : "Revising selected run",
      async (authToken) => {
        const result = await streamReviseRun(
          authToken,
          {
            runId: baseRun.id,
            prompt: prompt.trim(),
            links: linkValidation.links,
          },
          streamHandlers({
            showHtmlOutput: startsFromBlank,
            onStarted(result) {
              mergeProjectResult(result);
              selectRun(result.run, false);
              setWorkspaceView("preview");
              setStatus(
                "AI run started. Preview will update as the save completes.",
              );
            },
          }),
        );
        await refreshProjects();
        selectRun(result.run);
        setPrompt("");
        setStatus("AI revision saved as the newest run.");
      },
      {
        showHtmlOutput: startsFromBlank,
        async onError() {
          setDocument(baseRun.document);
          setLinks(baseRun.links ?? []);
          setDraftDirty(false);
          await refreshProjects();
        },
      },
    );
  }

  async function runAiStream(
    label: string,
    task: (authToken: string) => Promise<void>,
    options: {
      onError?: () => Promise<void> | void;
      showHtmlOutput?: boolean;
    } = {},
  ) {
    if (!user) return;
    setIsBusy(true);
    setError(null);
    setStatus(null);
    setStreamTitle(label);
    setStreamLogs([makeStatusLog(label)]);
    setStreamError(null);
    setStreamHtmlOutput("");
    setStreamHtmlOutputEnabled(Boolean(options.showHtmlOutput));
    setTraceDrawerRequested(false);
    streamTokenBufferRef.current = "";
    streamAutoClosedRef.current = false;
    setStreamPhase("streaming");
    setStreamDrawerOpen(true);
    try {
      const authToken = await user.getAuthToken();
      await task(authToken);
      setStreamPhase("completed");
      appendStreamLog("Completed and saved");
    } catch (cause) {
      const message = errorMessage(cause);
      setStreamPhase("error");
      setStreamError(message);
      setError(message);
      setStatus(null);
      appendStreamLog("Stream failed");
      await options.onError?.();
    } finally {
      setIsBusy(false);
    }
  }

  function streamHandlers(
    options: {
      onStarted?: (result: {
        project: BuilderProject;
        run: BuilderRun;
      }) => void;
      showHtmlOutput?: boolean;
    } = {},
  ) {
    return {
      onStatus: appendStreamLog,
      onTool: appendToolLog,
      onReset(message: string) {
        appendStreamLog(message);
        streamTokenBufferRef.current = "";
        if (options.showHtmlOutput) setStreamHtmlOutput("");
        setDraftDirty(false);
      },
      onStarted: options.onStarted,
      onDocument(content: string) {
        if (options.showHtmlOutput)
          setStreamHtmlOutput(stripCodeFence(content));
        if (isPreviewableHtmlDocument(content))
          setDocument(stripCodeFence(content));
        setDraftDirty(false);
      },
      onToken(content: string) {
        streamTokenBufferRef.current += content;
        if (options.showHtmlOutput)
          setStreamHtmlOutput(streamTokenBufferRef.current);
        if (isPreviewableHtmlDocument(streamTokenBufferRef.current))
          setDocument(stripCodeFence(streamTokenBufferRef.current));
        setDraftDirty(false);
      },
    };
  }

  function mergeProjectResult(result: {
    project: BuilderProject;
    run: BuilderRun;
  }) {
    setProjects((current) => {
      const currentProject = current.find(
        (project) => project.id === result.project.id,
      );
      const existingRuns = currentProject?.runs ?? result.project.runs ?? [];
      const existingCanvases =
        currentProject?.open_canvases ?? result.project.open_canvases ?? [];
      const isSeed = isSeedRun(result.run);
      const projectWithRun: BuilderProject = {
        ...(currentProject ?? {}),
        ...result.project,
        runs: isSeed ? existingRuns : mergeRuns(existingRuns, result.run),
        open_canvases: isSeed
          ? mergeRuns(existingCanvases, result.run)
          : existingCanvases.filter(
              (canvas) => canvas.id !== result.run.parent_run_id,
            ),
      };
      const withoutProject = current.filter(
        (project) => project.id !== result.project.id,
      );
      return [projectWithRun, ...withoutProject].sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
    });
  }

  function appendStreamLog(message: string) {
    setStreamLogs((current) => [...current, makeStatusLog(message)].slice(-80));
  }

  function appendToolLog(payload: BuilderAiToolPayload) {
    setStreamLogs((current) => [...current, makeToolLog(payload)].slice(-80));
  }

  useEffect(() => {
    if (
      streamPhase !== "completed" ||
      !streamDrawerOpen ||
      streamAutoClosedRef.current
    )
      return;
    const timeout = window.setTimeout(() => {
      streamAutoClosedRef.current = true;
      setStreamDrawerOpen(false);
    }, 1200);
    return () => window.clearTimeout(timeout);
  }, [streamPhase, streamDrawerOpen]);

  async function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > 750_000) {
      setError("File is too large for the dev MVP limit.");
      return;
    }
    const text = await file.text();
    setUploadedName(file.name);
    setDocument(text);
    setDraftDirty(true);
    setWorkspaceView("preview");
    setStatus(`Loaded ${file.name}. Save this draft before deploying it.`);
  }

  async function handleSaveManualProject() {
    if (!user || !draftDirty || !document.trim()) return;
    await runBusy("Saving uploaded document as a new project...", async () => {
      const authToken = await user.getAuthToken();
      const result = await createManualProject(authToken, {
        document,
        title: uploadedName?.replace(/\.html?$/i, ""),
        links: linkValidation.links,
      });
      await refreshProjects();
      selectRun(result.run);
      setStatus(
        "Manual project saved. Preview, revise, download, or deploy this run.",
      );
    });
  }

  async function handleCreateDefaultProject() {
    if (!user) return;
    await runBusy("Creating default linktree...", async () => {
      const authToken = await user.getAuthToken();
      const result = await createManualProject(authToken, {
        title: "My Linktree",
        document: STARTER_DOCUMENT,
        links: DEFAULT_LINKS,
      });
      await refreshProjects();
      selectRun(result.run);
      setWorkspaceView("preview");
      setTab("ai");
      setStatus("Default linktree created.");
    });
  }

  async function handleCreateBlankDraft() {
    if (!user || isBusy || isAiStreaming) return;
    if (
      draftDirty &&
      !window.confirm(
        "Discard unsaved changes and create a saved blank project?",
      )
    )
      return;
    await runBusy("Creating blank project...", async () => {
      const authToken = await user.getAuthToken();
      const result = await createBlankProject(authToken, {
        title: "Blank project",
      });
      await refreshProjects();
      beginEditingRun(result.run, false);
      setStatus(
        "Blank project created. Use AI or edit the source to build from an empty page.",
      );
    });
  }

  async function handleAddBlankCanvas(project: BuilderProject) {
    if (!user || isBusy || isAiStreaming) return;
    if (
      draftDirty &&
      !window.confirm("Discard unsaved changes and add a blank canvas?")
    )
      return;
    await runBusy("Adding blank canvas...", async () => {
      const authToken = await user.getAuthToken();
      const result = await createBlankRun(authToken, project.id);
      await refreshProjects();
      beginEditingRun(result.run, false);
      setStatus(
        "Blank canvas added. Upload HTML or write a prompt to build the next run.",
      );
    });
  }

  async function handleSaveManualChild() {
    if (!user || !selectedRun || !draftDirty || !document.trim()) return;
    await runBusy("Saving as the newest run...", async () => {
      const authToken = await user.getAuthToken();
      const result = await saveVersion(authToken, {
        runId: selectedRun.id,
        document,
        links: linkValidation.links,
      });
      await refreshProjects();
      selectRun(result.run);
      setStatus("Saved as the newest run.");
    });
  }

  // Pair the run's saved links with the edited links by index; for any whose URL
  // changed, produce an old->new replacement to apply to the page HTML on save.
  function linkReplacements() {
    if (!selectedRun) return [] as { label: string; from: string; to: string }[];
    const oldLinks = selectedRun.links ?? [];
    const out: { label: string; from: string; to: string }[] = [];
    const count = Math.min(oldLinks.length, links.length);
    for (let i = 0; i < count; i++) {
      const oldUrl = (oldLinks[i]?.url ?? "").trim();
      const newUrl = normalizeLinkUrl(links[i]?.url ?? "");
      const name = links[i]?.label || oldLinks[i]?.label || newUrl;
      if (oldUrl && newUrl && oldUrl !== newUrl) {
        // 1) the href, 2) the visible handle/domain the page shows
        out.push({ label: name, from: oldUrl, to: newUrl });
        const oldShown = linkDisplay(oldUrl);
        const newShown = linkDisplay(newUrl);
        if (oldShown && newShown && oldShown !== newShown && oldShown.length >= 3) {
          out.push({ label: `${name} (shown)`, from: oldShown, to: newShown });
        }
      }
      // 3) the visible label text, if it was changed
      const oldLabel = (oldLinks[i]?.label ?? "").trim();
      const newLabel = (links[i]?.label ?? "").trim();
      if (oldLabel && newLabel && oldLabel !== newLabel && oldLabel.length >= 2) {
        out.push({ label: `${name} (label)`, from: oldLabel, to: newLabel });
      }
    }
    return out;
  }

  function handleSaveEdits() {
    if (
      !selectedRun ||
      selectedRunIsSeed ||
      !draftDirty ||
      !document.trim() ||
      Boolean(linkValidation.error) ||
      isBusy
    )
      return;
    const linksChanged =
      JSON.stringify(linkValidation.links) !==
      JSON.stringify(selectedRun.links ?? []);
    if (linksChanged) {
      setPendingReplacements(linkReplacements());
      setSaveConfirmOpen(true);
    } else {
      void saveEditsAsRun([]);
    }
  }

  async function saveEditsAsRun(replacements: { from: string; to: string }[]) {
    if (!user || !selectedRun) return;
    await runBusy("Saving as a new run...", async () => {
      const authToken = await user.getAuthToken();
      let nextDocument = document;
      for (const { from, to } of replacements) {
        nextDocument = nextDocument.split(from).join(to);
      }
      const result = await saveVersion(authToken, {
        runId: selectedRun.id,
        document: nextDocument,
        links: linkValidation.links,
      });
      await refreshProjects();
      selectRun(result.run);
      setStatus("Saved as a new run.");
    });
  }

  async function handleCloneProject() {
    if (
      !user ||
      !selectedRun ||
      selectedRun.is_seed ||
      draftDirty ||
      selectedRun.status !== "completed"
    )
      return;
    await runBusy("Cloning project from selected run...", async () => {
      const authToken = await user.getAuthToken();
      const result = await cloneProject(authToken, selectedRun.id);
      await refreshProjects();
      selectRun(result.run);
      setStatus("Project cloned from the selected run.");
    });
  }

  async function handleRenameProject(project: BuilderProject, title: string) {
    if (!user || isBusy || isAiStreaming) return;
    const nextTitle = title.trim().replace(/\s+/g, " ");
    if (!nextTitle || nextTitle === project.title) return;
    await runBusy("Renaming project...", async () => {
      const authToken = await user.getAuthToken();
      const updated = await renameProject(authToken, {
        projectId: project.id,
        title: nextTitle,
      });
      setProjects((current) =>
        current.map((candidate) =>
          candidate.id === updated.id
            ? {
                ...candidate,
                title: updated.title,
                updated_at: updated.updated_at,
              }
            : candidate,
        ),
      );
      setStatus("Project renamed.");
    });
  }

  function handleSelectRun(run: BuilderRun) {
    if (isBusy || isAiStreaming) return;
    if (isEditingPrompt && run.id === selectedRunId) return;
    if (
      draftDirty &&
      !window.confirm("Discard unsaved changes and load this run?")
    )
      return;
    if (
      isEditingPrompt &&
      prompt.trim() &&
      run.id !== selectedRunId &&
      !window.confirm("Discard the current unsaved prompt and load this run?")
    )
      return;
    selectRun(run);
  }

  function handleEditRun(run: BuilderRun) {
    beginEditingRun(run);
  }

  function handleOpenRunTrace(run: BuilderRun) {
    if (isBusy || isAiStreaming) return;
    if (
      draftDirty &&
      !window.confirm("Discard unsaved changes and load this run?")
    )
      return;
    if (
      isEditingPrompt &&
      prompt.trim() &&
      !window.confirm(
        "Discard the current unsaved prompt and open this run's tool calls?",
      )
    )
      return;
    setStreamLogs([]);
    setStreamPhase("idle");
    setStreamError(null);
    setStreamHtmlOutput("");
    setStreamHtmlOutputEnabled(false);
    setTraceDrawerRequested(true);
    setStreamDrawerOpen(true);
    selectRun(run, false);
    setStatus(`Loaded saved tool calls for ${versionLabel(run)}.`);
  }

  async function handleDeleteProject(project: BuilderProject) {
    if (!user || isBusy || isAiStreaming) return;
    if (!window.confirm(`Delete "${project.title}" and all runs?`)) return;
    await runBusy("Deleting project...", async () => {
      const authToken = await user.getAuthToken();
      await deleteProject(authToken, project.id);
      const nextProjects = await listProjects(authToken);
      setProjects(nextProjects);
      const nextRun = latestRun(nextProjects[0]);
      if (nextRun) selectRun(nextRun, false);
      else resetToDefaultDraft();
      setStatus("Project deleted.");
    });
  }

  async function handleDeleteRun(run: BuilderRun) {
    if (!user || isBusy || isAiStreaming) return;
    if (allProjectRuns(projects).some((candidate) => candidate.parent_run_id === run.id)) {
      window.alert("This run has later versions. Delete those first.");
      return;
    }
    if (!window.confirm("Delete this run?")) return;
    await runBusy("Deleting run...", async () => {
      const authToken = await user.getAuthToken();
      await deleteRun(authToken, run.id);
      const nextProjects = await listProjects(authToken);
      setProjects(nextProjects);
      const currentStillExists =
        selectedRunId && hasSelectableRun(nextProjects, selectedRunId);
      const replacement = currentStillExists
        ? allProjectRuns(nextProjects).find(
            (candidate) => candidate.id === selectedRunId,
          )
        : (latestRun(
            nextProjects.find((project) => project.id === run.project_id),
          ) ?? latestRun(nextProjects[0]));
      if (replacement) selectRun(replacement, false);
      else resetToDefaultDraft();
      setStatus("Run deleted.");
    });
  }

  async function handleDeploy() {
    if (!user || !selectedRunId) return;
    if (selectedRun?.is_seed) {
      setError("Create a saved run before deploying this blank project.");
      return;
    }
    if (selectedRun?.status !== "completed") {
      setError("Wait for this run to finish before deploying.");
      return;
    }
    if (draftDirty) {
      setError(
        "Save the current draft before deploying. Deploy publishes the selected saved run.",
      );
      return;
    }
    if (!profile?.subdomain) {
      setError("Register a subdomain before deploying.");
      return;
    }
    const subdomain = profile.subdomain;
    await runBusy(
      `Deploying selected run to ${subdomain}.linkqt.me...`,
      async () => {
        const authToken = await user.getAuthToken();
        const deployment = await deployRun(authToken, selectedRunId);
        setProjects((current) =>
          markDeployedRun(current, deployment.run_id, deployment.deployed_at),
        );
        setStatus(
          `Deployed. Open ${publicSiteUrl(subdomain)} to view the live page.`,
        );
      },
    );
  }

  async function handleDeployAndOpen() {
    if (!user || !selectedRunId) return;
    if (selectedRun?.is_seed) {
      setError("Create a saved run before deploying this blank project.");
      return;
    }
    if (selectedRun?.status !== "completed") {
      setError("Wait for this run to finish before deploying.");
      return;
    }
    if (draftDirty) {
      setError(
        "Save the current draft before deploying. Deploy publishes the selected saved run.",
      );
      return;
    }
    if (!profile?.subdomain) {
      setError("Register a subdomain before deploying.");
      return;
    }
    const subdomain = profile.subdomain;
    const liveUrl = publicSiteUrl(subdomain);
    // Open the tab synchronously inside the click gesture so the browser doesn't block it
    // after the async deploy; navigate it on success, close it on failure.
    const liveTab =
      typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    if (liveTab) liveTab.opener = null;
    await runBusy(
      `Deploying selected run to ${subdomain}.linkqt.me...`,
      async () => {
        try {
          const authToken = await user.getAuthToken();
          const deployment = await deployRun(authToken, selectedRunId);
          setProjects((current) =>
            markDeployedRun(current, deployment.run_id, deployment.deployed_at),
          );
          setStatus(`Deployed. Opening ${liveUrl} ...`);
          if (liveTab) liveTab.location.href = liveUrl;
          else if (typeof window !== "undefined")
            window.open(liveUrl, "_blank", "noopener,noreferrer");
        } catch (cause) {
          liveTab?.close();
          throw cause;
        }
      },
    );
  }

  async function runBusy(label: string, task: () => Promise<void>) {
    setIsBusy(true);
    setError(null);
    setStatus(label);
    try {
      await task();
    } catch (cause) {
      setError(errorMessage(cause));
      setStatus(null);
    } finally {
      setIsBusy(false);
    }
  }

  function selectRun(run: BuilderRun, announce = true) {
    setSelectedRunId(run.id);
    // A blank canvas (seed) has nothing to "view" — selecting one always means
    // editing it, so edit mode survives reload/auto-select instead of going read-only.
    setEditingBaseRunId(run.is_seed ? run.id : null);
    setPrompt("");
    setDocument(run.document);
    setLinks(run.links ?? []);
    setDraftDirty(false);
    setFormatState("idle");
    if (announce) {
      if (run.is_seed) {
        setStatus(
          "Loaded a blank canvas. Upload HTML or write a prompt to build the first run.",
        );
        setError(null);
        return;
      }
      setStatus(
        run.status === "pending"
          ? "This run is still generating."
          : run.status === "failed"
            ? "This run failed before completion."
            : null,
      );
    }
    setError(null);
  }

  function resetToDefaultDraft() {
    setSelectedRunId(null);
    setEditingBaseRunId(null);
    setPrompt("");
    setDocument("");
    setLinks(DEFAULT_LINKS);
    setUploadedName(null);
    setDraftDirty(false);
    setWorkspaceView("preview");
    setError(null);
  }

  function updateDocument(value: string) {
    setDocument(value);
    setDraftDirty(value !== (selectedRun?.document ?? ""));
    setFormatState("idle");
  }

  async function handleFormatDocument() {
    if (!document.trim() || formatState === "formatting") return;
    setFormatState("formatting");
    try {
      const { format, plugins } = await loadPrettier();
      const formatted = await format(document, {
        parser: "html",
        plugins,
        printWidth: 100,
        tabWidth: 2,
        htmlWhitespaceSensitivity: "css",
      });
      updateDocument(formatted.replace(/\n$/, ""));
    } catch {
      setFormatState("error");
    }
  }

  function beginEditingRun(run: BuilderRun, confirmDiscard = true) {
    if (isBusy || isAiStreaming) return;
    if (isEditingPrompt && run.id === editingBaseRunId) {
      setTab("ai");
      return;
    }
    if (run.status !== "completed") {
      setError("Select a completed run before starting a new AI prompt.");
      return;
    }
    if (
      confirmDiscard &&
      draftDirty &&
      !window.confirm("Discard unsaved changes and edit from this saved run?")
    )
      return;
    if (
      confirmDiscard &&
      isEditingPrompt &&
      prompt.trim() &&
      run.id !== editingBaseRunId &&
      !window.confirm(
        "Discard the current unsaved prompt and edit from this run?",
      )
    )
      return;
    selectRun(run, false);
    setEditingBaseRunId(run.id);
    setPrompt("");
    setUploadedName(null);
    setTab("ai");
    setWorkspaceView("preview");
    setStatus(
      run.is_seed
        ? "Editing from a blank canvas. Save creates the first run."
        : `Editing from ${versionLabel(run)}. Save creates a new run.`,
    );
    setError(null);
  }

  function updateLink(index: number, field: keyof BuilderLink, value: string) {
    setLinks((current) =>
      current.map((link, linkIndex) =>
        linkIndex === index ? { ...link, [field]: value } : link,
      ),
    );
    setDraftDirty(true);
  }

  function addLink() {
    setLinks((current) => [...current, { label: "", url: "" }]);
    setDraftDirty(true);
  }

  function removeLink(index: number) {
    setLinks((current) =>
      current.filter((_, linkIndex) => linkIndex !== index),
    );
    setDraftDirty(true);
  }

  function downloadDocument() {
    if (!selectedRun || selectedRun.is_seed) return;
    const blob = new Blob([document], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = selectedRun
      ? `linkqt-${selectedRun.id}.html`
      : "linkqt-document.html";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (authLoading)
    return (
      <CenteredCard title="Loading admin" detail="Checking your session." />
    );

  if (!user) {
    return (
      <CenteredCard
        title="Admin sign-in"
        detail="Use Google to open the LinkQT builder."
      >
        {error && <Alert tone="error">{error}</Alert>}
        <a
          href="/auth?next=/admin"
          className={`inline-flex rounded-full bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 ${focusRing}`}
        >
          Sign in with Google
        </a>
      </CenteredCard>
    );
  }

  if (profileLoading && !profile)
    return (
      <CenteredCard
        title="Loading profile"
        detail="Checking your LinkQT registration."
      />
    );

  if (!profile?.registration_complete) {
    return (
      <CenteredCard
        title="Choose your subdomain"
        detail="Reserve the LinkQT address where your published page will live."
      >
        <form
          onSubmit={handleRegisterSubdomain}
          className="space-y-4 text-left"
        >
          {error && <Alert tone="error">{error}</Alert>}
          {status && <Alert tone="info">{status}</Alert>}
          <label
            className="block text-sm font-semibold text-neutral-800 dark:text-neutral-200"
            htmlFor="subdomain"
          >
            Subdomain
          </label>
          <div className="flex items-center rounded-2xl border border-line bg-surface px-4 py-3 shadow-sm focus-within:border-neutral-500">
            <input
              id="subdomain"
              value={subdomainDraft}
              onChange={(event) =>
                setSubdomainDraft(event.target.value.toLowerCase())
              }
              placeholder="yourname"
              className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <span className="shrink-0 text-sm text-muted">
              .linkqt.me
            </span>
          </div>
          <button
            disabled={!subdomainDraft.trim() || profileLoading}
            className={`w-full rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-200 dark:disabled:bg-indigo-900/40 ${focusRing}`}
          >
            {profileLoading ? "Reserving..." : "Reserve subdomain"}
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            className={`w-full rounded-2xl border border-line bg-surface px-4 py-3 text-sm font-semibold transition hover:bg-surface-muted ${focusRing}`}
          >
            Sign out
          </button>
        </form>
      </CenteredCard>
    );
  }
  const registeredSubdomain = profile.subdomain!;

  return (
    <main className="min-h-screen px-4 py-4 text-neutral-950 dark:text-neutral-50 sm:px-6 sm:py-6 xl:h-dvh xl:min-h-0 xl:overflow-hidden">
      <div className="mx-auto flex max-w-[98rem] flex-col gap-4 xl:h-full xl:min-h-0">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-[2rem] border border-line bg-surface/85 px-5 py-4 shadow-sm backdrop-blur-xl xl:shrink-0">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              LinkQT Admin
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Build {registeredSubdomain}.linkqt.me
            </h1>
            <p className="mt-1 text-xs text-muted">
              {selectedProject
                ? selectedProject.title
                : "No saved run selected"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <button
              onClick={downloadDocument}
              disabled={!selectedRun || selectedRunIsSeed}
              title={
                selectedRunIsSeed
                  ? "Create a saved run before downloading."
                  : undefined
              }
              className={`rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-neutral-300 dark:disabled:text-neutral-500 ${focusRing}`}
            >
              Download
            </button>
            <button
              onClick={handleDeploy}
              disabled={
                !selectedRunId ||
                selectedRunIsSeed ||
                isBusy ||
                draftDirty ||
                selectedRun?.status !== "completed"
              }
              title={
                selectedRunIsSeed
                  ? "Create a saved run before deploying."
                  : draftDirty
                    ? "Save this draft before deploying."
                    : selectedRun?.status && selectedRun.status !== "completed"
                      ? "Wait for this run to finish before deploying."
                      : undefined
              }
              className={`rounded-full bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-200 dark:disabled:bg-indigo-900/40 ${focusRing}`}
            >
              Deploy
            </button>
            <Link
              href="/admin/settings"
              aria-label="Settings"
              title="Settings"
              className={`grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface text-neutral-700 dark:text-neutral-300 transition hover:bg-surface-muted ${focusRing}`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </Link>
            <button
              onClick={handleSignOut}
              className={`rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium transition hover:bg-surface-muted ${focusRing}`}
            >
              Sign out
            </button>
          </div>
        </header>

        <div className="grid gap-4 xl:flex xl:min-h-0 xl:flex-1 xl:overflow-hidden">
          <div
            className={`xl:flex xl:h-full xl:justify-end xl:overflow-hidden xl:shrink-0 xl:transition-[width] xl:duration-500 xl:ease-[cubic-bezier(.22,1,.36,1)] ${reserveStreamDrawer ? "xl:w-0" : "xl:w-[24rem]"}`}
          >
            <aside className="rounded-[2rem] border border-line bg-surface/85 p-4 shadow-sm backdrop-blur-xl xl:flex xl:h-full xl:w-[24rem] xl:shrink-0 xl:flex-col xl:min-h-0 xl:overflow-hidden">
              <div className="mb-4 flex items-center justify-between gap-3 xl:shrink-0">
                <div>
                  <h2 className="font-semibold tracking-tight">Projects</h2>
                  <p className="text-xs text-muted">
                    Saved pages and run history.
                  </p>
                </div>
                <button
                  onClick={() => refreshProjects()}
                  disabled={projectsLoading}
                  className={`rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium disabled:cursor-wait disabled:text-neutral-400 dark:disabled:text-neutral-500 ${focusRing}`}
                >
                  {projectsLoading ? "Loading" : "Refresh"}
                </button>
              </div>
              <div className="mb-4 rounded-2xl border border-line bg-surface/70 p-1.5 xl:shrink-0">
                <div className="grid grid-cols-3 gap-1.5">
                  <SidebarAction
                    label="Clone"
                    detail="copy"
                    onClick={handleCloneProject}
                    disabled={
                      !selectedRun ||
                      selectedRunIsSeed ||
                      selectedRun.status !== "completed" ||
                      isBusy ||
                      isAiStreaming ||
                      draftDirty
                    }
                    title={
                      selectedRunIsSeed
                        ? "Create a saved run before cloning."
                        : draftDirty
                          ? "Save or discard the draft before cloning."
                          : selectedRun?.status &&
                              selectedRun.status !== "completed"
                            ? "Wait for this run to finish before cloning."
                            : undefined
                    }
                    primary
                  />
                  <SidebarAction
                    label="Default"
                    detail="starter"
                    onClick={handleCreateDefaultProject}
                    disabled={isBusy || isAiStreaming}
                  />
                  <SidebarAction
                    label="Blank"
                    detail="draft"
                    onClick={handleCreateBlankDraft}
                    disabled={isBusy || isAiStreaming}
                  />
                </div>
              </div>
              <div className="max-h-[72vh] space-y-3 overflow-y-auto pr-1 xl:max-h-none xl:min-h-0 xl:flex-1">
                {projectsLoading && projects.length === 0 && (
                  <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
                    Loading saved projects...
                  </p>
                )}
                {!projectsLoading && projects.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
                    <p>
                      No projects yet. Start with the default Linktree, a blank
                      draft, or upload an HTML document.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={() => setTab("ai")}
                        className={`rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-neutral-950 dark:text-neutral-50 ${focusRing}`}
                      >
                        Edit prompt
                      </button>
                      <button
                        onClick={() => setTab("manual")}
                        className={`rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-neutral-950 dark:text-neutral-50 ${focusRing}`}
                      >
                        Upload HTML
                      </button>
                    </div>
                  </div>
                )}
                {projects.map((project) => (
                  <ProjectVersions
                    key={project.id}
                    project={project}
                    selectedRunId={selectedRunId}
                    onSelect={handleSelectRun}
                    onEditRun={handleEditRun}
                    onOpenTrace={handleOpenRunTrace}
                    onRenameProject={handleRenameProject}
                    onDeleteProject={handleDeleteProject}
                    onDeleteRun={handleDeleteRun}
                    onAddBlankCanvas={handleAddBlankCanvas}
                    disabled={isBusy || isAiStreaming}
                  />
                ))}
              </div>
            </aside>
          </div>

          <section className="grid gap-4 xl:flex-1 xl:min-w-0 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] xl:grid-rows-[minmax(0,1fr)] xl:min-h-0">
            <div className="rounded-[2rem] border border-line bg-surface/85 p-4 shadow-sm backdrop-blur-xl xl:min-h-0 xl:overflow-y-auto">
              <div
                className="mb-4 flex rounded-full bg-black/5 dark:bg-white/10 p-1"
                role="tablist"
                aria-label="Builder mode"
              >
                <TabButton
                  active={activeTab === "ai"}
                  onClick={() => setTab("ai")}
                >
                  AI builder
                </TabButton>
                {canUploadHtml && (
                  <TabButton
                    active={activeTab === "manual"}
                    onClick={() => setTab("manual")}
                  >
                    Upload HTML
                  </TabButton>
                )}
              </div>

              {activeTab === "ai" ? (
                <form className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <label className="block text-sm font-semibold">
                      {isEditingPrompt ? "New prompt" : "Saved prompt"}
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setLinksModalOpen(true)}
                        title="Approved links"
                        aria-label="Open approved links"
                        className={`relative grid size-8 place-items-center rounded-full border border-line bg-surface text-neutral-600 dark:text-neutral-300 transition hover:border-indigo-200 dark:hover:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-700 dark:hover:text-indigo-300 ${focusRing}`}
                      >
                        <GearIcon />
                        {linkValidation.error ? (
                          <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-red-500 ring-2 ring-white" />
                        ) : links.length > 0 ? (
                          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-indigo-600 px-1 text-[9px] font-bold leading-none text-white ring-2 ring-white">
                            {links.length}
                          </span>
                        ) : null}
                      </button>
                      {selectedRun && (
                        <span className="rounded-full bg-black/5 dark:bg-white/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
                          {isEditingPrompt ? "Editing" : "Viewing"}
                        </span>
                      )}
                    </div>
                  </div>
                  <textarea
                    value={promptInputValue}
                    onChange={(event) => setPrompt(event.target.value)}
                    rows={8}
                    disabled={aiControlsDisabled && !canEditSelectedRun}
                    readOnly={canEditSelectedRun}
                    onMouseDown={
                      canEditSelectedRun
                        ? (event) => {
                            event.preventDefault();
                            setEditConfirmOpen(true);
                          }
                        : undefined
                    }
                    className={`w-full resize-none rounded-2xl border border-line p-4 text-sm leading-6 outline-none focus:border-neutral-500 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-neutral-700 dark:disabled:text-neutral-300 ${focusRing} ${canEditSelectedRun ? "cursor-pointer bg-surface hover:border-indigo-300 dark:hover:border-indigo-700" : aiControlsDisabled ? "bg-surface-muted" : "bg-surface"}`}
                    placeholder={promptPlaceholder}
                  />
                  {isEditingPrompt && aiPromptBlockedReason && (
                    <p className="rounded-2xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
                      {aiPromptBlockedReason}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={
                      canEditSelectedRun
                        ? () => setEditConfirmOpen(true)
                        : handleRevise
                    }
                    disabled={
                      canEditSelectedRun
                        ? false
                        : !isEditingPrompt ||
                          !prompt.trim() ||
                          Boolean(linkValidation.error) ||
                          Boolean(aiPromptBlockedReason)
                    }
                    title={
                      canEditSelectedRun
                        ? "Edit this run to write a new prompt."
                        : !isEditingPrompt
                          ? "Click Edit on a run to write a new prompt."
                          : linkValidation.error
                            ? "Fix the approved links (gear icon) before running."
                            : (aiPromptBlockedReason ?? undefined)
                    }
                    className={`w-full rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-200 dark:disabled:bg-indigo-900/40 ${focusRing}`}
                  >
                    Run
                  </button>
                </form>
              ) : (
                <div className="space-y-3">
                  <label className="block text-sm font-semibold">
                    Upload a full HTML document
                  </label>
                  <label
                    className={`flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface/70 p-5 text-center transition hover:bg-surface ${focusRing}`}
                  >
                    <span className="text-sm font-semibold">
                      Drop or select an .html file
                    </span>
                    <span className="mt-1 text-xs text-muted">
                      Current file: {uploadedName ?? "none"}
                    </span>
                    <input
                      type="file"
                      accept=".html,.htm,text/html"
                      onChange={handleFileUpload}
                      className="sr-only"
                    />
                  </label>
                  <div className="rounded-2xl border border-line bg-surface/70 p-3 text-xs leading-5 text-muted">
                    Uploaded or pasted HTML previews immediately. Save it before
                    deploying.
                  </div>
                  <button
                    onClick={
                      selectedRun ? handleSaveManualChild : handleSaveManualProject
                    }
                    disabled={
                      !draftDirty ||
                      !document.trim() ||
                      Boolean(linkValidation.error) ||
                      isBusy
                    }
                    className={`w-full rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-200 dark:disabled:bg-indigo-900/40 ${focusRing}`}
                  >
                    Save
                  </button>
                </div>
              )}
            </div>

            <div className="rounded-[2rem] border border-line bg-surface/85 p-4 shadow-sm backdrop-blur-xl xl:flex xl:flex-col xl:min-h-0">
              <div className="mb-3 flex items-center justify-between gap-3 xl:shrink-0">
                <div>
                  <h2 className="font-semibold tracking-tight">Workspace</h2>
                  <p className="text-xs text-muted">
                    {draftDirty
                      ? "Unsaved draft. Save before deploying."
                      : "Selected saved run."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {workspaceView === "source" && (
                    <div className="flex items-center gap-1.5">
                      {formatState === "error" && (
                        <span className="text-[11px] font-medium text-red-600 dark:text-red-300">
                          Couldn&apos;t format
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={handleFormatDocument}
                        disabled={formatState === "formatting" || !document.trim()}
                        title="Format the HTML with Prettier"
                        className={`rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-neutral-700 dark:text-neutral-300 shadow-sm transition hover:border-indigo-200 dark:hover:border-indigo-800 hover:text-indigo-700 dark:hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
                      >
                        {formatState === "formatting" ? "Formatting…" : "Format"}
                      </button>
                    </div>
                  )}
                  {selectedRun && !selectedRunIsSeed && draftDirty && (
                    <button
                      type="button"
                      onClick={handleSaveEdits}
                      disabled={
                        !document.trim() ||
                        Boolean(linkValidation.error) ||
                        isBusy
                      }
                      title={
                        linkValidation.error
                          ? "Fix the approved links before saving."
                          : "Save these edits as a new run"
                      }
                      className={`rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-200 dark:disabled:bg-indigo-900/40 ${focusRing}`}
                    >
                      Save
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleDeployAndOpen}
                    disabled={
                      !selectedRunId ||
                      selectedRunIsSeed ||
                      isBusy ||
                      draftDirty ||
                      selectedRun?.status !== "completed"
                    }
                    title={
                      selectedRunIsSeed
                        ? "Create a saved run before deploying."
                        : draftDirty
                          ? "Save this draft before deploying."
                          : selectedRun?.status && selectedRun.status !== "completed"
                            ? "Wait for this run to finish before deploying."
                            : "Deploy this run & open the live page"
                    }
                    aria-label="Deploy this run and open the live page"
                    className={`grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface text-neutral-600 dark:text-neutral-300 transition hover:border-indigo-200 dark:hover:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-700 dark:hover:text-indigo-300 disabled:cursor-not-allowed disabled:text-neutral-300 dark:disabled:text-neutral-500 ${focusRing}`}
                  >
                    <PaperPlaneIcon />
                  </button>
                  <div
                    className="flex rounded-full bg-black/5 dark:bg-white/10 p-1"
                    role="tablist"
                    aria-label="Document view"
                  >
                    <TabButton
                      active={workspaceView === "preview"}
                      onClick={() => setWorkspaceView("preview")}
                    >
                      Preview
                    </TabButton>
                    <TabButton
                      active={workspaceView === "source"}
                      onClick={() => setWorkspaceView("source")}
                    >
                      Source
                    </TabButton>
                  </div>
                </div>
              </div>
              {workspaceView === "preview" ? (
                <iframe
                  key={`preview-${selectedRunId ?? "draft"}`}
                  title="LinkQT document preview"
                  srcDoc={document.trim() ? document : EMPTY_STATE_DOCUMENT}
                  sandbox="allow-scripts allow-forms allow-popups"
                  className="h-[52vh] w-full rounded-2xl border border-line bg-surface sm:h-[64vh] xl:h-auto xl:min-h-0 xl:flex-1"
                />
              ) : (
                <SourceEditor
                  value={document}
                  onChange={updateDocument}
                  className="h-[52vh] w-full sm:h-[64vh] xl:h-auto xl:min-h-0 xl:flex-1"
                />
              )}
            </div>
          </section>

          {hasStreamActivity && (
            <div
              className={`xl:flex xl:h-full xl:justify-end xl:overflow-hidden xl:shrink-0 xl:transition-[width] xl:duration-500 xl:ease-[cubic-bezier(.22,1,.36,1)] ${reserveStreamDrawer ? "xl:w-[34rem]" : "hidden xl:flex xl:w-0"}`}
            >
              <StreamingDrawer
                title={drawerTitle}
                phase={streamPhase}
                loading={toolTraceLoading && streamPhase === "idle"}
                open={streamDrawerOpen}
                logs={drawerLogs}
                htmlOutput={drawerHtmlOutput}
                showHtmlOutput={
                  streamHtmlOutputEnabled && streamPhase !== "idle"
                }
                error={streamError}
                onClose={() => setStreamDrawerOpen(false)}
              />
            </div>
          )}
        </div>
      </div>
      {hasStreamActivity && !streamDrawerOpen && (
        <button
          type="button"
          onClick={() => setStreamDrawerOpen(true)}
          aria-label="Open AI stream preview"
          className={`fixed right-0 top-1/2 z-40 -translate-y-1/2 rounded-l-2xl border border-r-0 border-line bg-surface/95 px-2 py-5 text-sm font-semibold shadow-lg backdrop-blur-xl transition hover:bg-surface ${focusRing}`}
        >
          ‹
        </button>
      )}
      {editConfirmOpen && selectedRun && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit this run"
          className="fixed inset-0 z-[70] grid place-items-center p-4"
        >
          <button
            type="button"
            aria-label="Cancel"
            onClick={() => setEditConfirmOpen(false)}
            className="absolute inset-0 cursor-default bg-neutral-950/40 backdrop-blur-sm"
          />
          <div className="relative z-10 w-full max-w-md overflow-hidden rounded-[1.75rem] border border-line bg-surface shadow-[0_30px_90px_rgba(0,0,0,0.25)]">
            <div className="px-6 py-5">
              <h2 className="text-base font-semibold tracking-tight">
                Edit this run?
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                Your prompt or edits will create a{" "}
                <span className="font-semibold text-foreground">new run</span>{" "}
                based on{" "}
                <span className="font-semibold text-foreground">
                  {versionLabel(selectedRun)}
                </span>{" "}
                &mdash; the original stays in your history. Prefer a clean slate?
                Use a fresh blank canvas instead.
              </p>
            </div>
            <div className="flex flex-col gap-2 border-t border-line px-6 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setEditConfirmOpen(false)}
                className={`whitespace-nowrap rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium transition hover:bg-surface-muted ${focusRing}`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditConfirmOpen(false);
                  setLinksModalOpen(false);
                  if (selectedProject) handleAddBlankCanvas(selectedProject);
                }}
                className={`whitespace-nowrap rounded-full border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 px-4 py-2 text-sm font-semibold text-indigo-700 dark:text-indigo-300 transition hover:bg-indigo-100 dark:hover:bg-indigo-900/40 ${focusRing}`}
              >
                Use a blank canvas
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditConfirmOpen(false);
                  beginEditingRun(selectedRun, false);
                }}
                className={`whitespace-nowrap rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 ${focusRing}`}
              >
                Edit this run
              </button>
            </div>
          </div>
        </div>
      )}

      {saveConfirmOpen && selectedRun && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Save changes"
          className="fixed inset-0 z-[60] grid place-items-center p-4"
        >
          <button
            type="button"
            aria-label="Cancel"
            onClick={() => setSaveConfirmOpen(false)}
            className="absolute inset-0 cursor-default bg-neutral-950/40 backdrop-blur-sm"
          />
          <div className="relative z-10 w-full max-w-md overflow-hidden rounded-[1.75rem] border border-line bg-surface shadow-[0_30px_90px_rgba(0,0,0,0.25)]">
            <div className="px-6 py-5">
              <h2 className="text-base font-semibold tracking-tight">
                Save changes as a new run?
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                This saves a{" "}
                <span className="font-semibold text-foreground">new run</span>{" "}
                based on{" "}
                <span className="font-semibold text-foreground">
                  {versionLabel(selectedRun)}
                </span>{" "}
                with your updated links &mdash; the original stays in your history.
              </p>
              {pendingReplacements.length > 0 ? (
                <div className="mt-3 rounded-2xl border border-line bg-surface-muted p-3">
                  <p className="text-xs font-semibold text-foreground">
                    These links get find-and-replaced in your page&rsquo;s HTML:
                  </p>
                  <ul className="mt-2 space-y-2">
                    {pendingReplacements.map((replacement, index) => (
                      <li
                        key={index}
                        className="text-[11px] leading-5 text-muted"
                      >
                        <span className="font-semibold text-foreground">
                          {replacement.label}
                        </span>
                        <br />
                        <span className="break-all line-through">
                          {replacement.from}
                        </span>
                        {" → "}
                        <span className="break-all text-indigo-700 dark:text-indigo-300">
                          {replacement.to}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-3 rounded-2xl border border-line bg-surface-muted p-3 text-[11px] leading-5 text-muted">
                  No link URLs in the page HTML changed &mdash; only the approved-links
                  list is updated.
                </p>
              )}
              <p className="mt-3 text-[11px] leading-5 text-muted">
                Only changed URLs of existing links are replaced. Added/removed links
                and visible label text aren&rsquo;t auto-edited &mdash; use Source for
                those.
              </p>
            </div>
            <div className="flex flex-col gap-2 border-t border-line px-6 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setSaveConfirmOpen(false)}
                className={`whitespace-nowrap rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium transition hover:bg-surface-muted ${focusRing}`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setSaveConfirmOpen(false);
                  void saveEditsAsRun(pendingReplacements);
                }}
                className={`whitespace-nowrap rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400 ${focusRing}`}
              >
                Save as new run
              </button>
            </div>
          </div>
        </div>
      )}

      {linksModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Approved links"
          className="fixed inset-0 z-[60] grid place-items-center p-4"
        >
          <button
            type="button"
            aria-label="Close approved links"
            onClick={() => setLinksModalOpen(false)}
            className="absolute inset-0 cursor-default bg-neutral-950/40 backdrop-blur-sm"
          />
          <div className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-[1.75rem] border border-line bg-surface shadow-[0_30px_90px_rgba(0,0,0,0.25)]">
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold tracking-tight">
                  Approved links
                </h2>
                <p className="mt-0.5 text-xs leading-5 text-muted">
                  AI can only use these outbound URLs
                  {aiControlsDisabled
                    ? " — click Edit on a run to change them."
                    : "."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLinksModalOpen(false)}
                aria-label="Close"
                className={`grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface text-lg leading-none transition hover:bg-surface-muted ${focusRing}`}
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <LinkList
                embedded
                links={links}
                error={linkValidation.error}
                disabled={aiControlsDisabled}
                interceptEdit={canEditSelectedRun}
                onEditIntent={() => setEditConfirmOpen(true)}
                onAdd={addLink}
                onRemove={removeLink}
                onUpdate={updateLink}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
              <span className="text-xs text-muted">
                {links.length} approved link{links.length === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                onClick={
                  canSaveEdits
                    ? () => {
                        setLinksModalOpen(false);
                        handleSaveEdits();
                      }
                    : () => setLinksModalOpen(false)
                }
                className={`rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 ${focusRing}`}
              >
                {canSaveEdits ? "Save" : "Done"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function ProjectVersions({
  project,
  selectedRunId,
  onSelect,
  onEditRun,
  onOpenTrace,
  onRenameProject,
  onDeleteProject,
  onDeleteRun,
  onAddBlankCanvas,
  disabled,
}: {
  project: BuilderProject;
  selectedRunId: string | null;
  onSelect: (run: BuilderRun) => void;
  onEditRun: (run: BuilderRun) => void;
  onOpenTrace: (run: BuilderRun) => void;
  onRenameProject: (project: BuilderProject, title: string) => Promise<void>;
  onDeleteProject: (project: BuilderProject) => void;
  onDeleteRun: (run: BuilderRun) => void;
  onAddBlankCanvas: (project: BuilderProject) => void;
  disabled: boolean;
}) {
  const versions = project.runs
    .filter((run) => !isSeedRun(run))
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  const openCanvases = (project.open_canvases ?? [])
    .slice()
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  const totalRuns = versions.length + openCanvases.length;
  const deployedRunId = project.deployed_run_id ?? null;
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(project.title);

  async function commitTitle() {
    const nextTitle = titleDraft.trim().replace(/\s+/g, " ");
    setEditingTitle(false);
    setTitleDraft(nextTitle || project.title);
    if (nextTitle && nextTitle !== project.title)
      await onRenameProject(project, nextTitle);
  }

  function cancelTitleEdit() {
    setEditingTitle(false);
    setTitleDraft(project.title);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface/80 shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-3">
        <div className="min-w-0">
          {editingTitle ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void commitTitle();
              }}
            >
              <input
                autoFocus
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") cancelTitleEdit();
                }}
                maxLength={80}
                className={`w-full min-w-0 rounded-lg border border-line bg-surface px-2 py-1 text-sm font-semibold outline-none focus:border-neutral-500 ${focusRing}`}
              />
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (!disabled) {
                  setTitleDraft(project.title);
                  setEditingTitle(true);
                }
              }}
              disabled={disabled}
              title="Rename project"
              className={`block max-w-full truncate rounded-md text-left text-sm font-semibold transition hover:text-indigo-700 dark:hover:text-indigo-300 disabled:cursor-not-allowed ${focusRing}`}
            >
              {project.title}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {deployedRunId && (
            <span
              title={
                project.deployed_at
                  ? `Deployed ${new Date(project.deployed_at).toLocaleString()}`
                  : "Deployed live"
              }
              className="rounded-full border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300"
            >
              Live
            </span>
          )}
          {!editingTitle && (
            <button
              type="button"
              onClick={() => {
                if (!disabled) {
                  setTitleDraft(project.title);
                  setEditingTitle(true);
                }
              }}
              disabled={disabled}
              className={`rounded-full border border-line bg-surface px-2 py-1 text-[10px] font-semibold text-muted transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-neutral-300 dark:disabled:text-neutral-500 ${focusRing}`}
            >
              Edit
            </button>
          )}
          <span className="rounded-full bg-black/5 dark:bg-white/10 px-2 py-1 text-[11px] font-semibold text-muted">
            {versions.length}
          </span>
          <button
            type="button"
            onClick={() => onDeleteProject(project)}
            disabled={disabled}
            aria-label={`Delete ${project.title}`}
            className={`grid size-7 place-items-center rounded-full border border-line bg-surface text-xs font-semibold text-red-600 dark:text-red-300 transition hover:border-red-200 dark:hover:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:text-neutral-300 dark:disabled:text-neutral-500 ${focusRing}`}
          >
            ×
          </button>
        </div>
      </div>
      <div>
        {totalRuns === 0 && (
          <p className="px-3 py-4 text-sm text-muted">No saved runs.</p>
        )}
        {versions.map((run, index) => (
          <VersionRow
            key={run.id}
            run={run}
            index={index}
            selectedRunId={selectedRunId}
            onSelect={onSelect}
            onEditRun={onEditRun}
            onOpenTrace={onOpenTrace}
            onDelete={onDeleteRun}
            disabled={disabled}
            canDelete={versions.length > 1 && !versions.some((candidate) => candidate.parent_run_id === run.id)}
            isLast={index === versions.length - 1}
            isDeployed={run.id === deployedRunId}
            deployedAt={
              run.id === deployedRunId ? (project.deployed_at ?? null) : null
            }
          />
        ))}
        {openCanvases.map((run) => (
          <SeedRunRow
            key={run.id}
            run={run}
            selectedRunId={selectedRunId}
            onSelect={onSelect}
            onEditRun={onEditRun}
            onDelete={onDeleteRun}
            disabled={disabled}
            canDelete={totalRuns > 1}
          />
        ))}
        <div className="px-3 py-2">
          <button
            type="button"
            onClick={() => onAddBlankCanvas(project)}
            disabled={disabled}
            className={`flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-indigo-200 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-950/40 px-3 py-2 text-xs font-semibold text-indigo-700 dark:text-indigo-300 transition hover:border-indigo-300 dark:hover:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
          >
            + Blank canvas
          </button>
        </div>
      </div>
    </div>
  );
}

function SeedRunRow({
  run,
  selectedRunId,
  onSelect,
  onEditRun,
  onDelete,
  disabled,
  canDelete,
}: {
  run: BuilderRun;
  selectedRunId: string | null;
  onSelect: (run: BuilderRun) => void;
  onEditRun: (run: BuilderRun) => void;
  onDelete: (run: BuilderRun) => void;
  disabled: boolean;
  canDelete: boolean;
}) {
  const selected = run.id === selectedRunId;
  return (
    <article
      onClick={() => {
        if (!disabled) onSelect(run);
      }}
      className={`relative px-3 py-3 transition ${disabled ? "" : "cursor-pointer"} ${selected ? "bg-indigo-50 dark:bg-indigo-950/40" : "bg-surface/40"}`}
    >
      {selected && (
        <span className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-indigo-600" />
      )}
      <div
        className={`rounded-xl border border-dashed px-3 py-3 transition ${selected ? "border-indigo-300 dark:border-indigo-800 bg-surface" : "border-line bg-surface/70"}`}
      >
        <button
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(run);
          }}
          className={`block w-full text-left transition disabled:cursor-not-allowed disabled:opacity-70 ${focusRing}`}
        >
          <span
            className={`text-[10px] font-bold uppercase tracking-[0.18em] ${selected ? "text-indigo-500" : "text-muted"}`}
          >
            Empty canvas
          </span>
          <p
            className={`mt-1 text-sm font-medium ${selected ? "text-indigo-950 dark:text-indigo-100" : "text-neutral-950 dark:text-neutral-50"}`}
          >
            Ready — upload HTML or write a prompt
          </p>
          <p
            className={`mt-1 text-[11px] ${selected ? "text-indigo-700/70 dark:text-indigo-300/70" : "text-muted"}`}
          >
            {new Date(run.created_at).toLocaleString()}
          </p>
        </button>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onEditRun(run);
            }}
            disabled={disabled}
            className={`rounded-full border border-line bg-surface px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-700 dark:text-neutral-300 shadow-sm transition hover:border-indigo-200 dark:hover:border-indigo-800 hover:text-indigo-700 dark:hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(run);
            }}
            disabled={disabled || !canDelete}
            aria-label="Delete empty canvas"
            className={`grid size-7 place-items-center rounded-full border border-line bg-surface text-xs font-semibold text-red-600 dark:text-red-300 transition hover:border-red-200 dark:hover:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-35 ${focusRing}`}
          >
            ×
          </button>
        </div>
      </div>
    </article>
  );
}

function SidebarAction({
  label,
  detail,
  onClick,
  disabled,
  title,
  primary = false,
}: {
  label: string;
  detail: string;
  onClick: () => void;
  disabled: boolean;
  title?: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`min-w-0 rounded-xl px-2 py-2.5 text-center transition disabled:cursor-not-allowed ${focusRing} ${primary ? "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-200 dark:disabled:bg-indigo-900/40" : "bg-surface text-neutral-950 dark:text-neutral-50 shadow-sm ring-1 ring-line hover:bg-surface-muted disabled:text-neutral-300 dark:disabled:text-neutral-500 disabled:ring-line"}`}
    >
      <span className="block truncate text-xs font-semibold">{label}</span>
      <span
        className={`mt-0.5 block truncate text-[10px] font-semibold uppercase tracking-[0.12em] ${primary ? "text-white/55" : "text-neutral-400 dark:text-neutral-500"}`}
      >
        {detail}
      </span>
    </button>
  );
}

function LinkList({
  links,
  error,
  disabled,
  onAdd,
  onRemove,
  onUpdate,
  embedded = false,
  interceptEdit = false,
  onEditIntent,
}: {
  links: BuilderLink[];
  error: string | null;
  disabled: boolean;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, field: keyof BuilderLink, value: string) => void;
  embedded?: boolean;
  interceptEdit?: boolean;
  onEditIntent?: () => void;
}) {
  // While viewing a saved run the fields aren't disabled — interacting with any of
  // them pops the "Edit this run?" confirm (onEditIntent) instead of editing.
  const effectiveDisabled = disabled && !interceptEdit;
  const fieldCursor = interceptEdit ? " cursor-pointer" : "";
  return (
    <section
      className={
        embedded
          ? ""
          : `rounded-2xl border border-line p-3 ${effectiveDisabled ? "bg-surface-muted/80" : "bg-surface/75"}`
      }
    >
      {!embedded && (
        <div className="mb-3">
          <h3 className="text-sm font-semibold">Approved links</h3>
          <p className="text-xs leading-5 text-muted">
            AI can only use these outbound URLs.
          </p>
        </div>
      )}
      <div
        className={`space-y-2 ${embedded ? "" : "max-h-[17rem] overflow-y-auto pr-1"}`}
      >
        {links.length === 0 && (
          <p className="rounded-xl border border-dashed border-line p-3 text-xs leading-5 text-muted">
            Add links for socials, music, stores, booking, or other destinations
            you want on the page.
          </p>
        )}
        {links.map((link, index) => (
          <div
            key={index}
            className={`grid gap-2 rounded-xl border border-line p-2 ${effectiveDisabled ? "bg-surface-muted" : "bg-surface"}`}
          >
            <input
              disabled={effectiveDisabled}
              readOnly={interceptEdit}
              onMouseDown={
                interceptEdit
                  ? (event) => {
                      event.preventDefault();
                      onEditIntent?.();
                    }
                  : undefined
              }
              value={link.label}
              onChange={(event) => onUpdate(index, "label", event.target.value)}
              className={`w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs outline-none focus:border-neutral-500 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-neutral-400 dark:disabled:text-neutral-500 ${focusRing}${fieldCursor}`}
              placeholder="Label, e.g. Instagram"
            />
            <div className="flex gap-2">
              <input
                disabled={effectiveDisabled}
                readOnly={interceptEdit}
                onMouseDown={
                  interceptEdit
                    ? (event) => {
                        event.preventDefault();
                        onEditIntent?.();
                      }
                    : undefined
                }
                value={link.url}
                onChange={(event) => onUpdate(index, "url", event.target.value)}
                className={`min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs outline-none focus:border-neutral-500 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-neutral-400 dark:disabled:text-neutral-500 ${focusRing}${fieldCursor}`}
                placeholder="https://instagram.com/..."
              />
              <button
                type="button"
                disabled={effectiveDisabled}
                onClick={
                  interceptEdit ? () => onEditIntent?.() : () => onRemove(index)
                }
                aria-label="Remove link"
                className={`grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface text-sm font-semibold transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-neutral-300 dark:disabled:text-neutral-500 ${focusRing}`}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={interceptEdit ? () => onEditIntent?.() : onAdd}
        disabled={effectiveDisabled}
        aria-label="Add link"
        className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line py-2.5 text-sm font-semibold text-muted transition hover:border-indigo-300 dark:hover:border-indigo-800 hover:text-indigo-600 disabled:cursor-not-allowed disabled:text-neutral-300 dark:disabled:text-neutral-500 ${focusRing}`}
      >
        <span className="text-base leading-none">+</span> Add link
      </button>
      {error && <p className="mt-2 text-xs leading-5 text-red-700 dark:text-red-300">{error}</p>}
    </section>
  );
}

function StreamingDrawer({
  title,
  phase,
  loading,
  open,
  logs,
  htmlOutput,
  showHtmlOutput,
  error,
  onClose,
}: {
  title: string;
  phase: StreamPhase;
  loading: boolean;
  open: boolean;
  logs: StreamLog[];
  htmlOutput: string;
  showHtmlOutput: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const isStreaming = phase === "streaming";
  const summary = traceSummary(logs);
  const statusLabel = loading
    ? "Loading"
    : phase === "streaming"
      ? "Streaming"
      : phase === "completed"
        ? "Completed"
        : phase === "error"
          ? "Error"
          : "Saved";

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <aside
      role="region"
      aria-label="AI stream preview"
      className="flex h-[70vh] w-full flex-col overflow-hidden rounded-[2rem] border border-line bg-surface/95 shadow-sm backdrop-blur-xl xl:h-full xl:w-[34rem] xl:shrink-0"
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            AI Tool Preview
          </p>
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {title}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${phase === "error" ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300" : phase === "completed" ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300" : loading ? "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-200" : "bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200"}`}
          >
            {statusLabel}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI stream preview"
            className={`grid size-9 place-items-center rounded-full border border-line bg-surface text-lg leading-none transition hover:bg-surface-muted ${focusRing}`}
          >
            ×
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div
          className={`grid h-full min-h-0 gap-3 ${showHtmlOutput ? "grid-rows-[minmax(0,0.95fr)_minmax(0,1.05fr)]" : "grid-rows-1"}`}
        >
          <section className="flex h-full min-h-0 flex-col rounded-2xl border border-line bg-surface/75 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Tool calls</h3>
              {isStreaming && (
                <span className="text-xs text-blue-700 dark:text-blue-300">Live</span>
              )}
            </div>
            <div className="mb-3 grid grid-cols-3 gap-2">
              <TraceMetric label="Events" value={summary.total} />
              <TraceMetric label="Edits" value={summary.edits} />
              <TraceMetric
                label="Errors"
                value={summary.errors}
                tone={summary.errors > 0 ? "error" : "neutral"}
              />
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {loading && logs.length === 0 && (
                <p className="rounded-xl border border-dashed border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-800 dark:text-amber-200">
                  Loading saved tool calls...
                </p>
              )}
              {!loading && logs.length === 0 && (
                <p className="rounded-xl border border-dashed border-line p-3 text-sm text-muted">
                  No saved tool calls for this run.
                </p>
              )}
              {logs.map((log, index) => (
                <ToolLogCard
                  key={log.id}
                  log={log}
                  active={index === logs.length - 1 && isStreaming}
                />
              ))}
            </div>
          </section>
          {showHtmlOutput && (
            <HtmlStreamPanel content={htmlOutput} isStreaming={isStreaming} />
          )}
        </div>
      </div>

      <div className="border-t border-line px-4 py-3">
        {error ? (
          <p className="text-sm leading-5 text-red-700 dark:text-red-300">{error}</p>
        ) : (
          <p className="text-sm leading-5 text-muted">
            {isStreaming
              ? "Showing live tool calls. The workspace updates when a valid document is available or saved."
              : phase === "completed"
                ? "Saved run is now selected in the workspace."
                : "Saved tool trace is shown above."}
          </p>
        )}
      </div>
    </aside>
  );
}

function HtmlStreamPanel({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-neutral-900 bg-neutral-950 text-neutral-100">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <h3 className="text-sm font-semibold">HTML stream</h3>
        <div className="flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
          {isStreaming && (
            <span className="rounded-full bg-blue-500/15 px-2 py-0.5 font-semibold text-blue-200">
              Live
            </span>
          )}
          <span>{content.length} chars</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-5">
        {content ? (
          <pre className="whitespace-pre-wrap break-words">
            <code>{content}</code>
          </pre>
        ) : (
          <p className="text-muted">Waiting for streamed HTML...</p>
        )}
      </div>
    </section>
  );
}

function ToolLogCard({ log, active }: { log: StreamLog; active: boolean }) {
  const diff = diffPreview(log);
  const readDocument = readDocumentOutput(log);
  const category = toolCategory(log, active);
  const style = toolCategoryStyle(category);
  const label = toolCategoryLabel(category);
  const message = readDocument ? readDocument.title : cleanToolMessage(log);
  return (
    <article
      className={`rounded-xl border p-3 text-xs leading-5 ${style.card}`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${style.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span
                className={`mb-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] ${style.badge}`}
              >
                {label}
              </span>
              <p className="min-w-0 font-semibold text-neutral-900 dark:text-neutral-100">
                {log.name ? (
                  <>
                    <span className="font-mono">{log.name}</span>
                    <span className="font-normal"> - {message}</span>
                  </>
                ) : (
                  message
                )}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-muted">
              {log.at}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted">
            {log.hash && <span>hash {log.hash}</span>}
            {typeof log.durationMs === "number" && (
              <span>{log.durationMs}ms</span>
            )}
          </div>
          {log.error && <p className="mt-1 text-red-700 dark:text-red-300">{log.error}</p>}
          {readDocument && <ReadDocumentBlock text={readDocument.text} />}
          {diff && <DiffBlock diff={diff} />}
        </div>
      </div>
    </article>
  );
}

function TraceMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${tone === "error" ? "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200" : "border-line bg-surface text-neutral-800 dark:text-neutral-200"}`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] opacity-60">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold">{value}</p>
    </div>
  );
}

function DiffBlock({
  diff,
}: {
  diff: { before?: string; after?: string; label: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const before = expanded ? diff.before : truncateForPreview(diff.before, 420);
  const after = expanded ? diff.after : truncateForPreview(diff.after, 420);
  const canExpand =
    (diff.before?.length ?? 0) > 420 || (diff.after?.length ?? 0) > 420;
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-line bg-neutral-950 font-mono text-[11px] leading-4">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2 py-1 text-neutral-400 dark:text-neutral-500">
        <span>{diff.label}</span>
        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-white/80 hover:bg-surface/10"
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      {before !== undefined && (
        <div className="border-b border-white/10">
          <p className="px-2 pt-1 text-[10px] uppercase tracking-[0.12em] text-red-300/70">
            Before
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-2 pb-2 pt-1 text-red-200">
            {before || "(empty)"}
          </pre>
        </div>
      )}
      {after !== undefined && (
        <div>
          <p className="px-2 pt-1 text-[10px] uppercase tracking-[0.12em] text-emerald-300/70">
            After
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-2 pb-2 pt-1 text-emerald-200">
            {after || "(empty)"}
          </pre>
        </div>
      )}
    </div>
  );
}

function ReadDocumentBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = parseNumberedDocument(text);
  const visibleLines = expanded ? lines : lines.slice(0, 36);
  const canExpand = lines.length > 36;
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-900/20 bg-slate-950 font-mono text-[11px] leading-5 shadow-inner">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2 py-1 text-slate-300">
        <span>read_document output</span>
        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-white/80 hover:bg-surface/10"
          >
            {expanded ? "Collapse" : `Expand ${lines.length} lines`}
          </button>
        )}
      </div>
      <div className="max-h-80 overflow-auto py-1">
        {visibleLines.map((line, index) => (
          <div
            key={`${line.number}-${index}`}
            className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 px-2 hover:bg-surface/[0.04]"
          >
            <span className="select-none border-r border-white/10 pr-2 text-right text-slate-500">
              {line.number}
            </span>
            <code className="min-w-0 whitespace-pre text-slate-100">
              {highlightSourceLine(line.code)}
            </code>
          </div>
        ))}
        {!expanded && canExpand && (
          <div className="px-2 py-1 text-center text-[10px] uppercase tracking-[0.12em] text-slate-500">
            showing first 36 of {lines.length} lines
          </div>
        )}
      </div>
    </div>
  );
}

function SourceEditor({ value, onChange, className }: { value: string; onChange: (value: string) => void; className?: string }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const highlighted = useMemo(() => {
    const lines = value.split("\n");
    return lines.map((line, index) => (
      <span key={index}>
        {highlightSourceLine(line)}
        {"\n"}
      </span>
    ));
  }, [value]);

  function syncScroll() {
    const pre = highlightRef.current;
    const textarea = textareaRef.current;
    if (pre && textarea) {
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    }
  }

  return (
    <div className={`relative overflow-hidden rounded-2xl border border-line bg-neutral-950 focus-within:ring-2 focus-within:ring-inset focus-within:ring-indigo-500 ${className ?? ""}`}>
      <pre
        ref={highlightRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-slate-100"
      >
        <code>{highlighted}</code>
      </pre>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="absolute inset-0 m-0 w-full resize-none overflow-auto whitespace-pre-wrap break-words bg-transparent p-4 font-mono text-xs leading-5 text-transparent caret-slate-100 outline-none"
      />
    </div>
  );
}

function VersionRow({
  run,
  index,
  selectedRunId,
  onSelect,
  onEditRun,
  onOpenTrace,
  onDelete,
  disabled,
  canDelete,
  isLast,
  isDeployed,
  deployedAt,
}: {
  run: BuilderRun;
  index: number;
  selectedRunId: string | null;
  onSelect: (run: BuilderRun) => void;
  onEditRun: (run: BuilderRun) => void;
  onOpenTrace: (run: BuilderRun) => void;
  onDelete: (run: BuilderRun) => void;
  disabled: boolean;
  canDelete: boolean;
  isLast: boolean;
  isDeployed: boolean;
  deployedAt: string | null;
}) {
  const runStatus = run.status ?? "completed";
  const statusLabel =
    runStatus === "pending"
      ? "Saving"
      : runStatus === "failed"
        ? "Failed"
        : null;
  const toolEventCount = run.tool_event_count ?? 0;
  const canShowTrace = run.kind === "ai" || toolEventCount > 0;
  const selected = run.id === selectedRunId;
  return (
    <article
      onClick={() => {
        if (!disabled) onSelect(run);
      }}
      className={`relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 py-3 pl-4 pr-3 transition ${disabled ? "" : "cursor-pointer"} ${!isLast ? "border-b border-black/[0.06] dark:border-white/[0.08]" : ""} ${selected ? "bg-indigo-50 dark:bg-indigo-950/40" : isDeployed ? "bg-emerald-50/70 dark:bg-emerald-950/40 hover:bg-emerald-50 dark:hover:bg-emerald-950/40" : "bg-surface/40 hover:bg-surface/80"}`}
    >
      {selected && (
        <span className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-indigo-600" />
      )}
      <div className="relative flex justify-center">
        {!isLast && (
          <span
            className={`absolute top-4 h-[calc(100%+0.75rem)] w-px ${isDeployed ? "bg-emerald-300 dark:bg-emerald-700" : selected ? "bg-indigo-200 dark:bg-indigo-900/40" : "bg-black/10 dark:bg-white/10"}`}
          />
        )}
        <span
          className={`relative mt-1 size-2.5 rounded-full ring-4 ${isDeployed ? "bg-emerald-400 ring-emerald-100 shadow-[0_0_0_4px_rgba(16,185,129,0.18)]" : selected ? "bg-indigo-500 ring-indigo-100" : run.kind === "ai" ? "bg-blue-500 ring-blue-50" : "bg-neutral-300 dark:bg-neutral-700 ring-neutral-100"}`}
        />
      </div>
      <div className="min-w-0">
        <button
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(run);
          }}
          className={`block w-full min-w-0 rounded-lg text-left transition disabled:cursor-not-allowed disabled:opacity-70 ${focusRing}`}
        >
          <div className="flex items-start justify-between gap-2">
            <p
              className={`min-w-0 flex-1 line-clamp-2 text-sm font-semibold leading-5 ${selected ? "text-indigo-950 dark:text-indigo-100" : "text-neutral-950 dark:text-neutral-50"}`}
            >
              {versionLabel(run)}
            </p>
            <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
              {isDeployed && (
                <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-white shadow-sm">
                  Live
                </span>
              )}
              {statusLabel && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${runStatus === "failed" ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300" : "bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200"}`}
                >
                  {statusLabel}
                </span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] ${run.kind === "ai" ? "bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300" : "bg-surface-muted text-muted"}`}
              >
                {run.kind}
              </span>
            </span>
          </div>
          <p
            className={`mt-1 text-[11px] ${selected ? "text-indigo-700/70 dark:text-indigo-300/70" : "text-muted"}`}
          >
            {new Date(run.created_at).toLocaleString()}
            {isDeployed && deployedAt
              ? ` · Deployed ${new Date(deployedAt).toLocaleString()}`
              : ""}
          </p>
        </button>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {canShowTrace && (
              <button
                type="button"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenTrace(run);
                }}
                className={`rounded-full border border-line bg-surface px-2.5 py-1 text-[10px] font-semibold text-neutral-700 dark:text-neutral-300 shadow-sm transition hover:border-indigo-200 dark:hover:border-indigo-800 hover:text-indigo-700 dark:hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
              >
                Tools{toolEventCount > 0 ? ` · ${toolEventCount}` : ""}
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              disabled={disabled || runStatus !== "completed"}
              onClick={(event) => {
                event.stopPropagation();
                onEditRun(run);
              }}
              title={
                runStatus === "completed"
                  ? "Use this run as the base for a new AI prompt."
                  : "Only completed runs can be edited."
              }
              aria-label={`Edit run ${index + 1}`}
              className={`grid size-7 place-items-center rounded-full border border-line bg-surface text-neutral-600 dark:text-neutral-300 transition hover:border-indigo-200 dark:hover:border-indigo-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-700 dark:hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-35 ${focusRing}`}
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(run);
              }}
              disabled={disabled || !canDelete}
              aria-label={`Delete run ${index + 1}`}
              className={`grid size-7 place-items-center rounded-full border border-line bg-surface text-xs font-semibold text-red-600 dark:text-red-300 transition hover:border-red-200 dark:hover:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-35 ${focusRing}`}
            >
              ×
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function PaperPlaneIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function CenteredCard({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8 text-neutral-950 dark:text-neutral-50">
      <section className="w-full max-w-md rounded-[2rem] border border-line bg-surface/85 p-8 text-center shadow-[0_30px_90px_rgba(0,0,0,0.10)] backdrop-blur-2xl">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
          LinkQT
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mb-6 mt-3 text-sm leading-6 text-muted">{detail}</p>
        {children}
      </section>
    </main>
  );
}

function mergeRuns(runs: BuilderRun[], run: BuilderRun) {
  const withoutRun = runs.filter((candidate) => candidate.id !== run.id);
  return [...withoutRun, run].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

function latestRun(project?: BuilderProject) {
  const pick = (list: BuilderRun[]) =>
    list.reduce<BuilderRun | undefined>(
      (latest, run) =>
        !latest ||
        new Date(run.created_at).getTime() >
          new Date(latest.created_at).getTime()
          ? run
          : latest,
      undefined,
    );
  return pick(project?.runs ?? []) ?? pick(project?.open_canvases ?? []);
}

function allProjectRuns(projects: BuilderProject[]) {
  return projects.flatMap((project) => [
    ...project.runs,
    ...(project.open_canvases ?? []),
  ]);
}

function hasSelectableRun(projects: BuilderProject[], runId: string) {
  return projects.some(
    (project) =>
      project.runs.some((run) => run.id === runId) ||
      (project.open_canvases ?? []).some((run) => run.id === runId),
  );
}

function markDeployedRun(
  projects: BuilderProject[],
  runId: string,
  deployedAt: string,
) {
  return projects.map((project) => ({
    ...project,
    deployed_run_id: project.runs.some((run) => run.id === runId)
      ? runId
      : null,
    deployed_at: project.runs.some((run) => run.id === runId)
      ? deployedAt
      : null,
  }));
}

function isSeedRun(run?: BuilderRun | null) {
  return Boolean(run?.is_seed);
}

function aiBuilderBlockedReason(
  run: BuilderRun | null,
  hasUnsavedDocument: boolean,
  isBusy: boolean,
  isStreaming: boolean,
  isEditingPrompt: boolean,
) {
  if (isStreaming)
    return "AI is already running. Wait for this stream to finish before editing the next prompt.";
  if (isBusy) return "Finish the current action before editing the AI prompt.";
  if (!run)
    return "Create or select a saved run or blank draft before prompting AI.";
  if (run.status === "pending")
    return "Wait for this run to finish saving before prompting AI.";
  if (run.status === "failed")
    return "Select a completed run or blank draft before prompting AI.";
  if (hasUnsavedDocument)
    return "Save or discard source changes before prompting AI.";
  if (!isEditingPrompt)
    return "Click Edit on a run to start a new AI prompt from it.";
  return null;
}

function isPreviewableHtmlDocument(value: string) {
  const document = stripCodeFence(value);
  if (!/^(?:<!doctype html>\s*)?<html\b[\s\S]*<\/html>\s*$/i.test(document))
    return false;
  if (typeof window === "undefined" || !window.DOMParser) return true;
  const parsed = new DOMParser().parseFromString(document, "text/html");
  return Boolean(
    parsed.documentElement?.querySelector("html") ??
    parsed.querySelector("html"),
  );
}

function stripCodeFence(value: string) {
  return value
    .trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function Alert({
  tone,
  children,
}: {
  tone: "info" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-2xl border px-4 py-3 text-sm ${tone === "error" ? "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300" : "border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200"}`}
    >
      {children}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 rounded-full px-4 py-2 text-sm font-semibold transition ${focusRing} ${active ? "bg-surface shadow-sm" : "text-muted hover:text-neutral-950 dark:hover:text-neutral-50"}`}
    >
      {children}
    </button>
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function streamLogId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeStatusLog(message: string): StreamLog {
  return {
    id: streamLogId(),
    message,
    at: new Date().toLocaleTimeString(),
    kind: "status",
    eventType: eventTypeFromMessage(message),
    status: "info",
  };
}

function makeToolLog(payload: BuilderAiToolPayload): StreamLog {
  return {
    id: streamLogId(),
    message: payload.message,
    at: new Date().toLocaleTimeString(),
    kind: "tool",
    eventType: payload.error
      ? "tool_error"
      : payload.result
        ? "tool_result"
        : "tool_start",
    name: payload.name,
    status: payload.error ? "error" : payload.result ? "success" : "started",
    args: payload.args,
    result: payload.result,
    hash: payload.hash,
    error: payload.error,
  };
}

function streamLogFromToolEvent(event: BuilderRunToolEvent): StreamLog {
  return {
    id: event.id,
    message: event.message || toolEventLabel(event),
    at: new Date(event.created_at).toLocaleTimeString(),
    kind: event.tool_name ? "tool" : "status",
    eventType: event.event_type,
    name: event.tool_name ?? undefined,
    status: event.status,
    args: safeParseJson(event.args_json),
    result: safeParseJson(event.result_json),
    hash: event.document_hash ?? undefined,
    error: event.status === "error" ? event.message : undefined,
    durationMs: event.duration_ms,
  };
}

function versionLabel(run: BuilderRun) {
  return (
    run.title?.trim() ||
    run.prompt?.trim() ||
    new Date(run.created_at).toLocaleString()
  );
}

function publicSiteUrl(subdomain: string) {
  if (typeof window !== "undefined") {
    const host = window.location.host;
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1"))
      return `${window.location.protocol}//${subdomain}.localhost:${window.location.port || "3000"}/`;
  }
  return `https://${subdomain}.linkqt.me/`;
}

function traceSummary(logs: StreamLog[]) {
  return {
    total: logs.length,
    edits: logs.filter(
      (log) => log.name === "replace_text" || log.name === "replace_range",
    ).length,
    errors: logs.filter((log) => log.status === "error" || Boolean(log.error))
      .length,
  };
}

type ToolCategory =
  | "lifecycle"
  | "context"
  | "edit"
  | "success"
  | "completion"
  | "error"
  | "active";

function toolCategory(log: StreamLog, active: boolean): ToolCategory {
  if (
    log.error ||
    log.status === "error" ||
    log.eventType === "run_failed" ||
    log.eventType === "tool_error" ||
    log.eventType === "command_parse_failed"
  )
    return "error";
  if (active) return "active";
  if (log.name === "read_document" || log.name === "search_document")
    return "context";
  if (log.name === "replace_text" || log.name === "replace_range")
    return log.status === "success" || log.eventType === "tool_result"
      ? "success"
      : "edit";
  if (log.name === "finish_revision" || log.eventType === "run_completed")
    return "completion";
  if (log.status === "success") return "success";
  return "lifecycle";
}

function toolCategoryLabel(category: ToolCategory) {
  if (category === "context") return "Context";
  if (category === "edit") return "Edit";
  if (category === "success") return "Applied";
  if (category === "completion") return "Complete";
  if (category === "error") return "Error";
  if (category === "active") return "Running";
  return "Status";
}

function toolCategoryStyle(category: ToolCategory) {
  if (category === "context")
    return {
      card: "border-blue-200 dark:border-blue-900/50 bg-blue-50/70 dark:bg-blue-950/40",
      dot: "bg-blue-500",
      badge: "bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200",
    };
  if (category === "edit")
    return {
      card: "border-amber-200 dark:border-amber-900/50 bg-amber-50/80 dark:bg-amber-950/40",
      dot: "bg-amber-500",
      badge: "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200",
    };
  if (category === "success")
    return {
      card: "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/75 dark:bg-emerald-950/40",
      dot: "bg-emerald-500",
      badge: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200",
    };
  if (category === "completion")
    return {
      card: "border-violet-200 bg-violet-50/70",
      dot: "bg-violet-500",
      badge: "bg-violet-100 text-violet-800",
    };
  if (category === "error")
    return {
      card: "border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40",
      dot: "bg-red-500",
      badge: "bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200",
    };
  if (category === "active")
    return {
      card: "border-sky-200 bg-sky-50/80",
      dot: "bg-sky-500",
      badge: "bg-sky-100 text-sky-800",
    };
  return {
    card: "border-line bg-surface",
    dot: "bg-neutral-300 dark:bg-neutral-700",
    badge: "bg-surface-muted text-neutral-600 dark:text-neutral-300",
  };
}

function cleanToolMessage(log: StreamLog) {
  if (log.name && log.message.startsWith(`${log.name}: `))
    return log.message.slice(log.name.length + 2);
  return log.message;
}

function eventTypeFromMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("validation")) return "validation_started";
  if (normalized.includes("saved")) return "run_completed";
  if (normalized.includes("agent turn")) return "agent_turn";
  return "status";
}

function diffPreview(log: StreamLog) {
  const args = objectValue(log.args);
  if (!args) return null;
  if (
    log.name === "replace_text" &&
    (typeof args.oldText === "string" || typeof args.newText === "string")
  ) {
    return {
      label: "replace_text",
      before: truncateForPreview(args.oldText),
      after: truncateForPreview(args.newText),
    };
  }
  if (
    log.name === "replace_range" &&
    (typeof args.startLine === "number" ||
      typeof args.endLine === "number" ||
      typeof args.newText === "string")
  ) {
    const start = typeof args.startLine === "number" ? args.startLine : "?";
    const end = typeof args.endLine === "number" ? args.endLine : "?";
    return {
      label: `replace_range lines ${start}-${end}`,
      after: truncateForPreview(args.newText),
    };
  }
  return null;
}

function readDocumentOutput(log: StreamLog) {
  if (log.name !== "read_document") return null;
  const result = objectValue(log.result);
  const candidates = [
    typeof result?.message === "string" ? result.message : "",
    typeof log.result === "string" ? log.result : "",
    log.message,
  ];
  const text = candidates.find((candidate) =>
    looksLikeNumberedDocument(candidate),
  );
  if (!text) return null;
  const args = objectValue(log.args);
  const start = typeof args?.startLine === "number" ? args.startLine : null;
  const end = typeof args?.endLine === "number" ? args.endLine : null;
  return {
    title: start && end ? `lines ${start}-${end}` : "document context",
    text,
  };
}

function looksLikeNumberedDocument(value: string) {
  return /^\s*\d+\|\s?/m.test(value);
}

function parseNumberedDocument(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line, index) => {
      const match = line.match(/^\s*(\d+)\|\s?(.*)$/);
      return match
        ? { number: match[1], code: match[2] }
        : { number: String(index + 1), code: line };
    });
}

function highlightSourceLine(line: string) {
  const parts: React.ReactNode[] = [];
  const tokenPattern =
    /(<!doctype\s+html>|<\/?[a-zA-Z][\w:-]*|\/?>|[a-zA-Z_:][-a-zA-Z0-9_:.]*(?=\s*=)|[-a-zA-Z_][-a-zA-Z0-9_]*(?=\s*:)|#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[{}()[\];:,])/gi;
  let offset = 0;
  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > offset) parts.push(line.slice(offset, index));
    parts.push(
      <span key={`${index}-${token}`} className={sourceTokenClass(token)}>
        {token}
      </span>,
    );
    offset = index + token.length;
  }
  if (offset < line.length) parts.push(line.slice(offset));
  return parts.length ? parts : line;
}

function sourceTokenClass(token: string) {
  if (
    /^<!doctype/i.test(token) ||
    /^<\/?[a-z]/i.test(token) ||
    token === ">" ||
    token === "/>"
  )
    return "text-sky-300";
  if (/^["']/.test(token)) return "text-emerald-200";
  if (/^#[0-9a-f]/i.test(token) || /^[rh]sla?\(/i.test(token))
    return "text-fuchsia-200";
  if (/^[{}()[\];:,]$/.test(token)) return "text-slate-400";
  if (/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(token)) return "text-amber-200";
  return "text-slate-100";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeParseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function truncateForPreview(value: unknown, limit = 1200) {
  if (typeof value !== "string") return undefined;
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

// The visible portion of a link (the path/handle, e.g. "@name", or the hostname
// for root URLs) so we can find-replace what the page actually shows, not just href.
function linkDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return path || parsed.hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function normalizeLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return trimmed;
  }
}

function validateLinks(links: BuilderLink[]) {
  const normalized: BuilderLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const label = link.label.trim();
    const rawUrl = link.url.trim();
    if (!label && !rawUrl) continue;
    if (!rawUrl)
      return { links: normalized, error: "Each approved link needs a URL." };
    const withProtocol = /^[a-z]+:\/\//i.test(rawUrl)
      ? rawUrl
      : `https://${rawUrl}`;
    let parsed: URL;
    try {
      parsed = new URL(withProtocol);
    } catch {
      return { links: normalized, error: `Invalid URL: ${rawUrl}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return {
        links: normalized,
        error: `Only http and https links are supported: ${rawUrl}`,
      };
    const url = parsed.toString();
    const key = url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      label: label || parsed.hostname.replace(/^www\./i, ""),
      url,
    });
    if (normalized.length > 20)
      return {
        links: normalized.slice(0, 20),
        error: "Use 20 links or fewer.",
      };
  }
  return { links: normalized, error: null };
}

function toolEventLabel(event: BuilderRunToolEvent) {
  const prefix = event.tool_name ? `${event.tool_name}: ` : "";
  const status =
    event.status === "error"
      ? "Failed"
      : event.status === "success"
        ? "Done"
        : event.status === "started"
          ? "Started"
          : event.event_type.replace(/_/g, " ");
  return `${prefix}${status} - ${event.message}`;
}
