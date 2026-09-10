# Car Shopper

Async car-comparison web app built for the **Convex All Gas Hackathon**.

A user submits search criteria (make, model, max price, region, optional max
km, optional minimum year). Job creation schedules a **Convex Node action**
that runs the staged pipeline directly inside the deployment — no external
worker process to keep alive — writing every transition back to the same
job document, so the dashboard updates **in realtime** via subscriptions.
The finished report can be viewed in the dashboard or **emailed to any
address as an HTML body** (via AgentMail, never as an attachment).

Pipeline stages:

1. **Scrape** — live [Firecrawl](https://firecrawl.dev) scrape of the coches.net
   category page built from the job criteria
   (`coches.net/{make}/{model}/segunda-mano/{region}/?maxPrice=…&pg=N`, up to 3
   pages). Card fields (price, km, year, fuel, warranty, pro badge) are parsed
   from the markdown; the financing line (`€/mes`) is deliberately ignored and
   the card's own price line wins.
2. **Normalize** — deterministic quality rules; corrupt/implausible rows are
   excluded with a reason, never silently dropped.
3. **Rank** — deterministic €/km + attribute scoring (no LLM involved).
4. **Vision** — two **independent** passes (primary + reverify; pass 2 never
   sees pass 1) over each listing's **real photos**, fetched by scraping the
   ad's own page (coches.net category pages don't serve gallery images).
   Per-ad photo count is capped by the user's **`maxPhotos`** setting
   (default 1, configurable via `VISION_MAX_PHOTOS_PER_CAR` and the
   frontend's Settings dialog; `0` = vision explicitly disabled).
5. **Consensus** — deterministic cross-check of the two passes; disagreements
   degrade the score, they are never invented away.
6. **Report** — self-contained HTML with the source label, vision deltas and
   per-ad evidence.

There are **no fixed inputs**: every job's listings are the ads coches.net
serves at run time, scraped live, and every vision result comes from a real
model call. If the live source or the model fails, the job fails or honestly
reports `no_evaluable` — the pipeline never invents or substitutes data.

## Live deployment

- **App**: https://glorious-monitor-400.convex.site
- **Convex backend**: https://glorious-monitor-400.convex.cloud
  (prod, `luis-poveda:car-shopper:main`, region us)
- **Repo**: https://github.com/PovedaAqui/car-shopper

## Stack

- **Backend / source of truth**: Convex (schema + collections, public +
  internal queries/mutations, a Node-runtime action running the pipeline,
  crons, realtime subscriptions, File Storage).
- **Frontend**: static site (vanilla TS, `frontend/`) built to `dist/` and
  served by the official `@convex-dev/static-hosting` component →
  `*.convex.site`.
- **Pipeline runner**: `convex/pipelineAction.ts`, a Convex action with
  `"use node"` scheduled automatically by `api.create` — runs the exact same
  pipeline code as before (`worker/pipeline.ts`, unmodified) but *inside*
  the Convex deployment instead of on an external always-on host. No
  process needs to be kept running anywhere for production to work.
- **Vision**: any **OpenAI-compatible** endpoint — local vLLM (default
  `http://localhost:8000/v1`), or a remote API such as
  `https://api.openai.com/v1`. The provider kind is **inferred from the host**:
  local hosts default to vLLM (which accepts vLLM-specific args like
  `chat_template_kwargs`); remote APIs are treated as strict
  `openai_compat` because they reject unknown body fields. An explicit
  `VISION_PRIMARY_PROVIDER` env always wins over the inference.
- **Email delivery**: `@agentmail/convex` component. The report HTML is sent as
  the message body (multipart/alternative) with an idempotency key so a retry
  never sends the same report twice.

## Layout

```
convex/            Convex backend (schema, public + internal functions,
                   pipelineAction.ts running the pipeline in-Convex, crons,
                   HTTP router — now legacy, kept for --local dev — email +
                   email_send actions, AgentMail webhook)
frontend/          Static frontend sources (dashboard, form, report view,
                   email form, session settings incl. maxPhotos)
worker/            Pipeline library (scrape, providers, stages, report) —
                   imported directly by convex/pipelineAction.ts in
                   production; worker/index.ts's --local mode remains for
                   one-shot local dev runs against a self-hosted Convex
                   instance
tests/             Vitest unit tests (scrape, normalize, scoring, providers,
                   vision, pipeline, consensus, report, email)
scripts/           Build helpers (frontend → dist/)
hackathon.md       Hackathon build log (Event: Convex All Gas Hackathon)
```

## Quick start

```bash
npm install
npx convex dev          # login + push schema/functions + watch
npm run build           # typecheck + build static frontend to dist/
npm test                # unit tests (vitest)

# One-shot live job without Convex scheduling (criteria from env, report to
# worker/state/) — useful for local dev/debugging the pipeline in isolation:
LOCAL_MAKE=Peugeot LOCAL_MODEL=208 LOCAL_MAX_PRICE=7000 LOCAL_REGION=Madrid \
  npm run worker -- --local
```

In production, jobs are NOT run by `npm run worker` — creating a job via
`api.create` (from the frontend form or `npx convex run api:create`)
automatically schedules `convex/pipelineAction.ts` inside the deployment.
There is nothing to start or keep running for a real search to work.

For a real email send, set the AgentMail vars on the deployment (see
Configuration below); without `AGENTMAIL_API_KEY` a send is recorded `failed`
with `AGENTMAIL_NOT_CONFIGURED`.

## Configuration

All secrets/env vars come from `npx convex env set` (production) or the
process environment (local `--local` dev only) — **never from the repo**.
`.env.local` / `.env.worker` are git-ignored and only matter for local dev;
the in-Convex pipeline action reads everything from the deployment's own
environment.

### Pipeline environment (Convex deployment env in production)

| Var | Default | Meaning |
|---|---|---|
| `MODEL_BASE_URL` | `http://localhost:8000/v1` | Local OpenAI-compatible endpoint (extraction + vision default) — only reachable from `--local` dev, NOT from the in-Convex action |
| `MODEL_NAME` | `qwen38-27b-unsloth-nvfp4-dflash2` | Served model id |
| `VISION_MODE` | `local_inference_only` | Governs whether the **secondary** vision provider may be used when the primary is unhealthy/non-vision: `local_inference_only` / `local_preferred`. Does not gate the primary provider itself. |
| `MODEL_IS_VISION` | `0` | Set to `1` only when the local model (used for vision if `VISION_PROVIDER=local`) accepts images |
| `VISION_PROVIDER` | `openai` | Which config is the **primary** vision provider: `openai` (default) or `local`. The other becomes the optional secondary, only used per `VISION_MODE` above. In production, `local` cannot reach a real endpoint (the action runs inside Convex, not on a machine with local network access) — keep `openai` in production. |
| `VISION_PRIMARY_BASE_URL` | `MODEL_BASE_URL` | Local vision endpoint override — used when `VISION_PROVIDER=local` |
| `VISION_PRIMARY_MODEL` | `MODEL_NAME` | Local vision model identifier — used when `VISION_PROVIDER=local` |
| `VISION_PRIMARY_PROVIDER` | inferred from host | Explicit provider kind (`vllm` / `openai_compat` / `ollama` / `lmstudio`) for the local vision config |
| `VISION_PRIMARY_API_KEY` | unset | Runtime key for the local vision endpoint when it needs one |
| `OPENAI_API_KEY` | unset | **Required for the default vision provider.** Without it, vision silently degrades to the local config as primary (still honest `no_evaluable` if that's also not vision-capable) |
| `OPENAI_VISION_MODEL` | `gpt-4o-mini` | Model id for OpenAI vision |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for an OpenAI-compatible vision endpoint |
| `TEXT_PROVIDER` | `openai` | Primary text-extraction provider: `openai` (default) or `local`. Only invoked when the deterministic regex parse can't find a card's price/km — reads only that card's own text, never invents a number. |
| `OPENAI_TEXT_MODEL` | `gpt-4o-mini` | Model id for the OpenAI text-repair provider |
| `VISION_MAX_PHOTOS_PER_CAR` | `1` | Default photos-per-ad cap for vision (and photo fetch) when a job doesn't set its own `maxPhotos`. Per-job override via the frontend Settings dialog / `maxPhotos` criteria field. |
| `FIRECRAWL_API_KEY` | unset | **Required** — Firecrawl runtime key used to scrape coches.net live; never commit it |
| `FIRECRAWL_BASE_URL` | `https://api.firecrawl.dev/v1` | Optional Firecrawl-compatible endpoint |
| `FIRECRAWL_MIN_INTERVAL_MS` | `3500` | Client-side pacing between Firecrawl requests (free plan: 20 req/min) |
| `AGENTMAIL_API_KEY` | unset | Convex env — required for a real email send |
| `AGENTMAIL_INBOX_ID` | created on first send | Optional existing AgentMail inbox |
| `AGENTMAIL_WEBHOOK_SECRET` | unset | Optional; bounce webhook at `/api/agentmail/webhook` |

Set these in production with, e.g.:

```bash
npx convex env set FIRECRAWL_API_KEY '<value>'
npx convex env set OPENAI_API_KEY '<value>'
npx convex env set OPENAI_VISION_MODEL gpt-4o-mini
npx convex env set OPENAI_TEXT_MODEL gpt-4o-mini
npx convex env set VISION_PROVIDER openai
npx convex env set TEXT_PROVIDER openai
npx convex env set VISION_MODE local_inference_only
npx convex env set VISION_MAX_PHOTOS_PER_CAR 1
```

`--local` one-shot criteria (dev only, reads from `.env.worker` / shell env,
not from Convex): `LOCAL_MAKE` (Toyota), `LOCAL_MODEL` (Yaris),
`LOCAL_MAX_PRICE` (5000), `LOCAL_REGION` (Barcelona), `LOCAL_MIN_YEAR`
(unset = no year filter). No other hardcoded criteria exist in the codebase.

### Firecrawl rate limits

A full job issues ~17 Firecrawl requests (up to 3 category pages + one ad page
per listing for photo enrichment). The free plan is a moving 20 req/min
window, so the client **paces** requests (`FIRECRAWL_MIN_INTERVAL_MS`, default
3.5 s) and **retries 429s** honoring the server's `retry after Ns` hint
(bounded to 3 attempts, then the job fails loudly with `FIRECRAWL_HTTP_429`).

### Legacy HTTP worker API (`convex/http.ts`) — kept for `--local` dev only

Production no longer uses this: `convex/pipelineAction.ts` calls the same
internal mutations directly via `ctx.runMutation`/`ctx.runQuery`, with no
HTTP hop and no `WORKER_API_KEY` needed. The `/api/worker/*` routes in
`convex/http.ts` still exist and are still reachable, but nothing in the
production path calls them anymore — they're inert unless something
external (e.g. a manual `--local`-style external worker) is pointed at them.
`WORKER_API_KEY` is still set on the production deployment as
defense-in-depth (closes the `x-worker-mode: dev` opt-in on those routes),
but it is not required for normal operation anymore.

## Optional search filters

- **Max km** and **minimum year** are both optional, per-job criteria (not
  worker env vars) — set from the frontend form or passed directly to
  `api:create`. Both are validated server-side (`convex/api.ts`): `minYear`
  must be an integer in `1980..2030` (rejected with `YEAR_OUT_OF_RANGE`
  otherwise).
- `minYear` is applied as a **client-side post-parse filter** in
  `worker/scrape.ts`, not a verified coches.net URL query parameter (unlike
  `maxPrice`, which is a confirmed URL param) — listings below the cutoff are
  dropped, but a listing whose year couldn't be parsed is always **kept**
  (the pipeline never excludes on data it doesn't have). Both `maxKm` and
  `minYear` are folded into the job's idempotency-key hash, so two searches
  that differ only by one of these fields never collide.

## Language

All user-facing text (frontend UI, the generated HTML report, the vision
model's free-text fields — `red_flags`/`exterior_details`/etc.) defaults to
**English**. The vision provider's fixed enum fields (`photo_type`,
`exterior_state`, `interior_state`, `cleanliness`) are normalized
defensively in `worker/vision.ts` regardless of what language the model
happens to answer in — this exists because an OpenAI-compatible model can
ignore prompt-level enum instructions (see the 2026-09-10 postmortem in
`hackathon.md`).

## What is intentionally NOT in this build

- **Authentication**: ownership is keyed on a client-supplied `userId` (a UUID
  in `localStorage`) rather than real auth. Real auth (OAuth / magic email) is
  Phase 3 per the plan. This is a Phase-1 deferral, not a production control.
- **Payments, share links with expiry** (schema placeholders exist).
- **A live AgentMail send** until `AGENTMAIL_API_KEY` is set on the deployment.
- **Full photo galleries**: each ad page yields only the images present in its
  static render (coches.net lazy-loads the rest); `maxPhotos` caps what vision
  analyzes and what the worker fetches.

## Verified live run

2026-08-28, `--local` one-shot, criteria `Peugeot 208 / €7000 / Madrid`:

- 16 live listings scraped + normalized (0 excluded), 2–3 real photos per ad
  enriched from the ad pages
- Vision: 32 real `gpt-4o-mini` calls (2 passes × 16), 3 listings rated
  exterior `bien` with details, remainder honest `no_evaluable`/`sin fotos`
- Report: `worker/state/local_report.html`, source label
  `coches.net (en vivo, scrape 28/08/2026 · madrid)`, top-3 adIds
  70948305 / 70900298 / 71175597

## Verified in production

2026-09-09, worker run against the live `glorious-monitor-400` deployment,
two independent searches (different criteria, no shared state):

- **Toyota Yaris, ≤ €8000, Barcelona** — submitted through the public form:
  8 real listings ranked, 0 excluded, completed in ~40s. Free-tier daily
  limit correctly rejected a second same-day search under the same
  `userId` with the friendly "free search already used" message (no raw
  server error).
- **Seat Ibiza, ≤ €6000, Madrid** — submitted with a fresh `userId` via
  `npx convex run api:create --prod` (confirms the free-tier limit is
  scoped per user, not global): 16 real listings ranked, 0 excluded,
  completed in ~2 min.

2026-09-10, worker run against `glorious-monitor-400`, after moving vision +
text extraction to OpenAI-by-default, capping vision to 1 photo/car by
default, translating the report/UI to English, and adding the optional
`minYear` filter:

- **Citroen C3, ≤ €6500, Valencia** — first attempt failed in prod
  (`ArgumentValidationError`): the vision model returned `photo_type:
  "professional"` (English) against a Spanish-only enum validator, an
  unintended side effect of an English-language instruction in the vision
  prompt. Fixed by normalizing `photoType` defensively in `worker/vision.ts`
  (same pattern already used for the other three enum fields) instead of
  relying on the model to honor the enum. Re-ran the identical search —
  completed cleanly.
- **Volkswagen Polo, ≤ €9000, Sevilla, minYear 2015** — 3 scraped, 1
  excluded (duplicate ad), 2 ranked (a 2017 and a 2015 listing — confirms
  the `minYear` filter dropped older cards without dropping cards it
  couldn't parse a year from). Report meta line correctly showed "2015+".

2026-09-10 (later), moved the pipeline to run **inside Convex** as a
Node-runtime action (`convex/pipelineAction.ts`) scheduled by `api.create`,
replacing the external polling worker entirely — production no longer
depends on any process running on a laptop, VPS, or any other host:

- **Seat Ibiza, ≤ €7000, Madrid** — created via `npx convex run api:create`
  with NO worker process running anywhere. Job status was `"claimed"`
  immediately (auto-scheduled), progressed scraping → vision → completed on
  its own, 26 real coches.net listings ranked, report served from Convex
  File Storage. Confirmed via the public browser form too: submission
  correctly enforced the daily free-tier limit for an already-used `userId`.

2026-09-10 (complete end-to-end user-workflow tests, twice, after the
in-Convex migration), simulating a real user from the public site with the
browser tool plus fresh `userId`s via the CLI:

- Round 1 (Renault Clio submission, ≤ €7500, Valencia): empty-form submit
  correctly blocked by native HTML5 required-field validation (no spurious
  job created); valid submission from an already-used `userId` correctly
  showed "Your free search for today has already been used. Try again
  tomorrow."; clicked into search history → realtime status view (progress
  bar, counts, ranking table) rendered correctly for a prior completed job;
  opened the full report — real coches.net listings, clickable title links,
  visual-inspection badges, email form with required confirmation checkbox
  all present and correct.
- Round 2 (fresh `userId`, Ford Focus ≤ €6000, Bilbao, `minYear: 2012`):
  `npx convex run api:create` returned `status: "claimed"` immediately; job
  completed in under 15s; report correctly showed "2012+" in the meta line
  and both ranked listings were 2012/2013 (no listing below the cutoff, none
  incorrectly dropped); one listing had no photos and was honestly marked
  "no photos" / "not evaluable" rather than invented. Also tried the browser
  form with a second, different search (Opel Corsa) — correctly rejected by
  the same-day free-tier limit for that browser's persisted `userId`,
  confirming the limit persists correctly across page navigations within
  one browser session.

Both reports were genuine HTML files served from Convex File Storage;
vision was honestly `0/N evaluable` in the 2026-09-09 runs (the configured
local vLLM model is text-only in this environment, as documented above) and
evaluable via `openai_compat/gpt-4o-mini` in the 2026-09-10 runs (OpenAI is
now the default vision provider).

## Tests

`npm test` runs the Vitest suite (57 tests, all green, 9 files): live
Firecrawl card parsing (incl. `€/mes` financing-line handling, photo host
filtering, pagination, 429 retry, request pacing, `minYear` filtering),
normalize/dedup on synthetic live-card rows, deterministic scoring, provider
selection + health/auth header + vLLM-vs-OpenAI body compatibility,
`maxPhotos` vision behavior against a mock OpenAI-compatible server
(including `photo_type` normalization for out-of-enum model responses),
consensus resolution, report rendering, the pipeline end-to-end with a
stubbed Convex client, and the email helpers (normalization, validation,
hashing, HTML→text, idempotency keys).
