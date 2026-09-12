export {};

type BuilderLink = { label: string; url: string };
type BuilderRun = { id: string; status: "pending" | "completed" | "failed"; is_seed?: boolean; document: string; parent_run_id?: string | null };
type BuilderProject = { id: string; title: string; deployed_run_id?: string | null; deployed_at?: string | null; runs?: BuilderRun[]; open_canvases?: BuilderRun[] };
type StreamEvent = { event: string; data: unknown };

const apiPort = Number(process.env.LINKQT_FAKE_API_PORT ?? 4071);
const upstreamPort = Number(process.env.LINKQT_FAKE_UPSTREAM_PORT ?? 4072);
const apiBaseUrl = `http://localhost:${apiPort}`;
const upstreamBaseUrl = `http://localhost:${upstreamPort}`;
const authHeaders = { "Content-Type": "application/json", Authorization: "Bearer linkqt-dev-demo-token" };
const links: BuilderLink[] = [{ label: "Allowed", url: "https://example.com/" }];
const baseDocument = `<!doctype html><html><head><title>Fake AI Base</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:white}.box{position:relative;z-index:1;padding:20px;border:1px solid rgba(255,255,255,.2);border-radius:24px;background:rgba(0,0,0,.45)}</style></head><body><main class="box"><h1>ok</h1><p>Original card</p><a href="https://example.com/">Allowed</a></main></body></html>`;
const blankStreamDocument = `<!doctype html><html><head><title>Blank Stream Generated</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:white;font-family:Inter,sans-serif}main{padding:32px;border:1px solid rgba(255,255,255,.2);border-radius:24px}</style></head><body><main><h1>Blank Stream Generated</h1><p>Built from an empty saved project.</p><a href="https://example.com/">Allowed</a></main></body></html>`;
const hardRevisionPrompt = "add a layered animated space background with twinkling stars behind the card, and make the heading say Cosmic OK";
let transientPatchFailures = 0;
let transientVerifyFailures = 0;

let apiProcess: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
const fakeUpstream = Bun.serve({
  port: upstreamPort,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/models" || url.pathname === "/models") return json({ data: [{ id: "fake/model" }] });
    if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") return json({ error: { message: "not found" } }, 404);
    const body = await request.json() as { messages?: Array<{ role: string; content: string }>; tools?: unknown; stream?: boolean };
    const messages = body.messages ?? [];
    const all = messages.map((message) => message.content).join("\n");
    const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

    if (all.includes("strict final reviewer")) {
      const isCosmic = all.includes(hardRevisionPrompt);
      if (isCosmic && transientVerifyFailures < 1) {
        transientVerifyFailures += 1;
        return json({ error: { message: "temporary verifier outage" } }, 502);
      }
      if (isCosmic && !lastUser.includes("<h1>Cosmic OK</h1>")) return chat(JSON.stringify({
        satisfied: false,
        reason: "The heading was not updated, so the visual revision is incomplete.",
        suggestions: [
          { lineStart: 1, lineEnd: 1, issue: "The h1 still says ok.", suggestion: "Replace <h1>ok</h1> with <h1>Cosmic OK</h1> while preserving the new star background CSS." },
        ],
      }));
      return chat(JSON.stringify({ satisfied: true, reason: "The revision satisfies the request.", suggestions: [] }));
    }
    if (all.includes("Create a concise title")) return chat("Fake AI Revision");
    if (all.includes("full document nonstream")) return chat("", [{ function: { name: "replace_document", arguments: JSON.stringify({ document: baseDocument.replace("<h1>ok</h1>", "<h1>nonstream changed</h1>") }) } }]);
    if (all.includes("force upstream failure")) return json({ error: { message: "fake upstream failure" } }, 502);
    if (all.includes("blank-stream-generate")) return body.stream ? streamChat(blankStreamDocument) : chat("", [{ function: { name: "replace_document", arguments: JSON.stringify({ document: blankStreamDocument }) } }]);

    const currentHash = lastUser.match(/documentHash:\s*(d[0-9a-f]+)/i)?.[1] ?? all.match(/Current documentHash:\s*(d[0-9a-f]+)/i)?.[1] ?? "d00000000";
    if (lastUser.includes("VERIFY_REVISION_RESULT_START")) {
      return chat(JSON.stringify({ tool: "replace_text", args: { documentHash: currentHash, oldText: "<h1>ok</h1>", newText: "<h1>Cosmic OK</h1>", expectedOccurrences: 1 } }));
    }
    if (all.includes(hardRevisionPrompt)) {
      if (!lastUser.includes("TOOL_RESULT_START") && transientPatchFailures < 1) {
        transientPatchFailures += 1;
        return json({ error: { message: "temporary patch outage" } }, 502);
      }
      if (lastUser.includes("TOOL_RESULT_START") && !lastUser.includes("ERROR:")) return chat(JSON.stringify({ tool: "finish_revision", args: { summary: "Added starry animated space background." } }));
      return chat(JSON.stringify({
        tool: "replace_text",
        args: {
          documentHash: currentHash,
          oldText: "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:white}",
          newText: "body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;background:radial-gradient(circle at 20% 20%,rgba(255,255,255,.9) 0 1px,transparent 2px),radial-gradient(circle at 75% 30%,rgba(255,255,255,.7) 0 1px,transparent 2px),linear-gradient(145deg,#020617,#111827 55%,#1e1b4b);background-size:90px 90px,140px 140px,auto;color:white;animation:twinkle 4s ease-in-out infinite alternate}@keyframes twinkle{from{background-position:0 0,20px 10px,0 0}to{background-position:18px 12px,0 28px,0 0}}",
          expectedOccurrences: 1,
        },
      }));
    }
    if (all.includes("multi-occurrence-replace")) {
      if (lastUser.includes("TOOL_RESULT_START") && !lastUser.includes("ERROR:")) return chat(JSON.stringify({ tool: "finish_revision", args: { summary: "Recolored every card." } }));
      return chat(JSON.stringify({ tool: "replace_all", args: { documentHash: currentHash, oldText: "#abcdef", newText: "#123456" } }));
    }
    if (all.includes("add-external-image")) {
      if (lastUser.includes("TOOL_RESULT_START") && !lastUser.includes("ERROR:")) return chat(JSON.stringify({ tool: "finish_revision", args: { summary: "Added a hero image." } }));
      return chat(JSON.stringify({ tool: "replace_text", args: { documentHash: currentHash, oldText: "</main>", newText: "<img src=\"https://images.example.com/photo.png\" alt=\"hero\"></main>", expectedOccurrences: 1 } }));
    }
    if (all.includes("add-svg-favicon")) {
      if (lastUser.includes("TOOL_RESULT_START") && !lastUser.includes("ERROR:")) return chat(JSON.stringify({ tool: "finish_revision", args: { summary: "Added an inline SVG favicon." } }));
      return chat(JSON.stringify({ tool: "replace_text", args: { documentHash: currentHash, oldText: "</main>", newText: "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><circle cx='8' cy='8' r='8' fill='blue'/></svg>\"><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\"><circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"blue\"/></svg></main>", expectedOccurrences: 1 } }));
    }
    if (all.includes("add-invented-link")) {
      if (lastUser.includes("TOOL_RESULT_START") && !lastUser.includes("ERROR:")) return chat(JSON.stringify({ tool: "finish_revision", args: { summary: "Added a link." } }));
      return chat(JSON.stringify({ tool: "replace_text", args: { documentHash: currentHash, oldText: "</main>", newText: "<a href=\"https://evil.example.com/phish\">Click</a></main>", expectedOccurrences: 1 } }));
    }
    if (all.includes("never-finish-turn-limit")) {
      return chat(JSON.stringify({ tool: "replace_text", args: { documentHash: currentHash, oldText: "</main>", newText: "<!-- tick --></main>", expectedOccurrences: 1 } }));
    }
    if (lastUser.includes("TOOL_RESULT_START") && !lastUser.includes("ERROR:")) {
      return chat(JSON.stringify({ tool: "finish_revision", args: { summary: "done" } }));
    }
    return chat(JSON.stringify({ tool: "replace_text", args: { documentHash: currentHash, oldText: "ok", newText: "stream changed", expectedOccurrences: 1 } }));
  },
});

try {
  apiProcess = Bun.spawn(["bun", "run", "scripts/serve-linkqt-api.ts"], {
    env: {
      ...process.env,
      LINKQT_API_PORT: String(apiPort),
      LINKQT_UPSTREAM_URL: upstreamBaseUrl,
      LINKQT_TEST_AUTH: "true",
      LINKQT_ENABLE_AI_PROXY: "true",
      LINKQT_AI_TIMEOUT_MS: "20000",
      LINKQT_AI_RETRY_COUNT: "3",
      LINKQT_AI_DAILY_LIMIT: "1000",
      LINKQT_AI_RETRY_BASE_MS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  void logPipe(apiProcess.stdout, "api");
  void logPipe(apiProcess.stderr, "api:error");
  await waitForHealth();
  await assertHealthHidesInternals();

  await assertLegacyAuthProviderPurgedFromSource();
  await assertAuthAndNamespaceBehavior();
  await assertPublicSiteDeployment();
  await assertProxyBehavior();
  await assertBlankAndRenameProject();
  await assertBlankStreamingGeneration();
  await assertBlankRunInExistingProject();
  await assertNonStreamRevision();
  await assertDifficultPatchRevisionWithVerifier();
  await assertUpstreamFailure();
  await assertMultiOccurrenceReplace();
  await assertExternalResourceAllowed();
  await assertSvgFaviconAllowed();
  await assertInventedLinkRejected();
  await assertManualInventedLinkRejected();
  await assertJavascriptHrefRejected();
  await assertCreditNotChargedOnValidationFailure();
  await assertIdempotentBlankProject();
  await assertDeleteParentBlockedAndMissingOk();
  await assertTurnLimitSave();
  await assertUserStats();

  console.log("fake_ai_api_ok");
} finally {
  apiProcess?.kill();
  fakeUpstream.stop(true);
}

async function assertProxyBehavior() {
  const models = await fetchJson<{ data: Array<{ id: string }> }>(`${apiBaseUrl}/v1/models`, { headers: authHeaders });
  assert(models.data[0]?.id === "fake/model", "enabled model proxy did not return fake model.");
}

async function assertLegacyAuthProviderPurgedFromSource() {
  const removedPackage = "fire" + "base";
  const packageJson = await Bun.file("package.json").json() as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert(!packageJson.dependencies?.[removedPackage] && !packageJson.devDependencies?.[removedPackage], "removed auth package is still installed.");
  for (const file of ["lib/server/linkqt-api.ts", "app/admin/page.tsx", "lib/builder-client.ts", "proxy.ts"]) {
    const text = await Bun.file(file).text();
    assert(!new RegExp(removedPackage, "i").test(text), `${file} still contains removed auth-provider code.`);
  }
}

async function assertAuthAndNamespaceBehavior() {
  const missingAuthStatus = await fetchStatus(`${apiBaseUrl}/builder/projects`);
  assert(missingAuthStatus === 401, `missing auth returned ${missingAuthStatus}, expected 401.`);
  for (const subdomain of ["admin", "auth", "site", "www", "accounts", "billing"]) {
    const status = await fetchStatus(`${apiBaseUrl}/me/subdomain`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ subdomain }),
    });
    assert(status === 400, `reserved subdomain ${subdomain} returned ${status}, expected 400.`);
  }
}

async function assertPublicSiteDeployment() {
  const profile = await fetchJson<{ profile: { subdomain: string | null } }>(`${apiBaseUrl}/me/subdomain`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ subdomain: "faketest" }),
  });
  assert(profile.profile.subdomain === "faketest", "test subdomain was not reserved.");
  const created = await fetchJson<{ project: BuilderProject; run: BuilderRun }>(`${apiBaseUrl}/builder/manual-project`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      title: "Published Fake Page",
      document: "<!doctype html><html><head><title>Published Fake Page</title></head><body><main>published fake page</main></body></html>",
    }),
  });
  const deployed = await fetchJson<{ deployment: { site_key: string; run_id: string } }>(`${apiBaseUrl}/builder/deploy`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runId: created.run.id }),
  });
  assert(deployed.deployment.site_key === "faketest", "deployment used the wrong site key.");
  assert(deployed.deployment.run_id === created.run.id, "deployment used the wrong run.");
  const projects = await fetchJson<{ projects: BuilderProject[] }>(`${apiBaseUrl}/builder/projects`, { headers: authHeaders });
  const deployedProject = projects.projects.find((project) => project.id === created.project.id);
  assert(deployedProject, "deployed project was missing from project list.");
  assert(deployedProject.deployed_run_id === created.run.id, "project list did not expose the deployed run id.");
  assert(Boolean(deployedProject.deployed_at), "project list did not expose the deployed timestamp.");
  const response = await fetch(`${apiBaseUrl}/site/faketest/document`);
  const html = await response.text();
  assert(response.ok && html.includes("published fake page"), "published page lookup did not return deployed HTML.");
}

async function assertBlankAndRenameProject() {
  const created = await fetchJson<{ project: BuilderProject; run: BuilderRun }>(`${apiBaseUrl}/builder/blank-project`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ title: "Scratch Blank" }),
  });
  assert(created.project.title === "Scratch Blank", "blank project did not use requested title.");
  assert(created.run.document === "", "blank project did not create a truly empty saved run.");
  assert(created.run.is_seed === true, "blank project run was not marked as an internal seed.");
  await assertSeedActionGuards(created.run.id);
  const renamed = await fetchJson<{ project: BuilderProject }>(`${apiBaseUrl}/builder/rename-project`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId: created.project.id, title: "Renamed Scratch" }),
  });
  assert(renamed.project.title === "Renamed Scratch", "rename endpoint did not return updated title.");
  const projects = await fetchJson<{ projects: Array<BuilderProject & { runs: BuilderRun[] }> }>(`${apiBaseUrl}/builder/projects`, { headers: authHeaders });
  assert(projects.projects.some((project) => project.id === created.project.id && project.title === "Renamed Scratch"), "renamed project title was not persisted in project list.");
  const listed = projects.projects.find((project) => project.id === created.project.id);
  assert(listed, "renamed blank project was not returned in project list.");
  assert(listed.runs.length === 0, "blank seed leaked into visible project runs.");
  assert((listed.open_canvases ?? []).some((canvas) => canvas.id === created.run.id), "blank seed was not returned as an open canvas.");
}

async function assertBlankStreamingGeneration() {
  const created = await fetchJson<{ project: BuilderProject; run: BuilderRun }>(`${apiBaseUrl}/builder/blank-project`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ title: "Blank Stream Base" }),
  });
  assert(created.run.document === "", "blank stream base was not stored as an empty document.");
  assert(created.run.is_seed === true, "blank stream base was not marked as a seed.");
  const events = await streamRevision(created.run.id, "blank-stream-generate");
  const startedIndex = events.findIndex((event) => event.event === "started");
  const resultIndex = events.findIndex((event) => event.event === "result");
  assert(startedIndex !== -1, "blank streaming generation did not emit started before work.");
  assert(resultIndex > startedIndex, "blank streaming generation result did not follow started event.");
  assert(events.some((event) => event.event === "token" && typeof (event.data as { content?: unknown }).content === "string"), "blank streaming generation did not emit token events.");
  const result = lastPayload<{ run: BuilderRun }>(events, "result");
  assert(result?.run.status === "completed", "blank streaming generation did not complete.");
  assert(result.run.is_seed !== true, "blank streaming generation saved the visible run as a seed.");
  assert(result.run.parent_run_id === created.run.id, "blank streaming generation did not append from the empty base run.");
  assert(/^<!doctype html><html[\s\S]*<\/html>$/i.test(result.run.document), "blank streaming generation did not save a complete HTML document.");
  assert(result.run.document.includes("Blank Stream Generated"), "blank streaming generation saved the wrong document.");
  const trace = await fetchJson<{ events: Array<{ event_type: string; status: string; tool_name: string | null }> }>(`${apiBaseUrl}/builder/runs/${result.run.id}/tool-events`, { headers: authHeaders });
  assert(trace.events.some((event) => event.event_type === "agent_started"), "blank streaming generation trace missing agent_started.");
  assert(trace.events.some((event) => event.event_type === "generation_started" && event.tool_name === "generate_document"), "blank streaming generation trace missing generation_started.");
  assert(trace.events.some((event) => event.event_type === "run_completed"), "blank streaming generation trace missing run_completed.");
  const projects = await fetchJson<{ projects: BuilderProject[] }>(`${apiBaseUrl}/builder/projects`, { headers: authHeaders });
  const listed = projects.projects.find((project) => project.id === created.project.id);
  assert(listed, "blank streaming project was not returned in project list.");
  assert(!(listed.open_canvases ?? []).some((canvas) => canvas.id === created.run.id), "a filled blank seed should no longer be an open canvas.");
  assert(listed.runs?.length === 1 && listed.runs[0].id === result.run.id, "blank streaming first generated run was not the only visible run.");
}

async function assertSeedActionGuards(runId: string) {
  const deploy = await fetchStatus(`${apiBaseUrl}/builder/deploy`, { method: "POST", headers: authHeaders, body: JSON.stringify({ runId }) });
  assert(deploy === 400, `seed deploy returned ${deploy}, expected 400.`);
  const clone = await fetchStatus(`${apiBaseUrl}/builder/clone-project`, { method: "POST", headers: authHeaders, body: JSON.stringify({ runId }) });
  assert(clone === 400, `seed clone returned ${clone}, expected 400.`);
  const deleteRun = await fetchStatus(`${apiBaseUrl}/builder/delete-run`, { method: "POST", headers: authHeaders, body: JSON.stringify({ runId }) });
  assert(deleteRun === 400, `seed delete returned ${deleteRun}, expected 400.`);
}

async function assertBlankRunInExistingProject() {
  const created = await createProject();
  const projectId = created.project.id;

  const canvas = await fetchJson<{ project: BuilderProject; run: BuilderRun }>(`${apiBaseUrl}/builder/blank-run`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId }),
  });
  assert(canvas.run.is_seed === true, "blank-run did not create a seed canvas.");
  assert(canvas.run.document === "", "blank-run canvas was not empty.");
  assert((canvas.run.parent_run_id ?? null) === null, "blank-run canvas should have no parent.");

  const beforeFill = await listProjectById(projectId);
  assert((beforeFill.open_canvases ?? []).some((entry) => entry.id === canvas.run.id), "blank canvas was not returned as an open canvas.");
  assert((beforeFill.runs ?? []).length === 1, "adding a blank canvas should not change visible runs.");

  // An extra blank canvas can be deleted while the project still has another run.
  const extra = await fetchJson<{ run: BuilderRun }>(`${apiBaseUrl}/builder/blank-run`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId }),
  });
  const deleteStatus = await fetchStatus(`${apiBaseUrl}/builder/delete-run`, { method: "POST", headers: authHeaders, body: JSON.stringify({ runId: extra.run.id }) });
  assert(deleteStatus === 200, `deleting an extra blank canvas returned ${deleteStatus}, expected 200.`);

  // Filling a canvas via manual save produces a visible run and consumes the canvas.
  const filledDocument = `<!doctype html><html><head><title>Filled Canvas</title></head><body><main>filled canvas run</main></body></html>`;
  const filled = await fetchJson<{ run: BuilderRun }>(`${apiBaseUrl}/builder/version`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runId: canvas.run.id, document: filledDocument, links: [] }),
  });
  assert(filled.run.is_seed !== true, "filling a canvas should produce a visible run.");
  assert(filled.run.parent_run_id === canvas.run.id, "filled run should descend from the canvas.");

  const afterFill = await listProjectById(projectId);
  assert(!(afterFill.open_canvases ?? []).some((entry) => entry.id === canvas.run.id), "consumed canvas should no longer be an open canvas.");
  assert((afterFill.runs ?? []).some((entry) => entry.id === filled.run.id), "filled run should be visible.");
  assert((afterFill.runs ?? []).length === 2, "project should have two visible runs after filling a canvas.");
}

async function listProjectById(projectId: string) {
  const projects = await fetchJson<{ projects: BuilderProject[] }>(`${apiBaseUrl}/builder/projects`, { headers: authHeaders });
  const found = projects.projects.find((project) => project.id === projectId);
  assert(found, "project was not returned in project list.");
  return found;
}

async function assertNonStreamRevision() {
  const created = await createProject();
  const revised = await fetchJson<{ run: BuilderRun }>(`${apiBaseUrl}/builder/revise`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runId: created.run.id, prompt: "full document nonstream", links }),
  });
  assert(revised.run.document.includes("nonstream changed"), "non-stream revise did not use fake upstream tool response.");
}

async function assertDifficultPatchRevisionWithVerifier() {
  const created = await createProject();
  const events = await streamRevision(created.run.id, hardRevisionPrompt);
  const result = lastPayload<{ run: BuilderRun }>(events, "result");
  assert(result?.run.status === "completed", "difficult patch: stream did not complete.");
  assert(result.run.document.includes("Cosmic OK"), "difficult patch: verifier feedback did not lead to heading fix.");
  assert(result.run.document.includes("@keyframes twinkle"), "difficult patch: final document missing twinkle animation.");
  assert(result.run.document.includes("radial-gradient"), "difficult patch: final document missing starry radial gradients.");
  const trace = await fetchJson<{ events: Array<{ event_type: string; status: string; tool_name: string | null; args_json: string; result_json: string; message: string }> }>(`${apiBaseUrl}/builder/runs/${result.run.id}/tool-events`, { headers: authHeaders });
  const retryEvents = trace.events.filter((event) => event.event_type === "retry");
  assert(retryEvents.length >= 2, "difficult patch: expected persisted retry events for patch and verifier calls.");
  assert(retryEvents.some((event) => event.args_json.includes("\"phase\":\"patch\"")), "difficult patch: missing patch retry trace.");
  assert(retryEvents.some((event) => event.args_json.includes("\"phase\":\"verify\"")), "difficult patch: missing verifier retry trace.");
  assert(trace.events.some((event) => event.event_type === "tool_start" && event.tool_name === "replace_text"), "difficult patch: missing replace_text tool_start.");
  assert(trace.events.filter((event) => event.status === "success" && event.tool_name === "replace_text").length >= 2, "difficult patch: expected two successful replace_text patches.");
  assert(trace.events.some((event) => event.tool_name === "verify_revision" && event.status === "error" && event.message.includes("Needs fix")), "difficult patch: verifier did not reject incomplete first draft.");
  const rejected = trace.events.find((event) => event.tool_name === "verify_revision" && event.status === "error");
  assert(Boolean(rejected?.result_json.includes("lineStart") && rejected.result_json.includes("suggestion")), "difficult patch: verifier rejection did not persist line-numbered suggestions.");
  assert(trace.events.some((event) => event.tool_name === "verify_revision" && event.status === "success" && event.message.includes("Satisfied")), "difficult patch: verifier did not approve final draft.");
  assert(trace.events.some((event) => event.event_type === "run_completed"), "difficult patch: missing run_completed trace.");
  const leakedTrace = JSON.stringify(trace.events).toLowerCase();
  assert(!leakedTrace.includes("deepseek") && !leakedTrace.includes("api.deepseek") && !/"model"\s*:/.test(leakedTrace), "difficult patch: tool events leaked model or provider details.");
  assert(!trace.events.some((event) => event.event_type === "run_failed"), "difficult patch: unexpected run_failed trace.");
  const streamVerifierEvents = events.filter((event) => event.event === "tool" && toolName(event) === "verify_revision");
  assert(streamVerifierEvents.length >= 2, "difficult patch: SSE did not include verifier reject and approve events.");
  assert(events.some((event) => event.event === "status" && String((event.data as { message?: unknown }).message ?? "").includes("Retrying")), "difficult patch: SSE did not include retry status.");
}

async function assertUpstreamFailure() {
  const created = await createProject();
  const events = await streamRevision(created.run.id, "force upstream failure").catch((error) => {
    assert(error instanceof Error && error.message.includes("stream error"), "upstream failure did not surface as stream error.");
    return null;
  });
  assert(events === null, "upstream failure unexpectedly succeeded.");
  const projects = await fetchJson<{ projects: Array<{ runs: BuilderRun[] }> }>(`${apiBaseUrl}/builder/projects`, { headers: authHeaders });
  const failedRun = projects.projects.flatMap((project) => project.runs).find((run) => run.parent_run_id === created.run.id && run.status === "failed");
  assert(failedRun, "upstream failure did not leave a failed pending run.");
  const trace = await fetchJson<{ events: Array<{ event_type: string; args_json?: string }> }>(`${apiBaseUrl}/builder/runs/${failedRun.id}/tool-events`, { headers: authHeaders });
  assert(trace.events.filter((event) => event.event_type === "retry").length >= 3, "failed run trace missing retry attempts before run_failed.");
  assert(trace.events.some((event) => event.event_type === "run_failed"), "failed run trace missing run_failed.");
}

async function assertMultiOccurrenceReplace() {
  const multiDocument = `<!doctype html><html><head><title>Multi</title><style>.a{color:#abcdef}.b{color:#abcdef}.c{color:#abcdef}</style></head><body><main><a href="https://example.com/">Allowed</a></main></body></html>`;
  const created = await createProject(multiDocument);
  const events = await streamRevision(created.run.id, "multi-occurrence-replace recolor every card");
  const result = lastPayload<{ run: BuilderRun }>(events, "result");
  assert(result?.run.status === "completed", "multi-occurrence replace did not complete.");
  assert(!result.run.document.includes("#abcdef"), "replace_all left occurrences of the old value (first-occurrence-only bug).");
  assert((result.run.document.match(/#123456/g) ?? []).length === 3, "replace_all did not replace all three occurrences.");
}

async function assertExternalResourceAllowed() {
  const created = await createProject();
  const events = await streamRevision(created.run.id, "add-external-image hero");
  const result = lastPayload<{ run: BuilderRun }>(events, "result");
  assert(result?.run.status === "completed", "external image revision did not complete.");
  assert(result.run.document.includes("https://images.example.com/photo.png"), "external https image was not preserved in the saved document.");
}

async function assertSvgFaviconAllowed() {
  const created = await createProject();
  const events = await streamRevision(created.run.id, "add-svg-favicon icon");
  const result = lastPayload<{ run: BuilderRun }>(events, "result");
  assert(result?.run.status === "completed", "svg favicon revision did not complete.");
  assert(result.run.document.includes("http://www.w3.org/2000/svg"), "inline SVG namespace was not saved in the document.");
  assert(result.run.document.includes('rel="icon"'), "favicon link was not saved.");
}

async function assertInventedLinkRejected() {
  const created = await createProject();
  const events = await streamRevision(created.run.id, "add-invented-link phishing").catch((error) => {
    assert(error instanceof Error && error.message.includes("stream error"), "invented outbound link did not surface as a stream error.");
    return null;
  });
  assert(events === null, "invented outbound link unexpectedly succeeded.");
  const projects = await fetchJson<{ projects: Array<{ runs: BuilderRun[] }> }>(`${apiBaseUrl}/builder/projects`, { headers: authHeaders });
  const failedRun = projects.projects.flatMap((project) => project.runs).find((run) => run.parent_run_id === created.run.id && run.status === "failed");
  assert(failedRun, "invented outbound link did not leave a failed run.");
}

async function assertManualInventedLinkRejected() {
  const status = await fetchStatus(`${apiBaseUrl}/builder/manual-project`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      title: "Dirty Upload",
      document: `<!doctype html><html><head><title>Dirty</title></head><body><a href="https://evil.example.com/phish">x</a></body></html>`,
      links,
    }),
  });
  assert(status === 400, `manual invented link returned ${status}, expected 400.`);
}

async function assertJavascriptHrefRejected() {
  const created = await createProject();
  const status = await fetchStatus(`${apiBaseUrl}/builder/version`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      runId: created.run.id,
      document: `<!doctype html><html><head><title>Js</title></head><body><a href="javascript:void(0)">x</a></body></html>`,
      links,
    }),
  });
  assert(status === 400, `javascript:void href returned ${status}, expected 400.`);
}

async function assertCreditNotChargedOnValidationFailure() {
  const before = await fetchJson<{ stats: { ai_used_today: number } }>(`${apiBaseUrl}/me/stats`, { headers: authHeaders });
  const missingPrompt = await fetchStatus(`${apiBaseUrl}/builder/revise`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runId: "missing-run", prompt: "" }),
  });
  assert(missingPrompt === 400, `empty prompt returned ${missingPrompt}, expected 400.`);
  const after = await fetchJson<{ stats: { ai_used_today: number } }>(`${apiBaseUrl}/me/stats`, { headers: authHeaders });
  assert(after.stats.ai_used_today === before.stats.ai_used_today, "validation failure charged an AI credit.");
}

async function assertIdempotentBlankProject() {
  const key = "blank-project-once";
  const headers = { ...authHeaders, "Idempotency-Key": key };
  const body = JSON.stringify({ title: "Idempotent Blank" });
  const first = await fetchJson<{ project: BuilderProject; run: BuilderRun }>(`${apiBaseUrl}/builder/blank-project`, { method: "POST", headers, body });
  const second = await fetchJson<{ project: BuilderProject; run: BuilderRun }>(`${apiBaseUrl}/builder/blank-project`, { method: "POST", headers, body });
  assert(first.project.id === second.project.id && first.run.id === second.run.id, "idempotent blank-project minted a second project.");
  const conflict = await fetchStatus(`${apiBaseUrl}/builder/blank-project`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Different Title" }),
  });
  assert(conflict === 409, `reused idempotency key with a different body returned ${conflict}, expected 409.`);
}

async function assertDeleteParentBlockedAndMissingOk() {
  const created = await createProject();
  const child = await fetchJson<{ run: BuilderRun }>(`${apiBaseUrl}/builder/version`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      runId: created.run.id,
      document: `<!doctype html><html><head><title>Child</title></head><body><main>child</main></body></html>`,
      links,
    }),
  });
  const parentDelete = await fetchStatus(`${apiBaseUrl}/builder/delete-run`, { method: "POST", headers: authHeaders, body: JSON.stringify({ runId: created.run.id }) });
  assert(parentDelete === 400, `deleting a parent with children returned ${parentDelete}, expected 400.`);
  const childDelete = await fetchStatus(`${apiBaseUrl}/builder/delete-run`, { method: "POST", headers: authHeaders, body: JSON.stringify({ runId: child.run.id }) });
  assert(childDelete === 200, `deleting a child run returned ${childDelete}, expected 200.`);
  const missing = await fetchStatus(`${apiBaseUrl}/builder/delete-run`, { method: "POST", headers: authHeaders, body: JSON.stringify({ runId: child.run.id }) });
  assert(missing === 200, `second delete of a missing run returned ${missing}, expected 200.`);
}

async function assertTurnLimitSave() {
  const created = await createProject();
  const events = await streamRevision(created.run.id, "never-finish-turn-limit keep editing");
  const result = lastPayload<{ run: BuilderRun }>(events, "result");
  assert(result?.run.status === "completed", "turn-limit run was not saved as completed.");
  assert(result.run.parent_run_id === created.run.id, "turn-limit run did not append from the base run.");
  const trace = await fetchJson<{ events: Array<{ event_type: string }> }>(`${apiBaseUrl}/builder/runs/${result.run.id}/tool-events`, { headers: authHeaders });
  assert(trace.events.some((event) => event.event_type === "turn_limit_reached"), "turn-limit save did not record a turn_limit_reached trace event.");
  assert(!trace.events.some((event) => event.event_type === "run_failed"), "turn-limit run was unexpectedly marked failed.");
}

async function createProject(document = baseDocument, projectLinks = links) {
  return fetchJson<{ project: BuilderProject; run: BuilderRun }>(`${apiBaseUrl}/builder/manual-project`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ title: "Fake AI Test", document, links: projectLinks }),
  });
}

async function streamRevision(runId: string, prompt: string) {
  const response = await fetch(`${apiBaseUrl}/builder/revise/stream`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runId, prompt, links }),
  });
  if (!response.ok) throw new Error(`stream failed ${response.status}: ${await response.text()}`);
  if (!response.body) throw new Error("stream returned no body");
  const events: StreamEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const event = parseSseFrame(buffer.slice(0, boundary));
      if (event) events.push(event);
      buffer = buffer.slice(boundary + 2);
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

async function assertUserStats() {
  const { stats } = await fetchJson<{
    stats: {
      total_projects: number;
      total_runs: number;
      ai_runs: number;
      manual_runs: number;
      deployed_pages: number;
      ai_used_today: number;
      ai_daily_limit: number;
    };
  }>(`${apiBaseUrl}/me/stats`, { headers: authHeaders });
  assert(stats.total_projects >= 1, "stats did not count created projects.");
  assert(stats.deployed_pages >= 1, "stats did not count the deployed page.");
  assert(stats.ai_daily_limit > 0, "stats did not expose the AI daily limit.");
  assert(stats.ai_used_today >= 1, "stats did not count AI usage from prior calls.");
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${input} failed with ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function fetchStatus(input: string, init?: RequestInit) {
  const response = await fetch(input, init);
  await response.text();
  return response.status;
}

async function assertHealthHidesInternals() {
  const response = await fetch(`${apiBaseUrl}/health`);
  const payload = await response.json() as Record<string, unknown>;
  assert(response.ok && payload.ok === true, "health was not ok.");
  assert(Object.keys(payload).length === 1, `health leaked extra fields: ${Object.keys(payload).join(",")}`);
  const text = JSON.stringify(payload).toLowerCase();
  assert(!text.includes("deepseek") && !text.includes("upstream") && !text.includes("model"), "health leaked internal details.");
}

async function waitForHealth() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(`${apiBaseUrl}/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("API did not become healthy.");
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

function chat(content: string, toolCalls?: unknown[]) {
  return json({ choices: [{ message: { role: "assistant", content, tool_calls: toolCalls } }] });
}

function streamChat(content: string) {
  const encoder = new TextEncoder();
  const parts = [content.slice(0, 90), content.slice(90, 240), content.slice(240)].filter(Boolean);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function safeJson(text: string) {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function logPipe(pipe: ReadableStream<Uint8Array>, label: string) {
  const decoder = new TextDecoder();
  for await (const chunk of pipe) {
    const text = decoder.decode(chunk).trim();
    if (text) console.log(`[${label}] ${text}`);
  }
}
