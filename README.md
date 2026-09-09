# Car Shopper

Async car-comparison web app built for the **Convex All Gas Hackathon**.

A user submits search criteria (make, model, max price, region, optional max
km). A **local worker** runs a staged pipeline and writes every transition back
to **Convex**, where the dashboard updates **in realtime** via subscriptions.
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
   (default 3, `0` = vision explicitly disabled).
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
  internal queries/mutations, actions, crons, realtime subscriptions, File
  Storage).
- **Frontend**: static site (vanilla TS, `frontend/`) built to `dist/` and
  served by the official `@convex-dev/static-hosting` component →
  `*.convex.site`.
- **Worker**: a plain Node/TS process (`worker/`) that polls Convex for
  `queued` jobs, runs the pipeline, and writes results back through an
  authenticated Convex HTTP API.
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
convex/            Convex backend (schema, public + internal functions, crons,
                   HTTP router, email + email_send actions, AgentMail webhook)
frontend/          Static frontend sources (dashboard, form, report view,
                   email form, session settings incl. maxPhotos)
worker/            Local pipeline worker (scrape, providers, stages, report,
                   convex client)
tests/             Vitest unit tests (scrape, normalize, scoring, providers,
                   vision, pipeline, consensus, report, email)
scripts/           Build helpers (frontend → dist/)
hackathon.md       Hackathon build log (Event: Convex All Gas Hackathon)
```

## Quick start

```bash
npm install
npx convex dev          # login + push schema/functions + watch
npm run worker          # run the local worker (polls the deployment for jobs)
npm run build           # typecheck + build static frontend to dist/
npm test                # unit tests (vitest)

# One-shot live job without Convex (criteria from env, report to worker/state/):
LOCAL_MAKE=Peugeot LOCAL_MODEL=208 LOCAL_MAX_PRICE=7000 LOCAL_REGION=Madrid \
  npm run worker -- --local
```

For a real email send, set the AgentMail vars on the deployment (see
Configuration below); without `AGENTMAIL_API_KEY` a send is recorded `failed`
with `AGENTMAIL_NOT_CONFIGURED`.

## Configuration

All secrets/env vars come from the environment or `npx convex env` — **never
from the repo**. `.env.local` / `.env.worker` are git-ignored.

### Worker

| Var | Default | Meaning |
|---|---|---|
| `CONVEX_URL` | from `convex.json` | Deployment the worker polls/writes to |
| `CONVEX_SITE_URL` | derived | Base URL of the `convex.site` deployment (worker + worker API) |
| `WORKER_API_KEY` | — | Shared secret for worker HTTP writes (set via `npx convex env`) |
| `MODEL_BASE_URL` | `http://localhost:8000/v1` | Local OpenAI-compatible endpoint (extraction + vision default) |
| `MODEL_NAME` | `qwen38-27b-unsloth-nvfp4-dflash2` | Served model id |
| `VISION_MODE` | `local_inference_only` | `local_inference_only` / `local_preferred` |
| `MODEL_IS_VISION` | `0` | Set to `1` only when the configured vision model accepts images |
| `VISION_PRIMARY_BASE_URL` | `MODEL_BASE_URL` | Vision endpoint override — local **or** remote OpenAI-compatible (e.g. `https://api.openai.com/v1`) |
| `VISION_PRIMARY_MODEL` | `MODEL_NAME` | Vision model identifier |
| `VISION_PRIMARY_PROVIDER` | inferred from host | Explicit provider kind (`vllm` / `openai_compat` / `ollama` / `lmstudio`) |
| `OPENROUTER_API_KEY` | unset | Runtime key for the vision endpoint when it needs one (e.g. a remote OpenAI-compatible API) |
| `FIRECRAWL_API_KEY` | unset | **Required** — Firecrawl runtime key used to scrape coches.net live; never commit it |
| `FIRECRAWL_BASE_URL` | `https://api.firecrawl.dev/v1` | Optional Firecrawl-compatible endpoint |
| `FIRECRAWL_MIN_INTERVAL_MS` | `3500` | Client-side pacing between Firecrawl requests (free plan: 20 req/min) |
| `AGENTMAIL_API_KEY` | unset | Convex env — required for a real email send |
| `AGENTMAIL_INBOX_ID` | created on first send | Optional existing AgentMail inbox |
| `AGENTMAIL_WEBHOOK_SECRET` | unset | Optional; bounce webhook at `/api/agentmail/webhook` |

`--local` one-shot criteria: `LOCAL_MAKE` (Toyota), `LOCAL_MODEL` (Yaris),
`LOCAL_MAX_PRICE` (5000), `LOCAL_REGION` (Barcelona). No other hardcoded
criteria exist in the codebase.

### Firecrawl rate limits

A full job issues ~17 Firecrawl requests (up to 3 category pages + one ad page
per listing for photo enrichment). The free plan is a moving 20 req/min
window, so the client **paces** requests (`FIRECRAWL_MIN_INTERVAL_MS`, default
3.5 s) and **retries 429s** honoring the server's `retry after Ns` hint
(bounded to 3 attempts, then the job fails loudly with `FIRECRAWL_HTTP_429`).

### Worker auth — read before deploying to a public `convex.site`

The worker writes through an authenticated HTTP API (`convex/http.ts`).
When `WORKER_API_KEY` is set on the deployment, every write requires the
shared secret plus a per-job `workerToken` issued at claim time.

**Development caveat:** if `WORKER_API_KEY` is *not* set on the deployment, the
API accepts requests that send the `x-worker-mode: dev` header so the pipeline
can be exercised locally. That means a **public** deployment without the key
set exposes an unauthenticated write surface. **Always set
`WORKER_API_KEY` via `npx convex env set WORKER_API_KEY …` before exposing
this app publicly.** The README and code call this out deliberately rather
than hiding it.

The production deployment (`glorious-monitor-400`) has `WORKER_API_KEY` set;
the dev opt-in is closed there. Confirm with `npx convex env list`.

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

Both reports were genuine HTML files served from Convex File Storage;
vision was honestly `0/N evaluable` in both runs (the configured local
vLLM model is text-only in this environment, as documented above).

## Tests

`npm test` runs the Vitest suite (38 tests, all green): live Firecrawl card
parsing (incl. `€/mes` financing-line handling, photo host filtering,
pagination, 429 retry, request pacing), normalize/dedup on synthetic live-card
rows, deterministic scoring, provider selection + health/auth header +
vLLM-vs-OpenAI body compatibility, `maxPhotos` vision behavior against a
mock OpenAI-compatible server, consensus resolution, report rendering, the
pipeline end-to-end with a stubbed Convex client, and the email helpers
(normalization, validation, hashing, HTML→text, idempotency keys).
