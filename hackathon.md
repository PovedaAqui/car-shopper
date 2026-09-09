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
- **Last updated:** 2026-09-09T08:30:00Z

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