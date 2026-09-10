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

export const PROMPT_VERSION = "vision-v4";
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
  '{"photos_analyzed": int, "photo_type": "profesional|amateur|sin_fotos|stock_sospechoso", "exterior_state": "bien|regular|mal|no_evaluable", "interior_state": "bien|regular|mal|no_evaluable|sin_ver", "exterior_details": string (cite specific visible evidence for exterior_state, e.g. \"scratch on rear bumper, curbed front-left wheel\" — not a generic summary), "cleanliness": "limpio|regular|descuidado|no_evaluable", "color": string|null, "red_flags": string[]}';

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
    "You are conducting an independent, evidence-based visual inspection of a used car from its ad photos. " +
    "Respond with strict JSON matching the given schema. Base every judgment ONLY on what is visible in the " +
    "photos themselves — never infer condition from the car's price, brand, or age, and never assume a defect " +
    "or good condition just because it would be 'typical' for a car like this. If something is not visible, " +
    "not clear enough to judge, or you are not confident, use 'no_evaluable' rather than guessing.\n\n" +
    "Rate exterior_state with this rubric:\n" +
    "- 'bien' = no visible damage beyond very light, expected wear (faint stone chips, light wash swirls); " +
    "paint and panels look consistent.\n" +
    "- 'regular' = visible cosmetic wear — scratches, small dents, curbed/scuffed wheels, faded or mismatched " +
    "trim — but nothing suggesting structural or safety-relevant damage.\n" +
    "- 'mal' = visible dents, rust, cracked bumpers or lights, a body panel with a different paint shade " +
    "(respray/mismatch), or other signs of a repaired collision.\n" +
    "- 'no_evaluable' = the photos don't show the exterior clearly enough to judge either way.\n\n" +
    "Rate interior_state the same three-tier way (upholstery wear, dashboard condition, general trim " +
    "condition) using ONLY interior photos. Use 'sin_ver' when no interior photo was provided at all — that " +
    "is different from 'no_evaluable', which means an interior photo exists but is too unclear to judge.\n\n" +
    "Rate cleanliness ('limpio'/'regular'/'descuidado') from visible dirt, dust, or clutter in the photos — " +
    "not from assumptions about how the car has been used.\n\n" +
    "Set photo_type:\n" +
    "- 'profesional' = dealer/studio-style photos: neutral or plain background, consistent lighting, straight " +
    "angles.\n" +
    "- 'amateur' = photos that look taken by a private seller: driveway/street background, inconsistent " +
    "angles or lighting.\n" +
    "- 'stock_sospechoso' = the photo looks like a manufacturer/press stock image rather than a photo of the " +
    "actual car for sale (e.g. a studio background that doesn't fit a private ad, a generic angle, no visible " +
    "surroundings or plate) — flag this so a stock photo isn't mistaken for evidence about the real car.\n" +
    "- 'sin_fotos' = no photos were provided.\n\n" +
    "For red_flags, list ONLY concrete signs of undisclosed damage, poor prior repair, flood/fire damage, " +
    "structural rust, or a mismatch between the photos and the ad's own text (e.g. the photo shows a " +
    "different colour or trim than described). Ordinary wear consistent with the car's visible condition is " +
    "NOT a red flag — do not list it as one.\n\n" +
    "The fields photo_type, exterior_state, interior_state, and cleanliness MUST use exactly one of the " +
    "Spanish enum values given in the schema ('bien', 'regular', 'mal', 'no_evaluable', 'profesional', " +
    "'amateur', 'sin_fotos', 'stock_sospechoso', 'limpio', 'descuidado', 'sin_ver') — never translate or " +
    "invent other values for those fields. Only exterior_details and red_flags are free text: write those " +
    "two fields in plain, factual English — no marketing tone, no speculation beyond what the photos show.\n\n" +
    (neutral
      ? "This is an independent second read of these same photos: reach your own conclusion from scratch. " +
        "Do not assume any other assessment of this car exists, and do not try to match an expected answer."
      : "This is the first independent read of these photos.");
  // Note: price is deliberately NOT included below — including it risks
  // anchoring the model toward "cheap therefore worse" or "expensive
  // therefore fine" reasoning instead of judging only what's visible.
  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    {
      type: "text",
      text: `Listing ${listing.adId}: ${listing.title} (${listing.km} km, year ${listing.year ?? "unknown"}). Apply the rubric above to the photos below.`,
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
