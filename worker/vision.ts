/**
 * Vision stage (plan §4 stages 4-5, §7).
 *
 * Two INDEPENDENT passes per car (primary + reverify; the reverify pass never
 * sees the primary output). Callers use direct API calls — no LLM agents
 * (lesson from the reference session). Fixed prompt template + strict JSON
 * schema + 1 retry with the parse error. When the configured model is not
 * available or cannot produce schema-valid output, the result is
 * `no_evaluable` — never invented.
 *
 * Provider selection: OpenAI is the DEFAULT vision provider
 * (VISION_PROVIDER=openai, the default, requires OPENAI_API_KEY). Set
 * VISION_PROVIDER=local to use the local OpenAI-compatible endpoint (vLLM,
 * Ollama, LM Studio) instead — health-gated, and requires MODEL_IS_VISION=1
 * on a genuinely vision-capable served model. Whichever one is primary, the
 * other becomes an optional secondary provider only reachable when
 * VISION_MODE=local_preferred is explicitly set. There is no fixture
 * fallback: vision results always come from a real model call or are
 * honestly marked `no_evaluable` with the reason.
 */

import type { ModelConfig, Health } from "./providers.ts";
import {
  ProviderError,
  chatJson,
  selectProvider,
} from "./providers.ts";
import type { RawListing } from "./scrape.ts";

export const PROMPT_VERSION = "vision-v3";
/** Default photos-per-car cap when the job doesn't specify maxPhotos.
 * Configurable via VISION_MAX_PHOTOS_PER_CAR (falls back to 1). Exported so
 * the scraper's photo-enrichment fetch can share the same default cap.
 * Evaluated per-call (not cached at module load) so env overrides in tests
 * and runtime reconfiguration both take effect. */
export function defaultMaxPhotosPerCar(): number {
  const n = Number(process.env.VISION_MAX_PHOTOS_PER_CAR);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

const SCHEMA_HINT =
  '{"photos_analyzed": int, "photo_type": "profesional|amateur|sin_fotos|stock_sospechoso", "exterior_state": "bien|regular|mal|no_evaluable", "interior_state": "bien|regular|mal|no_evaluable|sin_ver", "exterior_details": string, "cleanliness": "limpio|regular|descuidado|no_evaluable", "color": string|null, "red_flags": string[]}';

export interface VisionResult {
  adId: string;
  provider: string;
  model: string;
  step: "primary" | "reverify";
  promptVersion: string;
  photosAnalyzed: number;
  photoType?: "profesional" | "amateur" | "sin_fotos" | "stock_sospechoso";
  exteriorState: "bien" | "regular" | "mal" | "no_evaluable";
  interiorState: "bien" | "regular" | "mal" | "no_evaluable";
  cleanliness: "limpio" | "regular" | "descuidado" | "no_evaluable";
  color?: string | null;
  redFlags: string[];
  details?: string | null;
  noEvaluableReason?: string | null;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  rawResponse?: string | null;
}

function normState(v: unknown, fallback: "no_evaluable"): VisionResult["exteriorState"] {
  const s = String(v ?? "").toLowerCase();
  return (["bien", "regular", "mal", "no_evaluable"] as const).includes(s as any)
    ? (s as VisionResult["exteriorState"])
    : fallback;
}

function normInterior(v: unknown): VisionResult["interiorState"] {
  return normState(v, "no_evaluable");
}

function normClean(v: unknown): VisionResult["cleanliness"] {
  const s = String(v ?? "").toLowerCase();
  return (["limpio", "regular", "descuidado", "no_evaluable"] as const).includes(s as any)
    ? (s as VisionResult["cleanliness"])
    : "no_evaluable";
}

/**
 * photo_type has no safe fallback value (undefined means "not set" and is
 * valid), so normalize rather than default to no_evaluable. Maps common
 * English variants back to the fixed Spanish enum in case a model ignores
 * the schema instruction (observed live with gpt-4o-mini returning
 * "professional" instead of "profesional" — Convex's schema validator
 * rejects anything outside the enum, failing the whole job).
 */
const PHOTO_TYPE_EN_TO_ES: Record<string, VisionResult["photoType"]> = {
  professional: "profesional",
  amateur: "amateur",
  no_photos: "sin_fotos",
  suspect_stock: "stock_sospechoso",
  stock_photos: "stock_sospechoso",
};
function normPhotoType(v: unknown): VisionResult["photoType"] {
  if (v == null) return undefined;
  const s = String(v).toLowerCase();
  if ((["profesional", "amateur", "sin_fotos", "stock_sospechoso"] as const).includes(s as any)) {
    return s as VisionResult["photoType"];
  }
  return PHOTO_TYPE_EN_TO_ES[s] ?? undefined;
}

function noEvaluable(adId: string, provider: string, model: string, step: VisionResult["step"], reason: string, photosAnalyzed = 0, hasPhotos?: boolean): VisionResult {
  const has = hasPhotos ?? photosAnalyzed > 0;
  return {
    adId,
    provider,
    model,
    step,
    promptVersion: PROMPT_VERSION,
    photosAnalyzed,
    photoType: has ? undefined : "sin_fotos",
    exteriorState: "no_evaluable",
    interiorState: "no_evaluable",
    cleanliness: "no_evaluable",
    color: null,
    redFlags: [],
    details: null,
    noEvaluableReason: reason,
  };
}

/**
 * Analyze one car with the local model (single pass).
 * Photos are fetched by the local model (data stays local — local_inference_only).
 * `maxPhotos` caps how many photos per ad are analyzed: 0 disables vision for
 * this ad (honest `no_evaluable`), a positive number caps the set, and
 * undefined analyzes all available photos.
 */
async function analyzeWithModel(
  cfg: ModelConfig,
  listing: RawListing,
  step: VisionResult["step"],
  neutral: boolean,
  maxPhotos?: number
): Promise<VisionResult> {
  if (maxPhotos === 0) {
    return noEvaluable(listing.adId, cfg.provider, cfg.model, step, "inspección visual desactivada por configuración", 0, listing.photoUrls.length > 0);
  }
  const cap = maxPhotos ?? defaultMaxPhotosPerCar();
  const photos = listing.photoUrls.slice(0, cap);
  if (photos.length === 0) {
    return noEvaluable(listing.adId, cfg.provider, cfg.model, step, "sin fotos en el anuncio");
  }

  const system =
    "You are a used-car inspector. Analyze the ad's photos and respond with strict JSON. " +
    "Do not invent anything you cannot see: if something is not visible, use 'no_evaluable'. " +
    "The fields photo_type, exterior_state, interior_state, and cleanliness MUST use exactly one of the Spanish enum values given in the schema (e.g. 'bien', 'regular', 'mal', 'no_evaluable', 'profesional', 'amateur', 'sin_fotos', 'stock_sospechoso', 'limpio', 'descuidado', 'sin_ver') — never translate or invent other values for those fields. " +
    "Only exterior_details and red_flags are free text: write those two fields in English. " +
    (neutral
      ? "Work independently: you have no knowledge of any other analysis of this ad."
      : "");
  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    {
      type: "text",
      text: `Listing ${listing.adId}: ${listing.title} (${listing.price} EUR, ${listing.km} km, ${listing.year ?? "?"}). Describe: colour, visible exterior condition (dents, scratches, rust, respraying, bumpers, wheels/tyres), cleanliness, and whether the photo looks professional (neutral background) or amateur. Is there any visible defect or sign of wear/use? If a photo is of the interior, describe the upholstery, seat/steering-wheel wear, cleanliness, and dashboard.`,
    },
    ...photos.map((u) => ({ type: "image_url" as const, image_url: { url: u } })),
  ];

  try {
    const { value, raw, result, error } = await chatJson<any>(cfg, system, userContent, { schemaHint: SCHEMA_HINT, maxTokens: 2048 });
    if (!value) {
      return { ...noEvaluable(listing.adId, cfg.provider, cfg.model, step, error ?? "invalid response (strict JSON)"), rawResponse: raw || null };
    }
    const isSinVer = value.interior_state === "sin_ver";
    return {
      adId: listing.adId,
      provider: cfg.provider,
      model: cfg.model,
      step,
      promptVersion: PROMPT_VERSION,
      photosAnalyzed: maxPhotos === 0 ? 0 : Math.min(Number(value.photos_analyzed ?? 0), cap) || photos.length,
      photoType: normPhotoType(value.photo_type),
      exteriorState: normState(value.exterior_state, "no_evaluable"),
      interiorState: isSinVer ? "no_evaluable" : normInterior(value.interior_state),
      cleanliness: normClean(value.cleanliness),
      color: value.color ?? null,
      redFlags: Array.isArray(value.red_flags) ? value.red_flags.map(String) : [],
      details: value.exterior_details ?? null,
      rawResponse: raw || null,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (e: any) {
    if (e instanceof ProviderError) {
      if (e.kind === "unsupported_vision") {
        return noEvaluable(listing.adId, cfg.provider, cfg.model, step, `el modelo no soporta imágenes: ${e.message}`);
      }
      return noEvaluable(listing.adId, cfg.provider, cfg.model, step, `${e.kind}: ${e.message}`);
    }
    throw e;
  }
}

export interface VisionOutcome {
  primary: VisionResult[];
  reverify: VisionResult[];
  providerLabel: string;
}

/**
 * Run both vision passes over all listings.
 * - When a healthy local vision model is configured -> live passes (local_inference_only).
 * - Otherwise -> honest no_evaluable rows; reference fixtures are opt-in only.
 */
export async function runVision(
  listings: RawListing[],
  cfg: ModelConfig | null,
  health: Health | null,
  mode: "local_inference_only" | "local_preferred",
  maxPhotos?: number,
  cloudFallback: ModelConfig | null = null
): Promise<VisionOutcome> {
  const { cfg: active, decision } = selectProvider(
    mode,
    cfg ?? { provider: "vllm", baseUrl: "", model: "" },
    health ?? { ok: false, baseUrl: "", model: "" },
    cloudFallback,
    /* requireVision */ true
  );

  if (!active || !decision || active.visionCapable !== true) {
    const reason = decision?.fallbackReason ?? health?.detail ?? "no healthy vision-capable provider configured";
    const provider = active?.provider ?? "none";
    const model = active?.model ?? "n/a";
    const primary = listings.map((l) => noEvaluable(l.adId, provider, model, "primary", reason));
    const reverify = listings.map((l) => noEvaluable(l.adId, provider, model, "reverify", reason));
    return { primary, reverify, providerLabel: `${provider}/${model} (no vision result)` };
  }

  const primary: VisionResult[] = [];
  const reverify: VisionResult[] = [];
  for (const l of listings) {
    primary.push(await analyzeWithModel(active, l, "primary", false, maxPhotos));
    // Independent reverify pass: different framing, no knowledge of pass 1.
    reverify.push(await analyzeWithModel(active, l, "reverify", true, maxPhotos));
  }
  return {
    primary,
    reverify,
    providerLabel: `${decision.provider}/${decision.model}${decision.fallbackUsed ? " (fallback)" : ""}`,
  };
}
