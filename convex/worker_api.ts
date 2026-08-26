import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Authenticated HTTP API for the local worker (Convex 1.45 API).
 *
 * Convex cloud actions cannot reach the operator's localhost (Ollama, LM
 * Studio, vLLM). The worker therefore claims jobs and writes results through
 * these HTTP endpoints, authenticated with a shared `WORKER_API_KEY` secret
 * (set via `npx convex env set WORKER_API_KEY ...` — never in the repo).
 *
 * Local/self-hosted development: if `WORKER_API_KEY` is not set on the
 * deployment, callers may opt in with the `x-worker-mode: dev` header.
 * Production deployments MUST set the key so the dev opt-in is closed.
 */

const router = httpRouter();

function authHeader(ctx: any, request: Request): boolean {
  // `ctx.env` is not exposed on the typed action ctx; the runtime injects
  // deployment env vars onto `process.env` for node actions. Fall back to
  // the locally-built env map (dev).
  const expected: string | undefined =
    (ctx.env && ctx.env.WORKER_API_KEY) ||
    (globalThis as any).process?.env?.WORKER_API_KEY;
  if (!expected) return (request.headers.get("x-worker-mode") ?? "") === "dev";
  const provided = request.headers.get("x-worker-key");
  return provided !== null && provided === expected;
}

const routes = [
  { path: "/worker/claim", fn: "claimJob" },
  { path: "/worker/stage", fn: "updateStage" },
  { path: "/worker/fail", fn: "failJob" },
  { path: "/worker/listings", fn: "insertListings" },
  { path: "/worker/scores", fn: "insertScores" },
  { path: "/worker/vision", fn: "insertVisionResults" },
  { path: "/worker/consensus", fn: "insertConsensus" },
  { path: "/worker/report", fn: "createReport" },
] as const;

for (const { path, fn } of routes) {
  router.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!authHeader(ctx, request)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const body = await request.json();
      const api: Record<string, any> = internal.api as any;
      const fnRef = api[fn];
      let result: unknown;
      try {
        result = await ctx.runMutation(fnRef, body);
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: result ?? null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  });
}

/**
 * POST /worker/report_upload -> store an HTML blob and return its storage id.
 * The worker then calls /worker/report with that id (createReport).
 */
router.route({
  path: "/worker/report_upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authHeader(ctx, request)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    const html = await request.text();
    if (!html || html.length > 1_000_000) {
      return new Response(JSON.stringify({ error: "invalid html size" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const storageId = await ctx.storage.store(new Blob([html], { type: "text/html" }));
    return new Response(JSON.stringify({ storageId }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
});

export default router;
