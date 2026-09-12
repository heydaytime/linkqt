export {};

const baseUrl = (process.env.LINKQT_API_URL ?? "http://localhost:3000/api").replace(/\/$/, "");
const authToken = process.env.LINKQT_AUTH_TOKEN ?? (process.env.LINKQT_TEST_AUTH === "true" ? "linkqt-dev-demo-token" : "");

const authHeaders = {
  "Content-Type": "application/json",
  ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
};

async function main() {
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  console.log("health", health);

  const missingAuthStatus = await fetchStatus(`${baseUrl}/builder/projects`);
  console.log("missing_auth_builder_projects", missingAuthStatus);
  if (missingAuthStatus !== 401) throw new Error(`Missing bearer token returned ${missingAuthStatus}, expected 401.`);

  if (!authToken) {
    console.warn("LINKQT_AUTH_TOKEN is not set; skipped authenticated builder checks.");
    return;
  }

  await assertReservedSubdomains();

  const profilePayload = await fetchJson<{ profile: { subdomain: string | null } }>(`${baseUrl}/me/profile`, { headers: authHeaders });
  const subdomain = profilePayload.profile.subdomain ?? await registerSmokeSubdomain();
  console.log("profile_subdomain", subdomain);

  const before = await fetchJson<{ projects?: unknown[] }>(`${baseUrl}/builder/projects`, { headers: authHeaders });
  console.log("projects_before", Array.isArray(before.projects) ? before.projects.length : before);

  const created = await fetchJson<{ project: { id: string }; run: { id: string } }>(`${baseUrl}/builder/manual-project`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      title: "Smoke test",
      document: "<!doctype html><html><head><title>Smoke test</title></head><body><main>smoke live v1</main></body></html>",
    }),
  });
  console.log("manual_project", created.project?.id, created.run?.id);

  const version = await fetchJson<{ project: { id: string }; run: { id: string } }>(`${baseUrl}/builder/version`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      runId: created.run.id,
      document: "<!doctype html><html><head><title>Smoke test v2</title></head><body><main>smoke live v2</main></body></html>",
    }),
  });
  console.log("manual_version", version.project?.id, version.run?.id);

  const deployment = await fetchJson<{ deployment: { site_key: string; run_id: string } }>(`${baseUrl}/builder/deploy`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runId: version.run.id }),
  });
  if (deployment.deployment.site_key !== subdomain || deployment.deployment.run_id !== version.run.id) throw new Error("Deployment did not publish the requested run to the registered subdomain.");
  console.log("deployment", deployment.deployment.site_key, deployment.deployment.run_id);

  const publicPage = await fetch(`${baseUrl}/site/${encodeURIComponent(subdomain)}/document`);
  const publicHtml = await publicPage.text();
  console.log("site_document", publicPage.status, publicPage.headers.get("content-type"));
  if (!publicPage.ok || !publicHtml.includes("smoke live v2")) throw new Error(`Public document request failed with ${publicPage.status}: ${publicHtml.slice(0, 160)}`);

  const clone = await fetchJson<{ project: { id: string }; run: { id: string } }>(`${baseUrl}/builder/clone-project`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ runId: version.run.id }),
  });
  console.log("clone_project", clone.project?.id, clone.run?.id);

  const after = await fetchJson<{ projects?: unknown[] }>(`${baseUrl}/builder/projects`, { headers: authHeaders });
  console.log("projects_after", Array.isArray(after.projects) ? after.projects.length : after);
}

async function assertReservedSubdomains() {
  for (const subdomain of ["admin", "auth", "site", "www"]) {
    const status = await fetchStatus(`${baseUrl}/me/subdomain`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ subdomain }),
    });
    if (status !== 400) throw new Error(`Reserved subdomain ${subdomain} returned ${status}, expected 400.`);
  }
}

async function registerSmokeSubdomain() {
  const subdomain = `smoke-${Date.now().toString(36)}`;
  const payload = await fetchJson<{ profile: { subdomain: string | null } }>(`${baseUrl}/me/subdomain`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ subdomain }),
  });
  if (payload.profile.subdomain !== subdomain) throw new Error("Smoke subdomain registration did not persist.");
  return subdomain;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${input} failed with ${response.status}: ${text}`);
  return payload as T;
}

async function fetchStatus(input: string, init?: RequestInit) {
  const response = await fetch(input, init);
  await response.text();
  return response.status;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
