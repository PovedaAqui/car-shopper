import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Car Shopper data model (plan §6), implemented as Convex collections.
 *
 * Ownership: every job is owned by `userId` (anonymous demo user ids are
 * client-generated UUIDs stored in localStorage). Public queries only return
 * rows the caller owns; worker writes go through the authenticated HTTP API.
 */
export default defineSchema({
  users: defineTable({
    userId: v.string(),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"]),

  jobs: defineTable({
    userId: v.string(),
    /** Idempotency key: `criteriaHash:userId` per day window. */
    idempotencyKey: v.string(),
    criteria: v.object({
      make: v.string(),
      model: v.string(),
      maxPrice: v.number(),
      region: v.string(),
      maxKm: v.optional(v.number()),
    }),
    status: v.union(
      v.literal("queued"),
      v.literal("claimed"),
      v.literal("scraping"),
      v.literal("normalizing"),
      v.literal("ranking"),
      v.literal("vision"),
      v.literal("consensus"),
      v.literal("reporting"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("expired")
    ),
    stage: v.string(),
    progress: v.number(),
    counts: v.object({
      scraped: v.number(),
      valid: v.number(),
      excluded: v.number(),
      visionEvaluable: v.number(),
      visionNoEvaluable: v.number(),
    }),
    /** Opaque token a worker sets when claiming; stale claims are requeued. */
    workerToken: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    errorMsg: v.optional(v.string()),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_status", ["status"])
    .index("by_status_created", ["status", "createdAt"]),

  listings: defineTable({
    jobId: v.id("jobs"),
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
    .index("by_job", ["jobId"])
    .index("by_job_ad", ["jobId", "adId"]),

  scores: defineTable({
    jobId: v.id("jobs"),
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
    .index("by_job", ["jobId"])
    .index("by_job_version", ["jobId", "scorerVersion"]),

  visionResults: defineTable({
    jobId: v.id("jobs"),
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
    .index("by_job", ["jobId"])
    .index("by_job_ad", ["jobId", "adId"]),

  consensus: defineTable({
    jobId: v.id("jobs"),
    adId: v.string(),
    extA: v.string(),
    extB: v.string(),
    agreed: v.boolean(),
    resolvedState: v.union(v.literal("bien"), v.literal("regular"), v.literal("mal"), v.literal("no_evaluable")),
    badge: v.union(v.literal("consenso"), v.literal("discrepancia"), v.literal("no_evaluable")),
    flags: v.array(v.string()),
  })
    .index("by_job", ["jobId"])
    .index("by_job_ad", ["jobId", "adId"]),

  reports: defineTable({
    jobId: v.id("jobs"),
    htmlStorageId: v.id("_storage"),
    reportVersion: v.string(),
    listingCount: v.number(),
    createdAt: v.number(),
  })
    .index("by_job", ["jobId"]),

  credits: defineTable({
    userId: v.string(),
    kind: v.union(v.literal("free_daily"), v.literal("pro")),
    amount: v.number(),
    consumedByJobId: v.optional(v.id("jobs")),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_kind", ["userId", "kind"]),

  shareLinks: defineTable({
    reportId: v.id("reports"),
    tokenHash: v.string(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_report", ["reportId"]),

  emailDeliveries: defineTable({
    reportId: v.id("reports"),
    recipientHash: v.string(),
    providerId: v.string(),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("bounced")),
    sentAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_report", ["reportId"]),
});
