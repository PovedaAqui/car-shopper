# Car Shopper

Async car-comparison web app built for the **Convex All Gas Hackathon**.

A user submits search criteria (make, model, max price, region, optional max km).
A **local worker** runs a staged pipeline — scrape (fixtures in this build),
normalize, deterministic €/km scoring, two independent vision passes through a
local OpenAI-compatible endpoint, deterministic consensus + re-ranking, and an
HTML report — and writes every transition back to **Convex**, where the
dashboard updates **in realtime** via subscriptions. The finished report can be
viewed in the dashboard or **emailed to any address as an HTML body** (via
AgentMail, never as an attachment).

This is the **Phase 1 MVP** from the product plan (`car-compare-webapp-plan.md`):
fixtures, no production scraping, no payments. See §What is intentionally NOT
in this build.

## Stack

- **Backend / source of truth**: Convex (schema + collections, public + internal
  queries/mutations, actions, crons, realtime subscriptions, File Storage).
- **Frontend**: static site (vanilla TS, `frontend/`) built to `dist/` and served
  by the official `@convex-dev/static-hosting` component → `*.convex.site`.
- **Worker**: a plain Node/TS process (`worker/`) that polls Convex for `queued`
  jobs, runs the pipeline with the deterministic core + a local LLM provider
  abstraction, and writes results back through an authenticated Convex HTTP API.
- **Vision / extraction**: local OpenAI-compatible endpoint (default
  `http://localhost:8000/v1`, vLLM). Ollama (`:11434`) and LM Studio (`:1234`)
  adapters are included and health-gated; they are optional and never required.
- **Email delivery**: `@agentmail/convex` component. The report HTML is sent as
  the message body (multipart/alternative) with an idempotency key so a retry
  never sends the same report twice.

## Layout

```
convex/            Convex backend (schema, public + internal functions, crons,
                   HTTP router, email + email_send actions, AgentMail webhook)
frontend/          Static frontend sources (dashboard, form, report view, email form)
worker/            Local pipeline worker (providers, stages, report, convex client)
  fixtures/        Scraped-listing fixtures (20 Toyota Yaris, coches.net)
tests/             Vitest unit tests (scoring, providers, pipeline, consensus,
                   normalize, report, email)
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
npm run worker -- --local   # run one pipeline against fixtures, write state/locally
```

For a real email send, set the AgentMail vars on the deployment (see
Configuration below); without `AGENTMAIL_API_KEY` a send is recorded `failed`
with `AGENTMAIL_NOT_CONFIGURED`.

## Configuration

All secrets/env vars come from the environment or `npx convex env` — **never
from the repo**. `.env.local` is git-ignored.

| Var | Default | Meaning |
|---|---|---|
| `CONVEX_URL` | from `convex.json` | Deployment the worker polls/writes to |
| `CONVEX_SITE_URL` | derived | Base URL of the `convex.site` deployment (worker + worker API) |
| `WORKER_API_KEY` | — | Shared secret for worker HTTP writes (set via `npx convex env`) |
| `MODEL_BASE_URL` | `http://localhost:8000/v1` | Local OpenAI-compatible endpoint |
| `MODEL_NAME` | `qwen38-27b-unsloth-nvfp4-dflash2` | Served model id |
| `VISION_MODE` | `local_inference_only` | `local_inference_only` / `local_preferred` |
| `MODEL_IS_VISION` | `0` | Set to `1` only when the configured OpenAI-compatible model accepts images |
| `VISION_PRIMARY_BASE_URL` | `MODEL_BASE_URL` | Override the vision endpoint, e.g. an OpenRouter-compatible URL |
| `VISION_PRIMARY_MODEL` | `MODEL_NAME` | Override the vision model identifier |
| `OPENROUTER_API_KEY` | unset | Optional runtime key for an explicitly configured OpenRouter endpoint |
| `ALLOW_REFERENCE_VISION` | `0` | Demo/test-only opt-in to deterministic reference results; never enabled by default |
| `OLLAMA_URL` / `LMSTUDIO_URL` | off | Optional extra local providers |
| `USE_FIXTURES` | `1` | `1` = scrape stage reads fixtures (no production scraping in this build) |
| `USE_FIRECRAWL` | `0` | `1` = explicitly use the Firecrawl search adapter instead of fixtures |
| `FIRECRAWL_API_KEY` | unset | Firecrawl runtime key; never commit it |
| `FIRECRAWL_BASE_URL` | `https://api.firecrawl.dev/v1` | Optional Firecrawl-compatible endpoint |
| `AGENTMAIL_API_KEY` | unset | Convex env — required for a real email send |
| `AGENTMAIL_INBOX_ID` | created on first send | Optional existing AgentMail inbox |
| `AGENTMAIL_WEBHOOK_SECRET` | unset | Optional; bounce webhook at `/api/agentmail/webhook` |

### Worker auth — read before deploying to a public `convex.site`

The worker writes through an authenticated HTTP API (`convex/http.ts`).
When `WORKER_API_KEY` is set on the deployment, every write requires the shared
secret plus a per-job `workerToken` issued at claim time.

**Development caveat:** if `WORKER_API_KEY` is *not* set on the deployment, the
API accepts requests that send the `x-worker-mode: dev` header so the pipeline
can be exercised locally. That means a **public** deployment without the key set
exposes an unauthenticated write surface. **Always set `WORKER_API_KEY` via
`npx convex env set WORKER_API_KEY …` before exposing this app publicly.** The
README and code call this out deliberately rather than hiding it.

## What is intentionally NOT in this build

- **Production scraping of coches.net** (ToS) — the scrape stage is served from
  fixtures mirroring the real 2026-08-26 session (20 listings).
- **Authentication**: ownership is keyed on a client-supplied `userId` (a UUID
  in `localStorage`) rather than real auth. Real auth (OAuth / magic email) is
  Phase 3 per the plan. This is a Phase-1 deferral, not a production control.
- **Payments, share links with expiry** (schema placeholders exist).
- **A live AgentMail send** until `AGENTMAIL_API_KEY` is set on the deployment.
- **Deployment / hackathon submission** (explicitly out of scope unless asked).

## Tests

`npm test` runs the Vitest suite: deterministic scoring, provider selection,
normalize/dedup (the 370 €/568 km and 71108396/71108671 lessons), consensus
resolution, report rendering, the pipeline end-to-end with a stubbed Convex
client, and the email helpers (normalization, validation, hashing, HTML→text,
idempotency keys). All green.
