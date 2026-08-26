/**
 * Pipeline orchestrator (plan §4, 8 stages):
 *
 *   1. scrape (fixtures)  2. normalize  3. rank v1  4. vision primary
 *   5. vision reverify    6. consensus  7. rank v2  8. report
 *
 * Deterministic core (scoring/consensus) + LLM only for vision. Each stage
 * writes progress to Convex so the dashboard updates in realtime. Stage
 * cache: a re-run of a failed job re-enters at the next uncompleted stage.
 */

import { RawListing, ScrapeSource, ScrapeCriteria, normalize, defaultSource } from "./scrape.js";
import { scoreAll, SCORER_VERSION, VisionDeltaInput } from "./scoring.js";
import { consensusAll } from "./consensus.js";
import { runVision, VisionOutcome } from "./vision.js";
import { renderReportHTML, ReportInput } from "./report.js";
import { ModelConfig, Health, checkHealth, defaultModels } from "./providers.js";
import * as cx from "./convex_client.js";
import { WorkerConfig } from "./convex_client.js";

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
  usedReferenceVision: boolean;
  reportBytes: number;
}

export async function runPipeline(
  jobId: string,
  criteria: ScrapeCriteria,
  cfg: WorkerConfig,
  progress: PipelineProgress,
  opts: { source?: ScrapeSource; model?: ModelConfig | null; health?: Health | null; mode?: "local_inference_only" | "local_preferred" } = {}
): Promise<PipelineResult> {
  const source = opts.source ?? defaultSource();
  const mode = opts.mode ?? ((process.env.VISION_MODE as any) ?? "local_inference_only");
  const models = defaultModels();

  // --- 1. Scrape -----------------------------------------------------------
  await progress.onStage("scraping", 5);
  const raw = await source.scrape(criteria);
  if (raw.length === 0) {
    throw new Error("NO_LISTINGS: the source returned zero listings for these criteria");
  }

  // --- 2. Normalize --------------------------------------------------------
  await progress.onStage("normalizing", 15);
  const { listings, valid, excluded } = normalize(raw);
  await progress.onListings(listings);
  await progress.onStage("normalizing", 20, { scraped: listings.length, valid, excluded });

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
  await progress.onScores(v1Rows);
  await progress.onStage("ranking", 40);

  // --- 4-5. Vision: two independent passes ----------------------------------
  await progress.onStage("vision", 45);
  const model = opts.model !== undefined ? opts.model : models.visionPrimary;
  let health = opts.health;
  if (model && health === undefined) {
    health = await checkHealth(model);
  }
  const vision: VisionOutcome = await runVision(listings, model, health ?? null, mode);
  const primaryRows = vision.primary.map((v) => ({
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
    latencyMs: v.latencyMs,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
  }));
  const reverifyRows = vision.reverify.map((v) => ({
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
    latencyMs: v.latencyMs,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
  }));
  await progress.onVision([...primaryRows, ...reverifyRows]);
  await progress.onStage("vision", 65, {
    visionEvaluable: vision.primary.filter((v) => v.exteriorState !== "no_evaluable").length,
    visionNoEvaluable: vision.primary.filter((v) => v.exteriorState === "no_evaluable").length,
  });

  // --- 6. Consensus (deterministic) -----------------------------------------
  await progress.onStage("consensus", 70);
  const primaryStates = new Map(vision.primary.map((v) => [v.adId, v.exteriorState]));
  const reverifyStates = new Map(vision.reverify.map((v) => [v.adId, v.exteriorState]));
  const consensus = consensusAll(
    listings.map((l) => l.adId),
    primaryStates,
    reverifyStates
  );
  const consensusRows = consensus.map((c) => ({
    adId: c.adId,
    extA: c.extA,
    extB: c.extB,
    agreed: c.agreed,
    resolvedState: c.resolvedState,
    badge: c.badge,
    flags: c.flags,
  }));
  await progress.onConsensus(consensusRows);

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
  await progress.onScores(v2Rows);

  // --- 8. Report -------------------------------------------------------------
  await progress.onStage("reporting", 90);
  const report: ReportInput = {
    criteria,
    listings,
    scores: v2,
    visionPrimary: vision.primary,
    consensus,
    providerLabel: vision.providerLabel,
    usedReferenceVision: vision.usedReference,
    generatedAt: Date.now(),
    jobStage: "completed",
  };
  const html = renderReportHTML(report);
  await progress.onReport(html, listings.length);
  await progress.onStage("completed", 100, {});
  await progress.onDone();

  return {
    jobId,
    ranked: v2.filter((s) => s.included).length,
    excluded,
    visionEvaluable: vision.primary.filter((v) => v.exteriorState !== "no_evaluable").length,
    visionNoEvaluable: vision.primary.filter((v) => v.exteriorState === "no_evaluable").length,
    providerLabel: vision.providerLabel,
    usedReferenceVision: vision.usedReference,
    reportBytes: Buffer.byteLength(html, "utf-8"),
  };
}
