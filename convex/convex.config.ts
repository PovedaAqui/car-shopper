import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import agentmail from "@agentmail/convex/convex.config";

/**
 * App definition (Convex 1.45).
 *
 * The static-hosting component owns `/` and serves the built frontend from
 * `dist/` at <deployment>.convex.site. The app's own HTTP routes (the worker
 * API in http.ts) are mounted under `/api`, so the worker talks to
 * {site}/api/worker/* and AgentMail webhooks land on {site}/api/agentmail/webhook.
 */
const app = defineApp({ httpPrefix: "/api" });
app.use(staticHosting, { httpPrefix: "/" });
app.use(agentmail);

export default app;
