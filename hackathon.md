# Hackathon log

- **Project:** Car Shopper
- **Event:** Convex All Gas Hackathon
- **What it does:** Local-AI car shopping comparison app. Scrapes listings, ranks by €/km, runs dual-model vision inspection, produces a ranked HTML report with consensus badges.
- **Live app:** not deployed
- **Repo:** https://github.com/PovedaAqui/car-shopper
- **Frontend:** Convex static hosting
- **Convex deployment:** local self-hosted
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, queries, mutations, actions, crons, HTTP actions, realtime subscriptions, File Storage
- **Auth:** none yet
- **AI models:** qwen38-27b-unsloth-nvfp4-dflash2 (local vLLM), Ollama/LM Studio adapters
- **Started:** 2026-08-26T16:25:21Z
- **Last updated:** 2026-08-26T17:52:00Z

## Log

### 2026-08-26 - initial
Set up project structure: Convex backend (schema, queries, mutations, subscriptions, crons, worker HTTP API), local worker (provider abstraction, scoring engine, vision pipeline, consensus, report renderer), frontend scaffold with realtime dashboard. Hackathon skill installed. TypeScript compiles clean (`npx tsc --noEmit`).