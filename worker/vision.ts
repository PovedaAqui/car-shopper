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
 * Backends:
 *  - local OpenAI-compatible endpoint (vLLM default), Ollama, LM Studio via
 *    the provider abstraction (health-gated)
 *  - deterministic reference fixture (the 2026-08-26 session results) only
 *    when explicitly enabled with ALLOW_REFERENCE_VISION=1 for demos/tests
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ModelConfig, Health } from "./providers.ts";
import {
  ProviderError,
  chatJson,
  selectProvider,
} from "./providers.ts";
import type { RawListing } from "./scrape.ts";

export const PROMPT_VERSION = "vision-v3-3photos";
const MAX_PHOTOS_PER_CAR = 3;

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

function noEvaluable(adId: string, provider: string, model: string, step: VisionResult["step"], reason: string, photosAnalyzed = 0): VisionResult {
  return {
    adId,
    provider,
    model,
    step,
    promptVersion: PROMPT_VERSION,
    photosAnalyzed,
    photoType: photosAnalyzed === 0 ? "sin_fotos" : undefined,
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
 */
async function analyzeWithModel(
  cfg: ModelConfig,
  listing: RawListing,
  step: VisionResult["step"],
  neutral: boolean
): Promise<VisionResult> {
  const photos = listing.photoUrls.slice(0, MAX_PHOTOS_PER_CAR);
  if (photos.length === 0) {
    return noEvaluable(listing.adId, cfg.provider, cfg.model, step, "sin fotos en el anuncio");
  }

  const system =
    "Eres un inspector de coches de segunda mano. Analiza las fotos del anuncio y responde con JSON estricto. " +
    "No inventes nada que no veas: si algo no se aprecia, usa 'no_evaluable'. " +
    (neutral
      ? "Trabaja de forma independiente: no conoces ni te has dado cuenta de otros análisis previos."
      : "");
  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    {
      type: "text",
      text: `Anuncio ${listing.adId}: ${listing.title} (${listing.price} EUR, ${listing.km} km, ${listing.year ?? "?"}). Describe: color, estado exterior visible (golpes, abolladuras, óxido, repintados, paragolpes, llantas/ruedas), limpieza, y si la foto parece profesional (fondo neutro) o amateur. ¿Aparece algún defecto visible o señal de uso/desgaste? Si una foto es del interior, describe tapicería, desgaste de asientos/volante, limpieza y salpicadero.`,
    },
    ...photos.map((u) => ({ type: "image_url" as const, image_url: { url: u } })),
  ];

  try {
    const { value, raw, result, error } = await chatJson<any>(cfg, system, userContent, { schemaHint: SCHEMA_HINT, maxTokens: 2048 });
    if (!value) {
      return { ...noEvaluable(listing.adId, cfg.provider, cfg.model, step, error ?? "respuesta no válida (JSON estricto)"), rawResponse: raw || null };
    }
    const isSinVer = value.interior_state === "sin_ver";
    return {
      adId: listing.adId,
      provider: cfg.provider,
      model: cfg.model,
      step,
      promptVersion: PROMPT_VERSION,
      photosAnalyzed: Math.min(Number(value.photos_analyzed ?? 0), MAX_PHOTOS_PER_CAR) || photos.length,
      photoType: value.photo_type,
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

/** Deterministic fallback: reference session results (same schema). */
export function referenceVision(listing: RawListing, step: "primary" | "reverify"): VisionResult {
  const here = dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(readFileSync(join(here, "fixtures", "vision_reference.json"), "utf-8"));
  const ref = data.results.find((r: any) => r.adId === listing.adId);
  if (!ref) {
    return noEvaluable(listing.adId, "reference-session", "n/a", step, "sin referencia en fixture");
  }
  return {
    adId: listing.adId,
    provider: "reference-session",
    model: "fixture-2026-08-26",
    step,
    promptVersion: PROMPT_VERSION,
    photosAnalyzed: ref.photosAnalyzed ?? 0,
    photoType: ref.photoType,
    exteriorState: ref.exteriorState,
    interiorState: normInterior(ref.interiorState),
    cleanliness: normClean(ref.cleanliness),
    color: ref.color ?? null,
    redFlags: ref.redFlags ?? [],
    details: ref.details ?? null,
    noEvaluableReason: ref.exteriorState === "no_evaluable" ? "no evaluable en la sesión de referencia" : null,
  };
}

export interface VisionOutcome {
  primary: VisionResult[];
  reverify: VisionResult[];
  providerLabel: string;
  usedReference: boolean;
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
  mode: "local_inference_only" | "local_preferred"
): Promise<VisionOutcome> {
  const { cfg: active, decision } = selectProvider(
    mode,
    cfg ?? { provider: "vllm", baseUrl: "", model: "" },
    health ?? { ok: false, baseUrl: "", model: "" },
    null
  );

  if (!active || !decision || active.visionCapable !== true) {
    if (process.env.ALLOW_REFERENCE_VISION === "1") {
      const primary = listings.map((l) => referenceVision(l, "primary"));
      const reverify = listings.map((l) => referenceVision(l, "reverify"));
      return { primary, reverify, providerLabel: "reference-session (explicit demo fixture)", usedReference: true };
    }
    const reason = decision?.fallbackReason ?? health?.detail ?? "no healthy vision-capable provider configured";
    const provider = active?.provider ?? "none";
    const model = active?.model ?? "n/a";
    const primary = listings.map((l) => noEvaluable(l.adId, provider, model, "primary", reason));
    const reverify = listings.map((l) => noEvaluable(l.adId, provider, model, "reverify", reason));
    return { primary, reverify, providerLabel: `${provider}/${model} (no vision result)`, usedReference: false };
  }

  const primary: VisionResult[] = [];
  const reverify: VisionResult[] = [];
  for (const l of listings) {
    primary.push(await analyzeWithModel(active, l, "primary", false));
    // Independent reverify pass: different framing, no knowledge of pass 1.
    reverify.push(await analyzeWithModel(active, l, "reverify", true));
  }
  return {
    primary,
    reverify,
    providerLabel: `${decision.provider}/${decision.model}${decision.fallbackUsed ? " (fallback)" : ""}`,
    usedReference: false,
  };
}
