import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * Public queries/mutations for the Car Shopper frontend (Convex 1.45 API).
 *
 * The frontend never authenticates with a token in this MVP: ownership is by
 * the opaque `userId` (anonymous, client-generated UUID in localStorage).
 * The local worker writes results exclusively through the authenticated HTTP
 * API (convex/worker_api.ts).
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
    }),
  },
  handler: async (ctx, args) => {
    if (args.criteria.maxPrice < 100 || args.criteria.maxPrice > 1_000_000) {
      throw new Error("maxPrice out of range");
    }
    const now = Date.now();
    const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);

    const users = await ctx.db.query("users").collect();
    const isNewUser = !users.some((u) => u.userId === args.userId);
    if (isNewUser) {
      await ctx.db.insert("users", { userId: args.userId, createdAt: now });
      // Seed a free-tier credit for today.
      await ctx.db.insert("credits", {
        userId: args.userId,
        kind: "free_daily",
        amount: 1,
        createdAt: now,
      });
    }

    // Free-tier check: free_daily credits created today minus consumed.
    const credits = (await ctx.db.query("credits").collect()).filter(
      (c) => c.userId === args.userId && c.kind === "free_daily" && c.createdAt >= dayStart
    );
    const available = credits.filter((c) => c.consumedByJobId === undefined).length;
    if (available < 1) {
      throw new Error("FREE_TIER_EXHAUSTED: one free search per day. Try again tomorrow.");
    }

    // Idempotency: same user + criteria on the same day returns the existing job.
    const idempotencyKey = `${args.userId}:${hashCriteria(args.criteria)}`;
    const allJobs = await ctx.db.query("jobs").collect();
    const existing = allJobs.filter(
      (j) =>
        j.userId === args.userId &&
        j.idempotencyKey === idempotencyKey &&
        j.createdAt >= dayStart &&
        !["failed", "cancelled", "expired"].includes(j.status)
    );
    if (existing.length > 0) {
      return existing[0]._id;
    }

    const jobId = await ctx.db.insert("jobs", {
      userId: args.userId,
      idempotencyKey,
      criteria: args.criteria,
      status: "queued",
      stage: "queued",
      progress: 0,
      counts: {
        scraped: 0,
        valid: 0,
        excluded: 0,
        visionEvaluable: 0,
        visionNoEvaluable: 0,
      },
      createdAt: now,
    });

    // Consume the oldest free credit (idempotent: exactly one per job).
    const credit = credits
      .filter((c) => c.consumedByJobId === undefined)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (credit) {
      await ctx.db.patch("credits", credit._id, { consumedByJobId: jobId });
    }

    return jobId;
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
    return scores
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
    // status is a union literal in the schema, so the index value type is the
    // union; filter from a scan instead of an index eq.
    const jobs = await ctx.db.query("jobs").collect();
    return jobs.filter((j) => j.status === status);
  },
});

// ---------------------------------------------------------------------------
// Internal mutations used by the worker HTTP API (worker_api.ts)
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
    // Stale claim: claimed 10 min ago without progress -> requeue.
    const claimed = await ctx.db.query("jobs").withIndex("by_status", (q) => q.eq("status", "claimed")).collect();
    for (const j of claimed) {
      if (j.claimedAt !== undefined && now - j.claimedAt > 10 * 60_000) {
        await ctx.db.patch("jobs", j._id, { status: "queued", stage: "queued", workerToken: undefined });
      }
    }
    const queued = await ctx.db.query("jobs").withIndex("by_status", (q) => q.eq("status", "queued")).collect();
    const job = [...queued].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return null;
    const token = `${workerId}:${now}:${Math.random().toString(36).slice(2)}`;
    await ctx.db.patch("jobs", job._id, {
      status: "claimed",
      stage: "scraping",
      progress: 2,
      workerToken: token,
      claimedAt: now,
    });
    return { jobId: job._id, token, criteria: job.criteria };
  },
});

export const updateStage = internalMutation({
  args: {
    jobId: v.id("jobs"),
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
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job) throw new Error("job not found");
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
      finishedAt: args.stage === "completed" ? Date.now() : job.finishedAt,
    });
  },
});

export const failJob = internalMutation({
  args: { jobId: v.id("jobs"), errorCode: v.string(), errorMsg: v.string() },
  handler: async (ctx, { jobId, errorCode, errorMsg }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job) return;
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
  handler: async (ctx, { jobId, listings }) => {
    for (const l of listings) {
      await ctx.db.insert("listings", { jobId, ...l });
    }
  },
});

export const insertScores = internalMutation({
  args: {
    jobId: v.id("jobs"),
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
  handler: async (ctx, { jobId, scores }) => {
    for (const s of scores) {
      await ctx.db.insert("scores", { jobId, ...s });
    }
  },
});

export const insertVisionResults = internalMutation({
  args: {
    jobId: v.id("jobs"),
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
        latencyMs: v.optional(v.number()),
        inputTokens: v.optional(v.number()),
        outputTokens: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, { jobId, results }) => {
    for (const r of results) {
      await ctx.db.insert("visionResults", { jobId, ...r });
    }
  },
});

export const insertConsensus = internalMutation({
  args: {
    jobId: v.id("jobs"),
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
  handler: async (ctx, { jobId, rows }) => {
    for (const r of rows) {
      await ctx.db.insert("consensus", { jobId, ...r });
    }
  },
});

export const createReport = internalMutation({
  args: {
    jobId: v.id("jobs"),
    htmlStorageId: v.id("_storage"),
    reportVersion: v.string(),
    listingCount: v.number(),
  },
  handler: async (ctx, { jobId, htmlStorageId, reportVersion, listingCount }) => {
    await ctx.db.insert("reports", {
      jobId,
      htmlStorageId,
      reportVersion,
      listingCount,
      createdAt: Date.now(),
    });
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

function hashCriteria(c: { make: string; model: string; maxPrice: number; region: string; maxKm?: number }): string {
  const s = `${c.make}|${c.model}|${c.maxPrice}|${c.region}|${c.maxKm ?? "any"}`.toLowerCase();
  // FNV-1a (stable across JS engines; not cryptographic).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}
