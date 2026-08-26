import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

/**
 * App definition (Convex 1.45).
 *
 * The static-hosting component owns `/` and serves the built frontend from
 * `dist/` at <deployment>.convex.site. The app's own HTTP routes (the worker
 * API in worker_api.ts) are mounted under `/api`, so the worker talks to
 * {site}/api/worker/*.
 */
const app = defineApp({ httpPrefix: "/api" });
app.use(staticHosting, { httpPrefix: "/" });

export default app;
