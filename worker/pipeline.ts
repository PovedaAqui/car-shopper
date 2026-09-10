/**
 * Pipeline orchestrator (plan §4, 8 stages):
 *
 *   1. scrape (coches.net, en vivo vía Firecrawl)  2. normalize  3. rank v1  4. vision primary
 *   5. vision reverify    6. consensus  7. rank v2  8. report
 *
 * Deterministic core (scoring/consensus) + LLM only for vision. Each stage
 * writes progress to Convex so the dashboard updates in realtime. Stage
 * cache: a re-run of a failed job re-enters at the next uncompleted stage.
 */

import { normalize, defaultSource, type RawListing, type ScrapeSource, type ScrapeCriteria } from "./scrape.ts";
import { scoreAll, SCORER_VERSION, type VisionDeltaInput } from "./scoring.ts";
import { consensusAll } from "./consensus.ts";
import { runVision, type VisionOutcome } from "./vision.ts";
import { renderReportHTML, type ReportInput } from "./report.ts";
import { checkHealth, defaultModels, type ModelConfig, type Health } from "./providers.ts";
import type { WorkerConfig, JobSnapshot } from "./convex_client.ts";

export interface PipelineProgress {
  onStage(stage: string, progress: number, counts?: Record<string, number>): Promise<void>;
  onListings(listings: RawListing[]): Promise<void>;
  onScores(scores: unknown[]): Promise<void>;
  onVision(primary: unknown[]): Promise<void>;
  onConsensus(rows: unknown[]): Promise<void>;
  onReport(html: string, listingCount: number): Promise<void>;
  onDone(): Promise<void>;
}

export interface PipelineResult {
  jobId: string;
  ranked: number;
  excluded: number;
  visionEvaluable: number;
  visionNoEvaluable: number;
  providerLabel: string;
  reportBytes: number;
}

export async function runPipeline(
  jobId: string,
  criteria: ScrapeCriteria,
  cfg: WorkerConfig,
  progress: PipelineProgress,
  opts: {
    source?: ScrapeSource;
    model?: ModelConfig | null;
    health?: Health | null;
    mode?: "local_inference_only" | "local_preferred";
    snapshot?: JobSnapshot | null;
  } = {}
): Promise<PipelineResult> {
  const source = opts.source ?? null; // resolved lazily below (a snapshot run never scrapes)
  const mode = opts.mode ?? ((process.env.VISION_MODE as any) ?? "local_inference_only");
  const models = defaultModels();
  const snap = opts.snapshot ?? null;
  void cfg;
  void jobId;

  let listings: RawListing[];
  let valid: number;
  let excluded: number;

  if (snap && snap.listings.length > 0) {
    listings = snap.listings;
    valid = listings.filter((l) => l.dataQualityFlag === "ok").length;
    excluded = listings.length - valid;
    await progress.onStage("normalizing", 20, { scraped: listings.length, valid, excluded });
  } else {
    // --- 1. Scrape -----------------------------------------------------------
    await progress.onStage("scraping", 5);
    const raw = await (source ?? defaultSource()).scrape(criteria);
    if (raw.length === 0) {
      throw new Error("NO_LISTINGS: the source returned zero listings for these criteria");
    }

    // --- 2. Normalize --------------------------------------------------------
    await progress.onStage("normalizing", 15);
    const normalized = normalize(raw);
    listings = normalized.listings;
    valid = normalized.valid;
    excluded = normalized.excluded;
    await progress.onListings(listings);
    await progress.onStage("normalizing", 20, { scraped: listings.length, valid, excluded });
  }

  // --- 3. Rank v1 (deterministic, no vision) -------------------------------
  await progress.onStage("ranking", 30);
  const v1 = scoreAll(
    listings.map((l) => ({
      adId: l.adId,
      price: l.price,
      km: l.km,
      year: l.year ?? null,
      hasWarranty: l.hasWarranty,
      isPro: l.isPro,
      dataQualityFlag: l.dataQualityFlag,
      duplicateOfAdId: l.duplicateOfAdId ?? null,
    })),
    new Map()
  );
  const v1Rows = v1.map((s) => ({
    adId: s.adId,
    scorerVersion: `${SCORER_VERSION}-v1`,
    base: s.base,
    bonuses: s.bonuses,
    riskFactor: s.riskFactor,
    visDelta: 0,
    final: s.final,
    rank: s.rank ?? undefined,
    pricePerKm: s.pricePerKm,
    notes: s.notes,
  }));
  if (!snap?.scores.some((s) => s.scorerVersion.endsWith("-v1"))) {
    await progress.onScores(v1Rows);
  }
  await progress.onStage("ranking", 40);

  // --- 4-5. Vision: two independent passes ----------------------------------
  await progress.onStage("vision", 45);
  let vision: VisionOutcome;
  if (snap && snap.visionPrimary.length > 0) {
    vision = {
      primary: snap.visionPrimary,
      reverify: snap.visionReverify.length > 0 ? snap.visionReverify : snap.visionPrimary,
      providerLabel: snap.visionPrimary[0]?.provider ?? "cached",
    };
  } else {
    const model = opts.model !== undefined ? opts.model : models.visionPrimary;
    let health = opts.health;
    if (model && health === undefined) {
      health = await checkHealth(model);
    }
    vision = await runVision(listings, model, health ?? null, mode, criteria.maxPhotos, models.visionFallback);
    const primaryRows = vision.primary.map((v) => toVisionRow(v));
    const reverifyRows = vision.reverify.map((v) => toVisionRow(v));
    await progress.onVision([...primaryRows, ...reverifyRows]);
  }
  await progress.onStage("vision", 65, {
    visionEvaluable: vision.primary.filter((v) => v.exteriorState !== "no_evaluable").length,
    visionNoEvaluable: vision.primary.filter((v) => v.exteriorState === "no_evaluable").length,
  });

  // --- 6. Consensus (deterministic) -----------------------------------------
  await progress.onStage("consensus", 70);
  let consensus = snap && snap.consensus.length > 0
    ? snap.consensus
    : consensusAll(
        listings.map((l) => l.adId),
        new Map(vision.primary.map((v) => [v.adId, v.exteriorState])),
        new Map(vision.reverify.map((v) => [v.adId, v.exteriorState]))
      );
  if (!(snap && snap.consensus.length > 0)) {
    await progress.onConsensus(
      consensus.map((c) => ({
        adId: c.adId,
        extA: c.extA,
        extB: c.extB,
        agreed: c.agreed,
        resolvedState: c.resolvedState,
        badge: c.badge,
        flags: c.flags,
      }))
    );
  }

  // --- 7. Rank v2 (deterministic + visual delta) -----------------------------
  await progress.onStage("ranking", 80);
  const vByAd = new Map(consensus.map((c) => [c.adId, c]));
  const visionForScoring = new Map<string, VisionDeltaInput | null>();
  for (const l of listings) {
    const c = vByAd.get(l.adId);
    if (!c) {
      visionForScoring.set(l.adId, null);
      continue;
    }
    const p = vision.primary.find((v) => v.adId === l.adId);
    visionForScoring.set(l.adId, {
      resolvedExterior: c.resolvedState,
      interiorGood: p?.interiorState === "bien",
      suspectStock: p?.photoType === "stock_sospechoso",
      noPhotos: (l.photoCount ?? 0) === 0,
    });
  }
  const v2 = scoreAll(
    listings.map((l) => ({
      adId: l.adId,
      price: l.price,
      km: l.km,
      year: l.year ?? null,
      hasWarranty: l.hasWarranty,
      isPro: l.isPro,
      dataQualityFlag: l.dataQualityFlag,
      duplicateOfAdId: l.duplicateOfAdId ?? null,
    })),
    visionForScoring
  );
  const v2Rows = v2.map((s) => ({
    adId: s.adId,
    scorerVersion: `${SCORER_VERSION}-v2`,
    base: s.base,
    bonuses: s.bonuses,
    riskFactor: s.riskFactor,
    visDelta: s.visDelta,
    final: s.final,
    rank: s.rank ?? undefined,
    pricePerKm: s.pricePerKm,
    notes: s.notes,
  }));
  if (!snap?.scores.some((s) => s.scorerVersion.endsWith("-v2"))) {
    await progress.onScores(v2Rows);
  }

  // --- 8. Report -------------------------------------------------------------
  await progress.onStage("reporting", 90);
  const report: ReportInput = {
    criteria,
    listings,
    scores: v2,
    visionPrimary: vision.primary,
    consensus,
    providerLabel: vision.providerLabel,
    sourceLabel: source?.label(),
    generatedAt: Date.now(),
    jobStage: "completed",
  };
  const html = renderReportHTML(report);
  if (!snap?.hasReport) {
    await progress.onReport(html, listings.length);
  }
  await progress.onStage("completed", 100, {});
  await progress.onDone();

  return {
    jobId,
    ranked: v2.filter((s) => s.included).length,
    excluded,
    visionEvaluable: vision.primary.filter((v) => v.exteriorState !== "no_evaluable").length,
    visionNoEvaluable: vision.primary.filter((v) => v.exteriorState === "no_evaluable").length,
    providerLabel: vision.providerLabel,
    reportBytes: Buffer.byteLength(html, "utf-8"),
  };
}

function toVisionRow(v: VisionOutcome["primary"][number]) {
  return {
    adId: v.adId,
    provider: v.provider,
    model: v.model,
    step: v.step,
    promptVersion: v.promptVersion,
    photosAnalyzed: v.photosAnalyzed,
    photoType: v.photoType,
    exteriorState: v.exteriorState,
    interiorState: v.interiorState,
    cleanliness: v.cleanliness,
    color: v.color ?? undefined,
    redFlags: v.redFlags,
    details: v.details ?? undefined,
    noEvaluableReason: v.noEvaluableReason ?? undefined,
    rawResponse: v.rawResponse ?? undefined,
    latencyMs: v.latencyMs,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
  };
}
