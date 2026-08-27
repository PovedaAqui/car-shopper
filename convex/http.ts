import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { AgentMail } from "@agentmail/convex";

/**
 * Authenticated HTTP API for the local worker.
 *
 * Convex discovers the application's HTTP router from this file. Cloud
 * actions cannot reach the operator's localhost (Ollama, LM Studio, vLLM),
 * so the local worker claims jobs and writes results through these routes.
 *
 * Local/self-hosted development: if `WORKER_API_KEY` is not set on the
 * deployment, callers may opt in with the `x-worker-mode: dev` header.
 * Production deployments MUST set the key so the dev opt-in is closed.
 */

const router = httpRouter();

function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function json(status: number, body: Record<string, unknown>, requestId: string): Response {
  return new Response(JSON.stringify({ request_id: requestId, ...body }), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

function authHeader(ctx: any, request: Request): boolean {
  const expected: string | undefined =
    (ctx.env && ctx.env.WORKER_API_KEY) ||
    (globalThis as any).process?.env?.WORKER_API_KEY;
  if (!expected) return (request.headers.get("x-worker-mode") ?? "") === "dev";
  const provided = request.headers.get("x-worker-key");
  return provided !== null && provided === expected;
}

const requiredFields: Record<string, string[]> = {
  claimJob: ["workerId"],
  updateStage: ["jobId", "workerToken", "stage", "progress"],
  failJob: ["jobId", "workerToken", "errorCode", "errorMsg"],
  insertListings: ["jobId", "workerToken", "listings"],
  insertScores: ["jobId", "workerToken", "scores"],
  insertVisionResults: ["jobId", "workerToken", "results"],
  insertConsensus: ["jobId", "workerToken", "rows"],
  createReport: ["jobId", "workerToken", "htmlStorageId", "reportVersion", "listingCount"],
  getJobSnapshot: ["jobId", "workerToken"],
};

function validateBody(functionName: string, body: Record<string, unknown>): string | null {
  for (const field of requiredFields[functionName] ?? []) {
    if (!(field in body) || body[field] === undefined || body[field] === null) {
      return `missing required field: ${field}`;
    }
  }
  if (functionName === "claimJob" && typeof body.workerId !== "string") return "workerId must be a string";
  if (functionName === "updateStage" && typeof body.progress !== "number") return "progress must be a number";
  return null;
}

async function readJsonObject(request: Request): Promise<
  { body: Record<string, unknown>; error: null } | { body: null; error: string }
> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { body: null, error: "request body must be a JSON object" };
    }
    return { body: value as Record<string, unknown>, error: null };
  } catch {
    return { body: null, error: "request body must be valid JSON" };
  }
}

const mutationRoutes = [
  { path: "/worker/claim", fn: "claimJob" },
  { path: "/worker/stage", fn: "updateStage" },
  { path: "/worker/fail", fn: "failJob" },
  { path: "/worker/listings", fn: "insertListings" },
  { path: "/worker/scores", fn: "insertScores" },
  { path: "/worker/vision", fn: "insertVisionResults" },
  { path: "/worker/consensus", fn: "insertConsensus" },
  { path: "/worker/report", fn: "createReport" },
] as const;

for (const { path, fn } of mutationRoutes) {
  router.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const requestId = request.headers.get("x-request-id") || newRequestId();
      if (!authHeader(ctx, request)) return json(401, { error: "unauthorized" }, requestId);
      const parsed = await readJsonObject(request);
      if (parsed.body === null) return json(400, { error: parsed.error }, requestId);
      const body = parsed.body;
      const validationError = validateBody(fn, body);
      if (validationError) return json(400, { error: validationError }, requestId);
      const api: Record<string, any> = internal.api as any;
      const fnRef = api[fn];
      try {
        const result = await ctx.runMutation(fnRef, body as any);
        return json(200, { ok: true, result: result ?? null }, requestId);
      } catch (e: any) {
        return json(500, { error: e?.message ?? String(e) }, requestId);
      }
    }),
  });
}

router.route({
  path: "/worker/snapshot",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const requestId = request.headers.get("x-request-id") || newRequestId();
    if (!authHeader(ctx, request)) return json(401, { error: "unauthorized" }, requestId);
    const parsed = await readJsonObject(request);
    if (parsed.body === null) return json(400, { error: parsed.error }, requestId);
    const body = parsed.body;
    const validationError = validateBody("getJobSnapshot", body);
    if (validationError) return json(400, { error: validationError }, requestId);
    try {
      const result = await ctx.runQuery(internal.api.getJobSnapshot, body as any);
      return json(200, { ok: true, result }, requestId);
    } catch (e: any) {
      return json(500, { error: e?.message ?? String(e) }, requestId);
    }
  }),
});

/** Store an HTML report blob and return its Convex storage id. */
router.route({
  path: "/worker/report_upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const requestId = request.headers.get("x-request-id") || newRequestId();
    if (!authHeader(ctx, request)) return json(401, { error: "unauthorized" }, requestId);
    let html = await request.text();
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && html.startsWith("\"")) {
      try {
        const parsed: unknown = JSON.parse(html);
        if (typeof parsed === "string") html = parsed;
      } catch {
        // Keep the raw body; size validation below still applies.
      }
    }
    if (!html || html.length > 1_000_000) {
      return json(400, { error: "invalid html size" }, requestId);
    }
    const storageId = await ctx.storage.store(new Blob([html], { type: "text/html" }));
    return json(200, { storageId }, requestId);
  }),
});

const agentmail = new AgentMail(components.agentmail);
router.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => agentmail.handleWebhook(ctx as any, req)),
});

export default router;
