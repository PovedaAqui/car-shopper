import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/** Put a stale claimed job back into the queue (called by the maintenance cron). */
export const rescueStaleJob = internalMutation({
  args: { jobId: v.id("jobs"), now: v.number() },
  handler: async (ctx, { jobId, now }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job || job.status !== "claimed") return;
    await ctx.db.patch("jobs", job._id, {
      status: "queued",
      stage: "queued",
      progress: 0,
      workerToken: undefined,
    });
    void now;
  },
});

/** Expire a job stuck in the queue too long (called by the maintenance cron). */
export const expireJob = internalMutation({
  args: { jobId: v.id("jobs"), now: v.number() },
  handler: async (ctx, { jobId, now }) => {
    const job = await ctx.db.get("jobs", jobId);
    if (!job || job.status !== "queued") return;
    await ctx.db.patch("jobs", job._id, {
      status: "expired",
      errorCode: "EXPIRED_IN_QUEUE",
      errorMsg: "Job stuck in queue > 24h",
      finishedAt: now,
    });
  },
});
