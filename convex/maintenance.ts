import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * Maintenance: requeue stale claimed jobs and expire jobs stuck in queue > 24h.
 * Idempotent and safe to run repeatedly (scheduled every 10 minutes by crons.ts).
 */
export const runMaintenance = action({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, { now: providedNow }) => {
    const now = providedNow ?? Date.now();
    let requeued = 0;
    let expired = 0;

    // Requeue stale claimed jobs (>10 min without progress).
    const claimed = await ctx.runQuery(internal.api.byStatus, { status: "claimed" });
    for (const j of claimed as any[]) {
      if (j.claimedAt !== undefined && now - j.claimedAt > 10 * 60_000) {
        await ctx.runMutation(internal.worker.rescueStaleJob, { jobId: j._id, now });
        requeued++;
      }
    }

    // Expire jobs stuck in queue > 24h.
    const queued = await ctx.runQuery(internal.api.byStatus, { status: "queued" });
    for (const j of queued as any[]) {
      if (now - j.createdAt > 24 * 3600_000) {
        await ctx.runMutation(internal.worker.expireJob, { jobId: j._id, now });
        expired++;
      }
    }

    return { requeued, expired, now };
  },
});
