# LinkQT Agent Notes

## Testing And Verification

Use the narrowest check that matches the change:

- `bun run typecheck` for TypeScript/API/client/script changes.
- `bun run frontend:build` for UI, Next.js route, or client changes.
- `bun run linkqt:test` for a quick backend smoke test against a running API.
- `bun run test:api-ai` for deterministic fake-upstream AI endpoint coverage.
- `bun run ai:e2e` for the focused real-upstream AI patch-agent check.

Do not leave dev servers or watch processes running when handing work back to the user. The user will run manual interactive testing themselves. If an agent starts `bun run dev`, `next dev`, or any other long-running server/watch command for verification, it must stop that process before the final response.

## Test Auth

`bun run dev` uses normal Clerk auth in the frontend. There is no frontend demo login.

Backend test auth is only for automated/local scripts:

- Enable with `LINKQT_TEST_AUTH=true`
- Bearer token: `linkqt-dev-demo-token`
- Test user id/email: `test-linkqt-user` / `test@linkqt.local`

When test auth is enabled, authenticated builder endpoints accept:

- `Authorization: Bearer linkqt-dev-demo-token`

Requests without an `Authorization` header are still rejected.

## AI Patch E2E

`bun run test:api-ai` is the deterministic regression test for AI endpoints. It starts a fake upstream model and isolated API, then covers:

- streaming AI success and a difficult streaming patch revision with the verifier pass (including transient 502 retry)
- non-stream `/builder/revise` (whole-document `replace_document` tool)
- multi-occurrence `replace_all`
- reaching the edit-turn limit and saving the latest complete draft instead of failing
- external https resource URLs allowed in generated HTML
- inline SVG and `data:`-URI favicons allowed (XML namespace URIs exempt from the resource check)
- unapproved/invented navigational links rejected
- upstream failure marking a pending run failed
- `/builder/runs/:runId/tool-events`
- hidden blank project seed creation plus streamed first-document generation
- adding a blank canvas to an existing project (`/builder/blank-run`), `open_canvases` exposure, deleting an extra canvas, and consuming a canvas into a saved run
- `/v1/models` proxy behavior when enabled
- missing bearer-token rejection
- reserved namespace rejection (`admin`, `auth`, `site`, `www`, `accounts`, `billing`, …)
- per-user usage stats via `GET /me/stats`
- legacy auth-provider purge (no reintroduced Firebase/legacy auth in source)
- published page lookup through `/site/:subdomain/document`

`bun run ai:e2e` is the real-model focused E2E for the AI patch-agent system. It uses the real upstream model and should be treated as slower/flakier than deterministic checks.

Default local behavior:

- Starts an isolated API on `http://localhost:4062` (`scripts/serve-linkqt-api.ts`).
- Uses the Neon `DATABASE_URL` from the environment.
- Enables `LINKQT_TEST_AUTH=true` if no `LINKQT_AUTH_TOKEN` is provided.
- Defaults `LINKQT_AI_TIMEOUT_MS=120000` because real upstream patch turns can exceed 60 seconds.
- Uses the backend's default Meta Model API upstream unless `LINKQT_UPSTREAM_URL` or `LINKQT_AI_MODEL` are overridden.
- Creates one focused Linktree base project.
- Runs one difficult revision that should require tool edits and final verification.
- Calls `/builder/revise/stream` for each revision.
- Captures SSE tool events.
- Fetches persisted `/builder/runs/:runId/tool-events`.
- Validates completed run, complete HTML, changed document, parent history, approved links only, at least one successful edit tool, and a successful `verify_revision` tool event.

Artifacts are written to `.cache/linkqt-ai-e2e/latest/`:

- `base.html`
- per-step `before.html`
- per-step `result.html`
- per-step `stream-events.json`
- per-step `tool-events.json`
- per-step `diff.txt`
- per-step `summary.json`
- `run-summary.json`
- `index.html`

After running `bun run ai:e2e`, inspect `index.html` when evaluating visual quality. A passing test proves the tool loop completed and persisted trace rows; it does not prove the design is visually excellent.

If testing against an existing API instead of the isolated local server:

```bash
LINKQT_API_URL=http://localhost:3000/api LINKQT_AUTH_TOKEN=... bun run ai:e2e
```

When `LINKQT_API_URL` is set, the script requires `LINKQT_AUTH_TOKEN` unless that existing API is already running with test auth and you pass `LINKQT_AUTH_TOKEN=linkqt-dev-demo-token`.

## AI Patch Agent

`runPatchAgent` revises a document with a bounded tool loop (max `LINKQT_AI_MAX_TURNS`, default 8). Tool calls are emitted as text JSON (not native function calling) and applied by `executePatchCommand`:

- `read_document`, `search_document` — inspection only.
- `replace_text` — exact match; requires the current `documentHash` and takes an `expectedOccurrences` count (default 1), erroring when the actual match count differs.
- `replace_all` — replaces every occurrence; requires `documentHash` and errors when nothing matches.
- `replace_range` — replaces an inclusive line range; requires `documentHash`.
- `insert_after_line` — inserts after a 1-based line number (`0` prepends, `lines.length` appends). Requires `documentHash`.
- `finish_revision` — ends the loop; rejected until at least one edit has been applied.
- Streaming `runPatchAgent` rejects `replace_document`. Non-stream `POST /builder/revise` still forces a whole-document `replace_document` tool call. Do not reintroduce whole-document replacement on the patch path.

`documentHash` is FNV-1a; a stale hash fails the tool so the model re-reads before patching. A separate verifier pass runs `verify_revision` and must return line-numbered suggestions. If the turn limit is reached with a changed, complete HTML draft, the agent saves that latest draft (marked unverified) instead of throwing.

Do not reformat stored documents server-side (e.g. with Prettier). The agent matches exact text against `builder_runs.document`, so reformatting at save time would break later revisions. The admin Source view formats HTML on demand in the browser only (lazy-loaded `prettier`); stored documents are kept as produced.

## Link And Resource Policy

`assertAllowedLinks` runs on every generated, uploaded, cloned, deployed, or manually saved document and is a hard invariant:

- Navigational URLs (`<a href>`, `<form action>`, `<script src>`) must be in the request's approved link set or already present in the base document. The model may not invent outbound destinations.
- Other resource URLs (images, stylesheets, fonts, media) are allowed only when https, or grandfathered from the base document.
- XML namespace URIs are exempt from the resource check (`XML_NAMESPACE_URIS` / `isXmlNamespaceUrl`, filtered out of `externalDocumentUrls`): the SVG `xmlns="http://www.w3.org/2000/svg"` and the other W3C namespaces (xlink/xhtml/mathml/xml/xmlns) are parser identifiers, never fetched. This is what lets inline SVG and `data:`-URI favicons pass.

Keep this aligned with the served-page Content-Security-Policy and the `test:api-ai` cases (external https resource allowed, inline-SVG/favicon allowed, invented navigational link rejected) whenever you change it.

## AI Usage Limit

Authenticated AI endpoints call `assertAiCreditAvailable` before work and `consumeAiCredit` only after a run is created. The counter is an atomic per-user/UTC-day row in `ai_usage`. Exceeding `LINKQT_AI_DAILY_LIMIT` (default 25) returns HTTP 429 without incrementing. Validation failures do not charge. Mutating builder POSTs accept `Idempotency-Key` (same key + same body replay the stored result; same key + different body is 409). `GET /api/me/stats` reports today's count, the daily limit, and project/run/deploy tallies (read-only). Schema lives in `lib/server/schema.ts` and is applied by `ensureSchema` against Neon. Test auth (`LINKQT_TEST_AUTH=true`) is ignored when `VERCEL_ENV=production`. `failStalePendingRuns` runs on every API request and on the daily cron.

## AI Tool Trace

AI patch-agent tool calls are stored per run in `builder_run_tool_events`.

Trace rows include:

- lifecycle events: `agent_started`, `validation_started`, `run_completed`, `run_failed`
- tool events: `tool_start`, `tool_result`, `tool_error`
- command parse failures: `command_parse_failed`
- bounded args/results JSON
- document hash
- duration where available

Do not store full generated documents in trace rows. Full documents already live on `builder_runs.document`; trace rows should store bounded previews and metadata.

## Projects, Runs, And Canvases

A project is a container of runs (straight-line history). Each run is tagged `ai` or `manual`; the project itself is not tagged in the UI. The admin labels runs by their title (not by "Version N"), and the deployable unit is a single completed run.

Blank canvases use an internal `builder_runs.is_seed` row with an empty document and no parent. A project may hold more than one (a brand-new blank project, plus any added later via `POST /builder/blank-run { projectId }`). Childless seeds are returned as `project.open_canvases[]`; once a seed gets a child (the user uploads HTML or runs a from-scratch prompt) it is consumed and drops out of `open_canvases`. Seeds are never shown as saved runs — the frontend renders them as selectable "Empty canvas" rows and labels saved runs by title, not by version number.

Editing a saved run is non-destructive: changing the prompt, approved links, or source and saving creates a **new child run** (the original stays in history). Deleting a run is exact: `parent_run_id` is `ON DELETE RESTRICT`, so a parent with children is rejected. A second delete of a missing id is 200. The last non-seed run cannot be deleted (delete the project instead). Manual edits (no AI) save through `POST /builder/version`. When approved links change, the client find-replaces the old URL — plus the visible handle (the URL path) and any changed label — into the page HTML so the rendered link updates, not just the metadata, and warns the user first. Uploading HTML is only offered on a blank canvas, not as a way to "edit" an existing run.

## Theming

The admin supports system / light / dark via `next-themes` (`app/theme-provider.tsx`, class toggled on `<html>`). `app/globals.css` declares a class-based `@custom-variant dark` plus semantic tokens — `bg-surface`, `bg-surface-muted`, `text-foreground`, `text-muted`, `border-line` (light values in `:root`, overrides in `.dark`). Build new admin UI with those tokens for neutrals and `dark:` variants for the indigo accent and status colors. Do not theme the `<iframe srcDoc>` preview (it renders user HTML) or the `SourceEditor` (intentionally dark). The switcher governs the admin UI only — not published `<sub>.linkqt.me` pages.
