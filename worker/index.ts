/**
 * Local worker entry point.
 *
 * Modes:
 *  - default: poll Convex for queued jobs, run the pipeline, write results
 *    back through the authenticated worker HTTP API (long-running).
 *  - --local: run one job without Convex, using criteria from the environment
 *    (LOCAL_MAKE/LOCAL_MODEL/LOCAL_MAX_PRICE/LOCAL_REGION), save the HTML
 *    report to ./worker/state/local_report.html. Live scraping and live
 *    vision; no fixed inputs.
 *
 * Env:
 *  MODEL_BASE_URL / MODEL_NAME  local OpenAI-compatible endpoint (vLLM);
 *                               used for text extraction when
 *                               TEXT_PROVIDER=local, and for vision when
 *                               VISION_PROVIDER=local
 *  TEXT_PROVIDER                openai (default) | local — primary
 *                               text-extraction (card price/km repair)
 *                               provider
 *  VISION_PROVIDER              openai (default) | local — which config is
 *                               the primary vision provider
 *  OPENAI_API_KEY               required for the default (openai) text and
 *                               vision providers
 *  VISION_MODE                  local_inference_only (default) | local_preferred
 *                               — governs the SECONDARY vision provider only
 *  MODEL_IS_VISION=1            the local served model accepts image inputs
 *                               (only relevant when VISION_PROVIDER=local)
 *  POLL_MS                      poll interval (default 5000)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkerConfig, type WorkerConfig, claimJob, updateStage, failJob, insertListings, insertScores, insertVisionResults, insertConsensus, submitReport, getJobSnapshot, queryJob } from "./convex_client.ts";
import { runPipeline, type PipelineResult } from "./pipeline.ts";
import type { RawListing, ScrapeCriteria } from "./scrape.ts";

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
      const token: string = claimed.token;
      const criteria: ScrapeCriteria = claimed.criteria;
      log(`claimed job ${jobId}: ${criteria.make} ${criteria.model} <= ${criteria.maxPrice} EUR in ${criteria.region}`);

      const snapshot = await getJobSnapshot(cfg, jobId, token).catch(() => null);

      const progress = {
        onStage: (stage: string, progressPct: number, counts?: Record<string, number>) =>
          updateStage(cfg, jobId, token, stage, progressPct, counts),
        onListings: (listings: RawListing[]) =>
          insertListings(
            cfg,
            jobId,
            token,
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
        onScores: (scores: unknown[]) => insertScores(cfg, jobId, token, scores as any[]),
        onVision: (results: unknown[]) => insertVisionResults(cfg, jobId, token, results as any[]),
        onConsensus: (rows: unknown[]) => insertConsensus(cfg, jobId, token, rows as any[]),
        onReport: (html: string, listingCount: number) => submitReport(cfg, jobId, token, html, "report-v2", listingCount),
        onDone: () => Promise.resolve(),
      };

      try {
        const result: PipelineResult = await runPipeline(jobId, criteria, cfg, progress, { snapshot });
        log(
          `job ${jobId} COMPLETED: ${result.ranked} ranked, ${result.excluded} excluded, vision ${result.visionEvaluable}/${result.visionEvaluable + result.visionNoEvaluable} evaluable (${result.providerLabel}), report ${result.reportBytes} bytes`
        );
      } catch (e: any) {
        log("job error:", jobId, e?.message ?? e);
        await failJob(cfg, jobId, token, "WORKER_CRASH", e?.message ?? "worker pipeline error").catch(() => undefined);
      }
    } catch (e: any) {
      log("worker error:", e?.message ?? e);
      await sleep(pollMs);
    }
  }
}

async function runLocalOnce(): Promise<void> {
  log("local mode: running one live job without Convex (criteria from environment)");
  const make = process.env.LOCAL_MAKE ?? "Toyota";
  const model = process.env.LOCAL_MODEL ?? "Yaris";
  const maxPrice = Number(process.env.LOCAL_MAX_PRICE ?? 5000);
  const region = process.env.LOCAL_REGION ?? "Barcelona";
  const minYearEnv = process.env.LOCAL_MIN_YEAR;
  const minYear = minYearEnv ? Number(minYearEnv) : undefined;
  const criteria: ScrapeCriteria = { make, model, maxPrice, region, ...(minYear ? { minYear } : {}) };
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
