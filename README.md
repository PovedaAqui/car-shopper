# Car Shopper

Async car-comparison web app (Convex All Gas Hackathon).

A user submits search criteria (make, model, max price, region, optional max km).
A **local worker** runs a staged pipeline — scrape (fixtures in this build),
normalize, deterministic €/km scoring, optional AI vision inspection via a local
OpenAI-compatible endpoint (vLLM serving `qwen38-27b-unsloth-nvfp4-dflash2`),
deterministic consensus + re-ranking, and an HTML report — and writes every
transition back to **Convex**, where the dashboard updates **in realtime** via
subscriptions.

## Stack

- **Backend / source of truth**: Convex (collections, queries, mutations,
  internal mutations, subscriptions, file storage for the HTML report).
- **Frontend**: static site (vanilla TS) deployed via the official
  `@convex-dev/static-hosting` component → `*.convex.site`.
- **Worker**: plain Node/TS process that polls Convex for `queued` jobs,
  executes the pipeline with the deterministic core + local LLM provider
  abstraction, and reports results back through authenticated Convex HTTP
  actions.
- **Vision / extraction**: local OpenAI-compatible endpoint (default
  `http://localhost:8000/v1`, vLLM). Ollama (`:11434`) and LM Studio (`:1234`)
  adapters are included and health-gated; they are optional and never required.

## Layout

```
convex/            Convex backend (schema, public + internal functions, crons)
frontend/          Static frontend sources (dashboard, form, report view)
worker/            Local pipeline worker (providers, stages, report)
  fixtures/        Scraped-listing fixtures (20 Toyota Yaris, coches.net)
tests/             Vitest unit tests (scoring, providers, pipeline, consensus)
scripts/           Build helpers (frontend → dist/)
hackathon.md       Hackathon build log (Event: Convex All Gas Hackathon)
```

## Quick start

```bash
npm install
npx convex dev          # login + deploy schema + watch (or `npx convex local start` for local-only)
npm run worker          # run the local worker (polls the deployment for jobs)
npm run build           # typecheck + build static frontend to dist/
npm test                # unit tests
```

## Configuration

All secrets/env vars come from environment or `npx convex env` — never from the
repo. Worker env:

| Var | Default | Meaning |
|---|---|---|
| `CONVEX_URL` | from `convex.json` | Deployment to poll/write |
| `WORKER_API_KEY` | required for write mutations | Shared secret for worker HTTP writes |
| `MODEL_BASE_URL` | `http://localhost:8000/v1` | Local OpenAI-compatible endpoint |
| `MODEL_NAME` | `qwen38-27b-unsloth-nvfp4-dflash2` | Served model id |
| `VISION_MODE` | `local_inference_only` | `local_inference_only` / `local_preferred` |
| `OLLAMA_URL` / `LMSTUDIO_URL` | off | Optional extra local providers |
| `USE_FIXTURES` | `1` | `1` = scrape stage uses fixtures (no production scraping in this build) |

## What is intentionally NOT in this build

- Production scraping of coches.net (ToS) — the scrape stage is served from
  fixtures mirroring the real 2026-08-26 session (20 listings).
- Payments, email delivery, shared links with expiry (schema placeholders exist).
- Deployment / hackathon submission (explicitly out of scope for this task).
