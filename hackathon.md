# Hackathon log

- **Project:** Car Shopper
- **Event:** Convex All Gas Hackathon
- **What it does:** Local-AI car shopping comparison app. Scrapes coches.net live (no fixed inputs), ranks real listings by €/km, runs two independent vision passes, produces a ranked HTML report, and can email that report as an HTML body via AgentMail.
- **Live app:** https://glorious-monitor-400.convex.site
- **Repo:** https://github.com/PovedaAqui/car-shopper
- **Frontend:** Convex static hosting
- **Convex deployment:** https://glorious-monitor-400.convex.cloud (prod, `luis-poveda:car-shopper:main`, region us)
- **Components:** @convex-dev/static-hosting, @agentmail/convex
- **Convex features:** schema, queries, mutations, actions, crons, HTTP actions, realtime subscriptions, File Storage
- **Auth:** none
- **AI models:** qwen38-27b-unsloth-nvfp4-dflash2 (local vLLM), Ollama/LM Studio adapters
- **Started:** 2026-08-26T16:25:21Z
- **Last updated:** 2026-09-11T00:45:00Z

## Log

### 2026-08-26 - initial
Set up project structure: Convex backend (schema, queries, mutations, subscriptions, crons, worker HTTP API), local worker (provider abstraction, scoring engine, vision pipeline, consensus, report renderer), frontend scaffold with realtime dashboard. Hackathon skill installed. TypeScript compiles clean (`npx tsc --noEmit`).

### 2026-08-26 - working tree
Fixed Phase 1 blockers against the product plan: worker TypeScript imports, raw HTML report upload, corrupt/dedup rules, stage-cache resume, worker-token checks, request_id, unit tests, escaped dashboard HTML.

### 2026-08-27 - working tree
Corrected the Convex HTTP integration: the worker and AgentMail webhook routes now live in the conventionally discovered `convex/http.ts`, with 400-level JSON body validation before Convex argument validation. Added the official static-hosting `deploy` script. Verified Convex AI files, backend generation, tests, and frontend build.

### 2026-08-27 - working tree
Replaced frontend string-based Convex calls with generated function references from `convex/_generated/api`, preserving typed job IDs. This makes the dashboard's realtime subscriptions and mutations use the supported Convex client contract. Tests, typecheck, build, and Convex generation pass.

### 2026-08-27 - working tree
Hardened the worker HTTP router to return `400` for malformed JSON before invoking Convex validators. Verified the malformed-request path, backend generation, tests, frontend build, and whitespace checks.

### 2026-08-27 - working tree
Refined the frontend with a Google/web.dev-inspired accessible visual system: stronger hierarchy and contrast, responsive form and table layout, keyboard skip link, visible focus states, larger touch targets, hover feedback, dark-mode support, and reduced-motion handling. Built and served the site locally at `http://127.0.0.1:4173`.

### 2026-08-27 - working tree
Set English as the default frontend language and verified the full local flow through Camoufox: the browser submitted a search to Convex, the worker claimed it through `/api/worker/claim`, and the pipeline completed with 18 ranked listings, 2 excluded listings, 15/20 vision-evaluable results, and an HTML report. Local worker configuration now derives the self-hosted site port and ignores stale file-based deployment keys in local dev mode.

### 2026-08-27 - working tree
Verified model provenance instead of relying on fixture output. The worker queried local vLLM on port 8000; the configured model rejected image input, so the pipeline now reports `usedReferenceVision: false` and 20 honest `no_evaluable` vision results unless `ALLOW_REFERENCE_VISION=1` is explicitly set for a demo. Documented OpenRouter-compatible configuration without storing credentials.

### 2026-08-27 - working tree
Added an explicit Firecrawl search adapter behind `USE_FIRECRAWL=1` and `FIRECRAWL_API_KEY`. It maps Firecrawl result metadata into the same normalized listing contract, keeps fixtures as the default, and surfaces provider errors instead of mixing or inventing data. Added parser/error tests; the suite passes 21/21. No active Firecrawl key is present in the Hermes environment, so no live Firecrawl request was made.

### 2026-08-27 - working tree
Added an accessible AI settings dialog to the frontend with provider, endpoint, model, OpenRouter key, Firecrawl key, and scraper toggle fields. Values are stored only in session storage and are never sent to Convex; the worker remains configured through its environment. Verified the dialog through Camoufox and re-ran the build and 21-test suite.

### 2026-08-27 - working tree
Completed a Camoufox browser pass over settings, search submission, Convex job state, history, report, ranking, visual inspection, and email controls. Fixed the dashboard query to show only final v2 scores instead of duplicating v1 and v2 rows. Rebuilt and verified the app and backend after the fix.

### 2026-08-27 - working tree
The final Camoufox verification confirmed the completed report now shows English count labels and one final score per listing. The settings dialog, Convex-backed search submission, report link, and guarded email form all rendered successfully. The production-host build was restored and the 21-test suite passed.

### 2026-08-28 - production deployment
Deployed to Convex Cloud: prod deployment `luis-poveda:car-shopper:main` (region us) at `https://glorious-monitor-400.convex.cloud`; frontend published via `@convex-dev/static-hosting` to the public URL `https://glorious-monitor-400.convex.site` (served unauthenticated). Set the production environment on the deployment (`WORKER_API_KEY`, `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`); keys live only in git-ignored files and the deployment env. Ran the worker as a separate service against the prod deployment.

### 2026-08-28 - production verification
Ran the end-to-end acceptance flow on the public URL: browser search → Convex job → realtime stage updates → worker claim → 18 ranked / 2 excluded listings (corrupt and duplicate rows flagged) → HTML report served from Convex File Storage. Verified independently in the worker log (claim + completion lines). Verified production hardening: the dev `x-worker-mode: dev` header and missing/incorrect worker keys are rejected with 401; the public bundle contains no credentials. Vision is honest: the local vLLM model is text-only, so listings report `no_evaluable` unless reference vision is explicitly enabled (not enabled in production). The free-tier limit rejects a second same-day search with a user-facing message.

### 2026-08-28 - friendly error fix
Discovered during production verification that Convex redacts thrown error messages on production deployments (the client receives a generic "Server Error" plus a request ID), so thrown markers could never reach the frontend. Changed the `create` mutation to return structured rejections (`code: FREE_TIER_EXHAUSTED` / `PRICE_OUT_OF_RANGE`) instead of throwing, and mapped those codes to user-facing messages in the frontend. Verified live: the second same-day search now shows the friendly "free search already used" message. Typecheck and the 21-test suite pass; backend and frontend redeployed to the same prod deployment.

### 2026-08-28 - remove fixtures, live scrape only
Removed all fixed inputs from the pipeline: Firecrawl live scrape is now the only source (no fixture fallback). Removed stale fixture-derived copy and pre-filled search criteria from the frontend footer and form defaults so every demo starts from the user's own input. Hardened the provider layer: host-based inference between local vLLM and strict OpenAI-compatible endpoints, Firecrawl request pacing plus bounded 429 retry, per-ad photo enrichment. Added regression tests; the suite passes 38/38. README refined to match the live-only behavior.

### 2026-09-09 - independent production re-verification
Re-verified the live deployment end-to-end after the fixture removal, in a fresh session: `npm test` (38/38), `npx tsc --noEmit`, and `npm run build` all pass clean; `git status` clean with local HEAD matching `origin/main`; `npx convex function-spec` confirms 26 deployed functions (a real push, not a stale deploy). Ran the local worker against the prod deployment twice with different search criteria — Toyota Yaris (≤€8000, Barcelona) via the public form, and Seat Ibiza (≤€6000, Madrid) via a fresh `userId` through `npx convex run api:create` — both scraped real coches.net listings live (8 and 16 respectively), ranked them, and produced a genuine HTML report served from Convex File Storage. Confirmed the free-tier limit is scoped per `userId`, not global: the second search under the *original* `userId` was correctly rejected with the friendly "free search already used" message, while the fresh `userId` succeeded. Vision remains honestly `no_evaluable` in this environment (text-only local model), as designed. No secrets exposed in the process.

### 2026-09-10 - cloud-default vision/text, maxPhotos=1, English UI, minYear filter

Made OpenAI the **default** provider for both vision and text extraction
(previously local-first with an OpenAI fallback) — `VISION_PROVIDER`/
`TEXT_PROVIDER` env vars, default `openai`, local vLLM/Ollama/LM Studio
becomes an explicit opt-in via `VISION_PROVIDER=local`/`TEXT_PROVIDER=local`.
Added a real LLM use for text extraction (`worker/scrape.ts`
`parseCategoryCardsRaw` + a repair call for cards missing price/km, reading
only that card's own markdown, never inventing a number). Report titles now
link to the original coches.net listing. Made vision's per-ad photo cap
(`maxPhotos`) explicitly configurable with a default of **1** (was an
implicit 3), refactored from a load-time constant to
`defaultMaxPhotosPerCar()` so `VISION_MAX_PHOTOS_PER_CAR` overrides are
testable. Removed 6 dead fields from the frontend Settings dialog
(visionProvider/visionBaseUrl/visionModel/openrouterKey/firecrawlKey/
useFirecrawl) that nothing in the real pipeline ever read — kept only
`maxPhotos`. Translated all remaining Spanish user-facing text to English:
the generated HTML report (`worker/report.ts`), the exclusion reason shown
in that report, the live scrape-source label, dashboard status strings, and
the vision model's own free-text output (system/user prompt in
`worker/vision.ts` rewritten to English so `red_flags`/`exterior_details`
come back in English too — the fixed enum vocabulary the pipeline depends
on internally, e.g. `bien/regular/mal/no_evaluable`, was deliberately left
unchanged to avoid touching scoring/consensus/tests).

Production incident (real, not simulated): the first job after the vision
prompt rewrite failed with `ArgumentValidationError` — gpt-4o-mini returned
`photo_type: "professional"` (English) instead of the required Spanish enum
value, apparently over-generalizing the "write free-text fields in English"
instruction to the fixed enum field too. Root-caused via the worker log and
the Convex error, fixed by adding `normPhotoType()` — the same
defensive normalize-or-fallback pattern already used for
`exterior_state`/`interior_state`/`cleanliness` — instead of trusting the
model to always honor a prompt-level enum constraint. Re-ran the identical
search live after the fix; it completed cleanly. Added a regression test
(`tests/vision.test.ts`) asserting an English `photo_type` value from the
mock model gets normalized instead of causing a downstream validation
failure.

Added an optional `minYear` search criterion end to end: frontend form field
(1980-2030), `convex/schema.ts` + `convex/api.ts` validator
(`YEAR_OUT_OF_RANGE` rejection code, folded into `hashCriteria` so it
participates in the idempotency key), `worker/scrape.ts` post-parse filter
(listings below the cutoff dropped, listings with an unparseable year always
kept — coches.net's URL-level year filtering was not verified live, unlike
`maxPrice`, so this is implemented as a client-side filter rather than a URL
query param), `worker/report.ts` meta line, `--local` mode's `LOCAL_MIN_YEAR`
env var. New test in `tests/scrape.test.ts` against the existing
`CATEGORY_MD` fixture confirms a `minYear: 2015` search keeps a 2016 card and
drops a 2014 card.

Verified live against `glorious-monitor-400` throughout: 57/57 tests, clean
typecheck/build, `npx convex deploy` (26 functions) +
`npx @convex-dev/static-hosting deploy` after every change, and real
end-to-end jobs — Citroen C3/Valencia (photo_type fix), Volkswagen
Polo/Sevilla with `minYear: 2015` (2 ranked from 3 scraped, correctly kept a
2017 and a 2015 listing, report showed "2015+" in the meta line).

### 2026-09-10 - pipeline moved inside Convex, worker no longer required

User instruction: "the production version should be always running", then
"the production version shouldn't live in local" — the external polling
worker (`worker/index.ts`) meant production depended on a process running
somewhere always-on outside Convex; a local systemd unit was tried and
explicitly rejected by the user for that reason.

Moved the entire pipeline to run **inside Convex** as a Node-runtime action:
`convex/pipelineAction.ts` (new file, `"use node"`) imports
`worker/pipeline.ts` **unmodified** and calls it directly, wiring its
progress callbacks straight to the existing internal mutations
(`updateStage`/`insertListings`/`insertScores`/`insertVisionResults`/
`insertConsensus`/`createReport`) via `ctx.runMutation`/`ctx.runQuery`
instead of the old authenticated HTTP worker API. `api.create` now inserts
each job pre-claimed with its own `workerToken` and calls
`ctx.scheduler.runAfter(0, internal.pipelineAction.run, ...)` immediately,
instead of leaving it `queued` for an external poller to pick up.
`convex/tsconfig.json` gained `allowImportingTsExtensions` so it can
typecheck the `worker/*.ts` imports (which keep explicit `.ts` extensions
because they're also runnable directly via `node
--experimental-strip-types` for the `--local` one-shot dev mode).
`FIRECRAWL_API_KEY`, `OPENAI_API_KEY`, `OPENAI_VISION_MODEL`,
`OPENAI_TEXT_MODEL`, `VISION_PROVIDER`, `TEXT_PROVIDER`, `VISION_MODE`, and
`VISION_MAX_PHOTOS_PER_CAR` were moved into the Convex deployment's own
environment (`npx convex env set`) so the in-Convex action can read them.

Verified live with genuinely no worker process running anywhere (checked
via `ps aux`): a job created through `npx convex run api:create` (Seat
Ibiza, ≤ €7000, Madrid) showed status `"claimed"` immediately (proving the
scheduler fired), progressed scraping → vision → completed entirely on its
own, scraped 26 real coches.net listings, ranked them, and produced a
genuine HTML report served from Convex File Storage. Also re-verified
through the public browser form that the daily free-tier limit is still
correctly enforced. 57/57 tests pass unchanged (the pipeline code itself
was not touched, only how it's invoked); `tsc --noEmit` clean in both the
root and `convex/` tsconfigs. `worker/index.ts`/`worker/convex_client.ts`
are now dead code for production (kept only for `--local` one-shot dev runs
against a self-hosted Convex instance).

### 2026-09-10 (continued) - two complete user-workflow verifications post-migration

Ran two full "act as a real user" passes against the public site after the
in-Convex migration, to make sure moving the pipeline runner didn't quietly
break anything a judge would encounter.

Pass 1 (browser tool, existing session/userId): confirmed the public page
loads with no login; an empty-form submit is blocked by native HTML5
validation (no spurious job); a valid submission from a `userId` that
already used today's free search correctly shows the friendly
"already used" message instead of a raw error; clicking a completed search
in history renders the realtime status view (progress, counts, ranking
table) correctly for a job that finished earlier; opening the full report
shows real coches.net listings with clickable title links, visual-inspection
badges, and an exclusion table with a reason; the email form's required
confirmation checkbox is present.

Pass 2 (fresh `userId` via CLI + browser): `npx convex run api:create` for
a brand-new Ford Focus / Bilbao / `minYear: 2012` search returned
`status: "claimed"` immediately (the scheduled action fired without
polling), completed in well under 15 seconds, and produced a report where
both ranked listings were 2012-or-newer (the `minYear` filter held on a
second, independent dataset) and a car with no fetched photos was honestly
labeled "no photos" / "not evaluable" rather than something being invented.
Also drove the public browser form with a different search (Opel Corsa,
Zaragoza) from the same browser session — correctly blocked by the
same-day free-tier limit, confirming the limit is enforced consistently
across both entry points (CLI mutation and browser form) and persists
correctly across in-session navigation.

No regressions found. Updated README.md ("Verified in production" section,
new Configuration/Quick start sections describing the in-Convex runtime,
a note marking `convex/http.ts`'s worker routes as legacy/inert),
`.env.example` (header clarifies these vars are for `--local` dev only;
production sets the same names via `npx convex env set`), and this file.

### 2026-09-11 - shared validator, structured rejections (error-proofing the UI)

Extracted `convex/criteria_lib.ts`: a pure, framework-free `validateCriteria()`
imported directly by BOTH `convex/api.ts`'s `create` mutation (server,
authoritative) and `frontend/app.ts` (client, imported directly — not
duplicated logic that could drift). Rejects/normalizes make/model/region
(required, trimmed, whitespace-collapsed, length-capped, safe charset only),
maxPrice (100..1,000,000), and the optional maxKm/minYear/maxPhotos
(blank = not provided, present = validated as an in-range integer). Every
rejection returns a structured `{ code, field, message }`, never a thrown
error.

Real bug found while writing this: `make`/`model` were spliced into the
coches.net scrape URL (`worker/scrape.ts` `categoryUrl`) with no charset
restriction or encoding — a value like `"Toyota/../etc"` or `"Yaris?x=1"`
could reshape the URL's path/query. Fixed in two layers: `validateCriteria`
now rejects URL-structural characters before a job is ever created
(`MAKE_INVALID_CHARS`/`MODEL_INVALID_CHARS`/`REGION_INVALID_CHARS`), and
`categoryUrl` additionally `encodeURIComponent()`s make/model defensively
for any caller that bypasses validation (`--local` dev, tests).

`convex/email.ts`'s `requestEmail` was also switched from throwing
(`CONFIRM_REQUIRED`/`INVALID_EMAIL`/`NOT_FOUND`/`REPORT_NOT_READY` —
previously arrived at the client as a generic redacted "Server Error", the
same production-redaction problem the 2026-08-28 "friendly error fix"
already solved for `api.create`) to the same structured-rejection pattern.

`frontend/app.ts`: the search form now pre-validates with the imported
`validateCriteria` before ever calling the mutation (instant, specific,
per-field message via `setCustomValidity`/`reportValidity`, no round trip
for the common case), with the full server error-code map kept as
defense-in-depth for a stale/bypassed client. The email form gained a
client-side `isLikelyEmail()` pre-check (mirrors `email_lib.ts`'s
`isValidEmail`, duplicated rather than imported so the bundle stays
framework-free) plus the new structured error-code map.
`frontend/index.html` gained `pattern`/`title`/`step`/`max` attributes
matching the validator's rules, for instant native browser feedback ahead
of the JS layer.

Added `tests/criteria.test.ts` (15 cases: required-field rejection, length
caps, exact boundary values for price/km/year/photos, blank-vs-invalid
distinction for optional fields, unsafe-character rejection alongside
legitimate-punctuation acceptance like "Citroën"/"L'Aquila") and a
regression case in `tests/scrape.test.ts` for `categoryUrl`'s defensive
encoding. Confirmed via `grep` that the esbuild frontend bundle does not
pull in any server-only Convex code from `criteria_lib.ts` (zero matches
for `internalMutation`/`internalQuery`/`ctx.db`/`_generated/server`).
73/73 tests passing (16 new), `tsc --noEmit` clean, `npm run build` clean.

Deployed to production (`npx convex deploy` + `npx @convex-dev/static-hosting
deploy`) and verified live against `glorious-monitor-400`: `npx convex run
api:create` with a path-traversal-style make (`"Toyota/../etc"`) was
correctly rejected with `MAKE_INVALID_CHARS`, no job created, no free-tier
credit consumed; an empty region was rejected with `REGION_REQUIRED`; an
out-of-range price with `PRICE_OUT_OF_RANGE`; an out-of-range `minYear`
with `YEAR_OUT_OF_RANGE`. A search using legitimate accented/punctuated
values (`"Citroën"` / `"DS 3"` / region `"Zaragoza"`) was correctly
accepted, ran end-to-end (19 real coches.net listings scraped and ranked),
and produced a genuine report titled "Citroën DS 3 ≤ €5500" — confirming
the new charset restriction doesn't block real car names/regions.