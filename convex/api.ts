import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * Public queries/mutations for the Car Shopper frontend (Convex 1.45 API).
 *
 * The frontend never authenticates with a token in this MVP: ownership is by
 * the opaque `userId` (anonymous, client-generated UUID in localStorage).
 * The local worker writes results exclusively through the authenticated HTTP
 * API (convex/http.ts).
 */

/**
 * Create a search job.
 * Free tier: at most 1 job per user per day (checked via credits table).
 * Idempotent per (userId, day, criteria-hash).
 */
export const create = mutation({
  args: {
    userId: v.string(),
    criteria: v.object({
      make: v.string(),
      model: v.string(),
      maxPrice: v.number(),
      region: v.string(),
      maxKm: v.optional(v.number()),
      maxPhotos: v.optional(v.number()),
      minYear: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    if (args.criteria.maxPrice < 100 || args.criteria.maxPrice > 1_000_000) {
      // Return (not throw): production Convex redacts thrown error messages,
      // so the marker would not reach the client to render a friendly message.
      return { jobId: null, code: "PRICE_OUT_OF_RANGE", status: "rejected" as const };
    }
    if (args.criteria.maxPhotos !== undefined) {
      // 0 = vision deactivated; positive integer = photos per ad cap.
      if (!Number.isInteger(args.criteria.maxPhotos) || args.criteria.maxPhotos < 0) {
        return { jobId: null, code: "PHOTOS_OUT_OF_RANGE", status: "rejected" as const };
      }
    }
    if (args.criteria.minYear !== undefined) {
      if (!Number.isInteger(args.criteria.minYear) || args.criteria.minYear < 1980 || args.criteria.minYear > 2030) {
        return { jobId: null, code: "YEAR_OUT_OF_RANGE", status: "rejected" as const };
      }
    }
    const now = Date.now();
    const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
    const requestId = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    const existingUser = await ctx.db.query("users").withIndex("by_userId", (q) => q.eq("userId", args.userId)).unique();
    if (!existingUser) {
      await ctx.db.insert("users", { userId: args.userId, createdAt: now });
      await ctx.db.insert("credits", {
        userId: args.userId,
        kind: "free_daily",
        amount: 1,
        createdAt: now,
      });
    }

    const credits = (await ctx.db.query("credits").withIndex("by_user_kind", (q) => q.eq("userId", args.userId).eq("kind", "free_daily")).collect())
      .filter((c) => c.createdAt >= dayStart);
    const available = credits.filter((c) => c.consumedByJobId === undefined).length;
    if (available < 1) {
      // Return (not throw): production Convex redacts thrown error messages, so
      // a thrown FREE_TIER_EXHAUSTED would arrive as a generic "Server Error"
      // and the friendly message could never render. Return the marker instead.
      return { jobId: null, code: "FREE_TIER_EXHAUSTED", status: "rejected" as const };
    }

    const idempotencyKey = `${args.userId}:${hashCriteria(args.criteria)}`;
    const existing = (await ctx.db.query("jobs").withIndex("by_user", (q) => q.eq("userId", args.userId)).collect())
      .filter((j) => j.idempotencyKey === idempotencyKey && j.createdAt >= dayStart && !["failed", "cancelled", "expired"].includes(j.status));
    if (existing.length > 0) {
      return { jobId: existing[0]._id, requestId: existing[0].requestId ?? requestId, status: existing[0].status };
    }

    // The pipeline now runs INSIDE Convex as a scheduled Node action
    // (convex/pipelineAction.ts) instead of an external polling worker — the
    // job is "claimed" by that action immediately, using the same
    // workerToken contract the HTTP worker API (convex/http.ts) already
    // enforces, so insertListings/insertScores/etc. don't need any changes.
    const token = `convex-action:${now}:${Math.random().toString(36).slice(2)}`;
    const jobId = await ctx.db.insert("jobs", {
      userId: args.userId,
      idempotencyKey,
      criteria: args.criteria,
      status: "claimed",
      stage: "scraping",
      progress: 2,
      workerToken: token,
      claimedAt: now,
      counts: {
        scraped: 0,
        valid: 0,
        excluded: 0,
        visionEvaluable: 0,
        visionNoEvaluable: 0,
      },
      createdAt: now,
      requestId,
    });

    const credit = credits
      .filter((c) => c.consumedByJobId === undefined)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (credit) {
      await ctx.db.patch("credits", credit._id, { consumedByJobId: jobId });
    }

    await ctx.scheduler.runAfter(0, internal.pipelineAction.run, { jobId, token });

    return { jobId, requestId, status: "claimed" as const };
  },
});

export const getJob = query({
  args: { jobId: v.id("jobs"), userId: v.string() },
  handler: async (ctx, { jobId, userId }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job || job.userId !== userId) return null;
    return job;
  },
});

export const listJobs = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const jobs = await ctx.db.query("jobs").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    jobs.sort((a, b) => b.createdAt - a.createdAt);
    return jobs.map(publicJobView);
  },
});

/**
 * Report delivery. HTML is stored in Convex File Storage; queries cannot read
 * file content, so we return a URL the frontend fetches.
 */
export const getReport = query({
  args: { jobId: v.id("jobs"), userId: v.string() },
  handler: async (ctx, { jobId, userId }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job || job.userId !== userId) return null;
    const report = await ctx.db.query("reports").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
    if (!report) return null;
    const url = await ctx.storage.getUrl(report.htmlStorageId);
    return {
      reportVersion: report.reportVersion,
      listingCount: report.listingCount,
      url,
      createdAt: report.createdAt,
    };
  },
});

/** Realtime subscription: the dashboard job view updates on every transition. */
export const watchJob = query({
  args: { jobId: v.id("jobs"), userId: v.string() },
  handler: async (ctx, { jobId, userId }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job || job.userId !== userId) return null;
    const report = await ctx.db.query("reports").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
    return {
      ...publicJobView(job),
      hasReport: report !== null,
      reportVersion: report?.reportVersion ?? null,
    };
  },
});

export const watchScores = query({
  args: { jobId: v.id("jobs"), userId: v.string() },
  handler: async (ctx, { jobId, userId }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job || job.userId !== userId) return [];
    const scores = await ctx.db.query("scores").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const listings = await ctx.db.query("listings").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const byAd = new Map(listings.map((l) => [l.adId, l]));
    const finalScores = scores.some((s) => s.scorerVersion.endsWith("-v2"))
      ? scores.filter((s) => s.scorerVersion.endsWith("-v2"))
      : scores.filter((s) => s.scorerVersion.endsWith("-v1"));
    return finalScores
      .map((s) => {
        const l = byAd.get(s.adId);
        return {
          adId: s.adId,
          rank: s.rank,
          final: s.final,
          base: s.base,
          visDelta: s.visDelta,
          pricePerKm: s.pricePerKm,
          title: l?.title ?? s.adId,
          price: l?.price ?? 0,
          km: l?.km ?? 0,
          year: l?.year ?? null,
          city: l?.city ?? null,
          photoCount: l?.photoCount ?? 0,
          dataQualityFlag: l?.dataQualityFlag ?? "ok",
        };
      })
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  },
});

export const watchVision = query({
  args: { jobId: v.id("jobs"), userId: v.string() },
  handler: async (ctx, { jobId, userId }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job || job.userId !== userId) return [];
    const results = await ctx.db.query("visionResults").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const consensus = await ctx.db.query("consensus").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    return results.map((r) => {
      const c = consensus.find((x) => x.adId === r.adId);
      return {
        adId: r.adId,
        step: r.step,
        provider: r.provider,
        model: r.model,
        photosAnalyzed: r.photosAnalyzed,
        exteriorState: r.exteriorState,
        interiorState: r.interiorState,
        cleanliness: r.cleanliness,
        color: r.color ?? null,
        redFlags: r.redFlags,
        badge: c?.badge ?? null,
        agreed: c?.agreed ?? null,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export const byStatus = internalQuery({
  args: { status: v.string() },
  handler: async (ctx, { status }) => {
    return await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", status as any))
      .collect();
  },
});

/** Read-only helper for pipelineAction.ts (the in-Convex pipeline runner). */
export const getJobForAction = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    return await ctx.db.get("jobs", jobId);
  },
});

// ---------------------------------------------------------------------------
// Internal mutations used by the worker HTTP API (http.ts)
// ---------------------------------------------------------------------------

const STAGES = [
  "queued",
  "scraping",
  "normalizing",
  "ranking",
  "vision",
  "consensus",
  "reporting",
  "completed",
] as const;

export const claimJob = internalMutation({
  args: { workerId: v.string() },
  handler: async (ctx, { workerId }) => {
    const now = Date.now();
    const claimed = await ctx.db.query("jobs").withIndex("by_status", (q) => q.eq("status", "claimed")).collect();
    for (const j of claimed) {
      if (j.claimedAt !== undefined && now - j.claimedAt > 10 * 60_000) {
        await ctx.db.patch("jobs", j._id, {
          status: "queued",
          stage: j.lastCompletedStage ?? j.stage,
          workerToken: undefined,
        });
      }
    }
    const queued = await ctx.db.query("jobs").withIndex("by_status", (q) => q.eq("status", "queued")).collect();
    const job = [...queued].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return null;
    const token = `${workerId}:${now}:${Math.random().toString(36).slice(2)}`;
    const resumeStage = job.lastCompletedStage && job.lastCompletedStage !== "queued" ? job.stage : "scraping";
    await ctx.db.patch("jobs", job._id, {
      status: "claimed",
      stage: resumeStage,
      progress: job.progress > 0 ? job.progress : 2,
      workerToken: token,
      claimedAt: now,
    });
    return { jobId: job._id, token, criteria: job.criteria, requestId: job.requestId ?? null };
  },
});

async function requireWorkerToken(ctx: any, jobId: any, workerToken: string) {
  const job = await ctx.db.get("jobs", jobId);
  if (!job) throw new Error("job not found");
  if (!job.workerToken || job.workerToken !== workerToken) throw new Error("WORKER_TOKEN_MISMATCH");
  return job;
}

export const updateStage = internalMutation({
  args: {
    jobId: v.id("jobs"),
    workerToken: v.string(),
    stage: v.union(...STAGES.map((s) => v.literal(s))),
    progress: v.number(),
    counts: v.optional(
      v.object({
        scraped: v.optional(v.number()),
        valid: v.optional(v.number()),
        excluded: v.optional(v.number()),
        visionEvaluable: v.optional(v.number()),
        visionNoEvaluable: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const job = await requireWorkerToken(ctx, args.jobId, args.workerToken);
    const counts = { ...job.counts };
    if (args.counts) {
      for (const k of Object.keys(args.counts) as (keyof typeof counts)[]) {
        const nv = (args.counts as any)[k];
        if (nv !== undefined) counts[k] = nv;
      }
    }
    await ctx.db.patch("jobs", job._id, {
      stage: args.stage,
      status: args.stage === "completed" ? "completed" : args.stage,
      progress: args.progress,
      counts,
      lastCompletedStage: args.stage,
      finishedAt: args.stage === "completed" ? Date.now() : job.finishedAt,
    });
  },
});

export const failJob = internalMutation({
  args: { jobId: v.id("jobs"), workerToken: v.string(), errorCode: v.string(), errorMsg: v.string() },
  handler: async (ctx, { jobId, workerToken, errorCode, errorMsg }) => {
    const job = await requireWorkerToken(ctx, jobId, workerToken);
    await ctx.db.patch("jobs", job._id, {
      status: "failed",
      errorCode,
      errorMsg,
      finishedAt: Date.now(),
    });
  },
});

export const insertListings = internalMutation({
  args: {
    jobId: v.id("jobs"),
    workerToken: v.string(),
    listings: v.array(
      v.object({
        source: v.string(),
        adId: v.string(),
        sourceUrl: v.string(),
        title: v.string(),
        price: v.number(),
        km: v.number(),
        year: v.optional(v.number()),
        fuel: v.optional(v.string()),
        city: v.optional(v.string()),
        hasWarranty: v.boolean(),
        isPro: v.boolean(),
        photoCount: v.number(),
        photoUrls: v.array(v.string()),
        dataQualityFlag: v.union(v.literal("ok"), v.literal("corrupt"), v.literal("duplicate")),
        duplicateOfAdId: v.optional(v.string()),
        fetchedAt: v.number(),
      })
    ),
  },
  handler: async (ctx, { jobId, workerToken, listings }) => {
    await requireWorkerToken(ctx, jobId, workerToken);
    for (const l of listings) {
      const existing = await ctx.db.query("listings").withIndex("by_job_ad", (q) => q.eq("jobId", jobId).eq("adId", l.adId)).first();
      if (existing) continue;
      await ctx.db.insert("listings", { jobId, ...l });
    }
  },
});

export const insertScores = internalMutation({
  args: {
    jobId: v.id("jobs"),
    workerToken: v.string(),
    scores: v.array(
      v.object({
        adId: v.string(),
        scorerVersion: v.string(),
        base: v.number(),
        bonuses: v.number(),
        riskFactor: v.number(),
        visDelta: v.number(),
        final: v.number(),
        rank: v.optional(v.number()),
        pricePerKm: v.number(),
        notes: v.array(v.string()),
      })
    ),
  },
  handler: async (ctx, { jobId, workerToken, scores }) => {
    await requireWorkerToken(ctx, jobId, workerToken);
    const existing = await ctx.db.query("scores").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const seen = new Set(existing.map((s) => `${s.adId}:${s.scorerVersion}`));
    for (const s of scores) {
      if (seen.has(`${s.adId}:${s.scorerVersion}`)) continue;
      await ctx.db.insert("scores", { jobId, ...s });
    }
  },
});

export const insertVisionResults = internalMutation({
  args: {
    jobId: v.id("jobs"),
    workerToken: v.string(),
    results: v.array(
      v.object({
        adId: v.string(),
        provider: v.string(),
        model: v.string(),
        step: v.union(v.literal("primary"), v.literal("reverify")),
        promptVersion: v.string(),
        photosAnalyzed: v.number(),
        photoType: v.optional(
          v.union(v.literal("profesional"), v.literal("amateur"), v.literal("sin_fotos"), v.literal("stock_sospechoso"))
        ),
        exteriorState: v.union(v.literal("bien"), v.literal("regular"), v.literal("mal"), v.literal("no_evaluable")),
        interiorState: v.union(v.literal("bien"), v.literal("regular"), v.literal("mal"), v.literal("no_evaluable")),
        cleanliness: v.union(v.literal("limpio"), v.literal("regular"), v.literal("descuidado"), v.literal("no_evaluable")),
        color: v.optional(v.string()),
        redFlags: v.array(v.string()),
        details: v.optional(v.string()),
        noEvaluableReason: v.optional(v.string()),
        rawResponse: v.optional(v.string()),
        fallbackReason: v.optional(v.string()),
        costEur: v.optional(v.number()),
        latencyMs: v.optional(v.number()),
        inputTokens: v.optional(v.number()),
        outputTokens: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, { jobId, workerToken, results }) => {
    await requireWorkerToken(ctx, jobId, workerToken);
    const existing = await ctx.db.query("visionResults").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const seen = new Set(existing.map((r) => `${r.adId}:${r.step}`));
    for (const r of results) {
      if (seen.has(`${r.adId}:${r.step}`)) continue;
      await ctx.db.insert("visionResults", { jobId, ...r });
    }
  },
});

export const insertConsensus = internalMutation({
  args: {
    jobId: v.id("jobs"),
    workerToken: v.string(),
    rows: v.array(
      v.object({
        adId: v.string(),
        extA: v.string(),
        extB: v.string(),
        agreed: v.boolean(),
        resolvedState: v.union(v.literal("bien"), v.literal("regular"), v.literal("mal"), v.literal("no_evaluable")),
        badge: v.union(v.literal("consenso"), v.literal("discrepancia"), v.literal("no_evaluable")),
        flags: v.array(v.string()),
      })
    ),
  },
  handler: async (ctx, { jobId, workerToken, rows }) => {
    await requireWorkerToken(ctx, jobId, workerToken);
    const existing = await ctx.db.query("consensus").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const seen = new Set(existing.map((r) => r.adId));
    for (const r of rows) {
      if (seen.has(r.adId)) continue;
      await ctx.db.insert("consensus", { jobId, ...r });
    }
  },
});

export const createReport = internalMutation({
  args: {
    jobId: v.id("jobs"),
    workerToken: v.string(),
    htmlStorageId: v.id("_storage"),
    reportVersion: v.string(),
    listingCount: v.number(),
  },
  handler: async (ctx, { jobId, workerToken, htmlStorageId, reportVersion, listingCount }) => {
    await requireWorkerToken(ctx, jobId, workerToken);
    const existing = await ctx.db.query("reports").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
    if (existing) return existing._id;
    return await ctx.db.insert("reports", {
      jobId,
      htmlStorageId,
      reportVersion,
      listingCount,
      createdAt: Date.now(),
    });
  },
});

export const getJobSnapshot = internalQuery({
  args: { jobId: v.id("jobs"), workerToken: v.string() },
  handler: async (ctx, { jobId, workerToken }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job) throw new Error("job not found");
    if (!job.workerToken || job.workerToken !== workerToken) throw new Error("WORKER_TOKEN_MISMATCH");
    const listings = await ctx.db.query("listings").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const scores = await ctx.db.query("scores").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const vision = await ctx.db.query("visionResults").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const consensus = await ctx.db.query("consensus").withIndex("by_job", (q) => q.eq("jobId", jobId)).collect();
    const report = await ctx.db.query("reports").withIndex("by_job", (q) => q.eq("jobId", jobId)).first();
    return {
      listings,
      scores: scores.map((s) => ({ adId: s.adId, scorerVersion: s.scorerVersion })),
      visionPrimary: vision.filter((v) => v.step === "primary"),
      visionReverify: vision.filter((v) => v.step === "reverify"),
      consensus,
      hasReport: report !== null,
    };
  },
});

// ---------------------------------------------------------------------------

function publicJobView(job: any) {
  return {
    jobId: job._id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    counts: job.counts,
    criteria: job.criteria,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
    errorCode: job.errorCode ?? null,
    errorMsg: job.errorMsg ?? null,
  };
}

function hashCriteria(c: { make: string; model: string; maxPrice: number; region: string; maxKm?: number; maxPhotos?: number; minYear?: number }): string {
  const s = `${c.make}|${c.model}|${c.maxPrice}|${c.region}|${c.maxKm ?? "any"}|${c.maxPhotos ?? "def"}|${c.minYear ?? "any"}`.toLowerCase();
  // FNV-1a (stable across JS engines; not cryptographic).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}
