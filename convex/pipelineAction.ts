"use node";

/**
 * Runs the full car-shopper pipeline INSIDE Convex, as a Node-runtime
 * action scheduled by api.create — replaces the external polling worker
 * (worker/index.ts's runAgainstConvex loop) that previously had to run on
 * some always-on host outside Convex.
 *
 * The pipeline logic itself (worker/pipeline.ts, scrape.ts, vision.ts,
 * scoring.ts, consensus.ts, report.ts, providers.ts) is unchanged and
 * imported directly — only the transport changed: instead of HTTP calls
 * through convex/http.ts (authenticated by WORKER_API_KEY + workerToken),
 * this action is itself the trusted Convex-side caller and talks straight
 * to the internal mutations via ctx.runMutation/ctx.runQuery. The
 * workerToken contract on those internal mutations is preserved as-is
 * (api.create issues one when scheduling this action), so no change was
 * needed on that side.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { runPipeline, type PipelineProgress } from "../worker/pipeline";
import { normalize, defaultSource } from "../worker/scrape";
import { defaultModels, checkHealth } from "../worker/providers";
import type { RawListing } from "../worker/scrape";

export const run = internalAction({
  args: { jobId: v.id("jobs"), token: v.string() },
  handler: async (ctx, { jobId, token }) => {
    const job: any = await ctx.runQuery(internal.api.getJobForAction, { jobId });
    if (!job) return;
    const criteria = job.criteria;

    const progress: PipelineProgress = {
      onStage: async (stage, pct, counts) => {
        await ctx.runMutation(internal.api.updateStage, { jobId, workerToken: token, stage: stage as any, progress: pct, counts });
      },
      onListings: async (listings: RawListing[]) => {
        await ctx.runMutation(internal.api.insertListings, {
          jobId,
          workerToken: token,
          listings: listings.map((l) => ({
            source: l.source,
            adId: l.adId,
            sourceUrl: l.sourceUrl,
            title: l.title,
            price: l.price,
            km: l.km,
            year: l.year ?? undefined,
            fuel: l.fuel ?? undefined,
            city: l.city ?? undefined,
            hasWarranty: l.hasWarranty,
            isPro: l.isPro,
            photoCount: l.photoCount,
            photoUrls: l.photoUrls,
            dataQualityFlag: l.dataQualityFlag,
            duplicateOfAdId: l.duplicateOfAdId ?? undefined,
            fetchedAt: l.fetchedAt,
          })),
        });
      },
      onScores: async (scores) => {
        await ctx.runMutation(internal.api.insertScores, { jobId, workerToken: token, scores: scores as any[] });
      },
      onVision: async (results) => {
        await ctx.runMutation(internal.api.insertVisionResults, { jobId, workerToken: token, results: results as any[] });
      },
      onConsensus: async (rows) => {
        await ctx.runMutation(internal.api.insertConsensus, { jobId, workerToken: token, rows: rows as any[] });
      },
      onReport: async (html, listingCount) => {
        const storageId = await ctx.storage.store(new Blob([html], { type: "text/html" }));
        await ctx.runMutation(internal.api.createReport, { jobId, workerToken: token, htmlStorageId: storageId, reportVersion: "report-v2", listingCount });
      },
      onDone: () => Promise.resolve(),
    };

    try {
      const models = defaultModels();
      const model = models.visionPrimary;
      const health = model ? await checkHealth(model) : null;
      const source = defaultSource(models.extraction);
      const dummyCfg = { convexUrl: "unused", siteUrl: "unused", apiBase: "unused", apiKey: "", workerId: "convex-action", useDevHeader: false };
      await runPipeline(jobId, criteria, dummyCfg as any, progress, { source, model, health, mode: (process.env.VISION_MODE as any) ?? "local_inference_only" });
    } catch (e: any) {
      await ctx.runMutation(internal.api.failJob, { jobId, workerToken: token, errorCode: "PIPELINE_ERROR", errorMsg: e?.message ?? "pipeline error" });
    }
  },
});

void normalize; // re-exported through worker/pipeline.ts; kept for clarity of what this action depends on
