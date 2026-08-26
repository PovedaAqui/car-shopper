/**
 * Local worker entry point.
 *
 * Modes:
 *  - default: poll Convex for queued jobs, run the pipeline, write results
 *    back through the authenticated worker HTTP API (long-running).
 *  - --local: run one job entirely offline (fixtures + reference vision),
 *    save the HTML report to ./worker/state/local_report.html. Used to
 *    verify the pipeline end-to-end without a deployment.
 *
 * Env:
 *  MODEL_BASE_URL / MODEL_NAME  local OpenAI-compatible endpoint (vLLM)
 *  VISION_MODE                  local_inference_only (default) | local_preferred
 *  MODEL_IS_VISION=1            the served model accepts image inputs
 *  POLL_MS                      poll interval (default 5000)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkerConfig, WorkerConfig, claimJob, updateStage, failJob, insertListings, insertScores, insertVisionResults, insertConsensus, submitReport, queryJob } from "./convex_client.js";
import { runPipeline, PipelineResult } from "./pipeline.js";
import { RawListing, ScrapeCriteria } from "./scrape.js";

const here = dirname(fileURLToPath(import.meta.url));

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

async function runAgainstConvex(cfg: WorkerConfig): Promise<void> {
  const pollMs = Number(process.env.POLL_MS ?? 5000);
  log(`worker ${cfg.workerId} polling ${cfg.convexUrl} every ${pollMs}ms (site ${cfg.siteUrl})`);
  for (;;) {
    try {
      const claimed = await claimJob(cfg);
      if (!claimed || !claimed.jobId) {
        await sleep(pollMs);
        continue;
      }
      const jobId: string = claimed.jobId;
      const criteria: ScrapeCriteria = claimed.criteria;
      log(`claimed job ${jobId}: ${criteria.make} ${criteria.model} <= ${criteria.maxPrice} EUR in ${criteria.region}`);

      const progress = {
        onStage: (stage: string, progressPct: number, counts?: Record<string, number>) =>
          updateStage(cfg, jobId, stage, progressPct, counts),
        onListings: (listings: RawListing[]) =>
          insertListings(
            cfg,
            jobId,
            listings.map((l) => ({
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
            }))
          ),
        onScores: (scores: unknown[]) => insertScores(cfg, jobId, scores as any[]),
        onVision: (results: unknown[]) => insertVisionResults(cfg, jobId, results as any[]),
        onConsensus: (rows: unknown[]) => insertConsensus(cfg, jobId, rows as any[]),
        onReport: (html: string, listingCount: number) => submitReport(cfg, jobId, html, "report-v2", listingCount),
        onDone: () => Promise.resolve(),
      };

      const result: PipelineResult = await runPipeline(jobId, criteria, cfg, progress);
      log(
        `job ${jobId} COMPLETED: ${result.ranked} ranked, ${result.excluded} excluded, vision ${result.visionEvaluable}/${result.visionEvaluable + result.visionNoEvaluable} evaluable (${result.providerLabel}), report ${result.reportBytes} bytes`
      );
    } catch (e: any) {
      log("worker error:", e?.message ?? e);
      // If we hold a job, try to mark it failed; otherwise just wait.
      try {
        const job = await claimJob(cfg); // no-op claim attempt to surface state
        if (job?.jobId) {
          await failJob(cfg, job.jobId, "WORKER_CRASH", "worker loop error; job returned to queue");
        }
      } catch {
        /* ignore */
      }
      await sleep(pollMs);
    }
  }
}

async function runLocalOnce(): Promise<void> {
  log("local mode: running one fixture job without Convex");
  const criteria: ScrapeCriteria = { make: "Toyota", model: "Yaris", maxPrice: 5000, region: "Barcelona/Zaragoza" };
  const stateDir = join(here, "state");
  mkdirSync(stateDir, { recursive: true });
  const reportPath = join(stateDir, "local_report.html");

  let lastStage = "queued";
  let lastScores: unknown[] = [];
  const progress = {
    onStage: async (stage: string, pct: number) => {
      lastStage = stage;
      log(`stage ${stage} (${pct}%)`);
    },
    onListings: async (ls: RawListing[]) => log(`listings: ${ls.length} (valid ${ls.filter((l) => l.dataQualityFlag === "ok").length}, excluded ${ls.filter((l) => l.dataQualityFlag !== "ok").length})`),
    onScores: async (scores: unknown[]) => {
      lastScores = scores;
      log(`scores: ${scores.length}`);
    },
    onVision: async (r: unknown[]) => log(`vision rows: ${r.length}`),
    onConsensus: async (rows: unknown[]) => log(`consensus rows: ${rows.length}`),
    onReport: async (html: string) => {
      writeFileSync(reportPath, html, "utf-8");
      log(`report saved: ${reportPath}`);
    },
    onDone: async () => {},
  };

  const dummyCfg: WorkerConfig = { convexUrl: "unused", siteUrl: "unused", apiBase: "unused", apiKey: "", workerId: "local", useDevHeader: false };
  const result = await runPipeline("local-job", criteria, dummyCfg, progress);
  log(`local job done: ${JSON.stringify(result, null, 2)}`);
  const top = (lastScores as any[]).filter((s) => s.rank).sort((a, b) => a.rank - b.rank).slice(0, 3);
  log("top 3:", top.map((s) => `#${s.rank} ${s.adId} final=${s.final}`).join(" | "));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const args = process.argv.slice(2);
if (args.includes("--local")) {
  runLocalOnce()
    .then(() => {
      process.exit(0);
    })
    .catch((e) => {
      console.error("local run failed:", e);
      process.exit(1);
    });
} else {
  const cfg = loadWorkerConfig();
  runAgainstConvex(cfg).catch((e) => {
    console.error("worker fatal:", e);
    process.exit(1);
  });
}

void queryJob; // used by tests
