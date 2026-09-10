/**
 * Pure, framework-free validation for search criteria — shared by the
 * Convex mutation (convex/api.ts, server-side authoritative check) and the
 * frontend form (frontend/app.ts, client-side pre-submit check) so both
 * reject exactly the same inputs with exactly the same messages. No Convex
 * runtime import here, so this is directly unit-testable with vitest.
 */

export interface RawCriteriaInput {
  make: string;
  model: string;
  maxPrice: number;
  region: string;
  maxKm?: number;
  maxPhotos?: number;
  minYear?: number;
}

export interface NormalizedCriteria {
  make: string;
  model: string;
  maxPrice: number;
  region: string;
  maxKm?: number;
  maxPhotos?: number;
  minYear?: number;
}

export type CriteriaError = {
  ok: false;
  /** Stable machine code — mirrors the codes convex/api.ts's `create`
   * mutation already returns for FREE_TIER_EXHAUSTED/PRICE_OUT_OF_RANGE
   * etc. (production Convex redacts thrown error messages, so structured
   * codes are the only way a specific reason reaches the client). */
  code: string;
  /** Form field this error applies to, for inline/field-level display. */
  field: "make" | "model" | "maxPrice" | "region" | "maxKm" | "minYear" | "maxPhotos" | "form";
  /** User-facing English message. */
  message: string;
};

export type CriteriaResult = { ok: true; criteria: NormalizedCriteria } | CriteriaError;

const MAKE_MAX_LEN = 40;
const MODEL_MAX_LEN = 40;
const REGION_MAX_LEN = 60;
const MIN_PRICE = 100;
const MAX_PRICE = 1_000_000;
const MAX_KM_CEILING = 2_000_000;
const MIN_YEAR = 1980;
const MAX_YEAR = 2030;

/** Letters (incl. accented), digits, spaces, and a small set of punctuation
 * that legitimately appears in car makes/models/regions (hyphen, apostrophe,
 * period — e.g. "Alfa Romeo", "DS 3", "Citroën", "L'Aquila"). Deliberately
 * excludes URL-structural characters (/ ? # & = % +) so a malicious or
 * accidental value can't reshape the coches.net scrape URL (worker/scrape.ts's
 * categoryUrl) or otherwise be misinterpreted downstream. */
const SAFE_TEXT_RE = /^[\p{L}\p{N} .'\-]+$/u;

function hasUnsafeChars(s: string): boolean {
  return s.length > 0 && !SAFE_TEXT_RE.test(s);
}

/** Collapses internal whitespace runs to a single space, trims ends. Guards
 * against e.g. "Toyota     " or "  Yaris  " producing odd scrape URLs. */
function cleanText(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** True for values a number input can legitimately produce as "empty":
 * "", null, undefined. NaN from a truly malformed input is handled by the
 * caller as an explicit range error, not treated as "not provided". */
function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === "";
}

export function validateCriteria(input: {
  make: unknown;
  model: unknown;
  maxPrice: unknown;
  region: unknown;
  maxKm?: unknown;
  maxPhotos?: unknown;
  minYear?: unknown;
}): CriteriaResult {
  const make = cleanText(input.make);
  const model = cleanText(input.model);
  const region = cleanText(input.region);

  if (!make) return { ok: false, code: "MAKE_REQUIRED", field: "make", message: "Please enter a make (e.g. Toyota)." };
  if (make.length > MAKE_MAX_LEN)
    return { ok: false, code: "MAKE_TOO_LONG", field: "make", message: `Make must be ${MAKE_MAX_LEN} characters or fewer.` };
  if (hasUnsafeChars(make))
    return { ok: false, code: "MAKE_INVALID_CHARS", field: "make", message: "Make can only contain letters, numbers, spaces, hyphens, apostrophes, and periods." };

  if (!model) return { ok: false, code: "MODEL_REQUIRED", field: "model", message: "Please enter a model (e.g. Yaris)." };
  if (model.length > MODEL_MAX_LEN)
    return { ok: false, code: "MODEL_TOO_LONG", field: "model", message: `Model must be ${MODEL_MAX_LEN} characters or fewer.` };
  if (hasUnsafeChars(model))
    return { ok: false, code: "MODEL_INVALID_CHARS", field: "model", message: "Model can only contain letters, numbers, spaces, hyphens, apostrophes, and periods." };

  if (!region) return { ok: false, code: "REGION_REQUIRED", field: "region", message: "Please enter a region (e.g. Barcelona)." };
  if (region.length > REGION_MAX_LEN)
    return { ok: false, code: "REGION_TOO_LONG", field: "region", message: `Region must be ${REGION_MAX_LEN} characters or fewer.` };
  if (hasUnsafeChars(region))
    return { ok: false, code: "REGION_INVALID_CHARS", field: "region", message: "Region can only contain letters, numbers, spaces, hyphens, apostrophes, and periods." };

  if (isBlank(input.maxPrice))
    return { ok: false, code: "PRICE_REQUIRED", field: "maxPrice", message: "Please enter a maximum price." };
  const maxPrice = Number(input.maxPrice);
  if (!Number.isFinite(maxPrice) || maxPrice < MIN_PRICE || maxPrice > MAX_PRICE) {
    return {
      ok: false,
      code: "PRICE_OUT_OF_RANGE",
      field: "maxPrice",
      message: `Please enter a price between €${MIN_PRICE.toLocaleString("en-GB")} and €${MAX_PRICE.toLocaleString("en-GB")}.`,
    };
  }

  const criteria: NormalizedCriteria = { make, model, maxPrice, region };

  if (!isBlank(input.maxKm)) {
    const maxKm = Number(input.maxKm);
    if (!Number.isFinite(maxKm) || !Number.isInteger(maxKm) || maxKm < 0 || maxKm > MAX_KM_CEILING) {
      return {
        ok: false,
        code: "KM_OUT_OF_RANGE",
        field: "maxKm",
        message: `Maximum kilometres must be a whole number between 0 and ${MAX_KM_CEILING.toLocaleString("en-GB")}.`,
      };
    }
    criteria.maxKm = maxKm;
  }

  if (!isBlank(input.minYear)) {
    const minYear = Number(input.minYear);
    if (!Number.isFinite(minYear) || !Number.isInteger(minYear) || minYear < MIN_YEAR || minYear > MAX_YEAR) {
      return {
        ok: false,
        code: "YEAR_OUT_OF_RANGE",
        field: "minYear",
        message: `Please enter a minimum year between ${MIN_YEAR} and ${MAX_YEAR}.`,
      };
    }
    criteria.minYear = minYear;
  }

  if (!isBlank(input.maxPhotos)) {
    const maxPhotos = Number(input.maxPhotos);
    if (!Number.isFinite(maxPhotos) || !Number.isInteger(maxPhotos) || maxPhotos < 0) {
      return {
        ok: false,
        code: "PHOTOS_OUT_OF_RANGE",
        field: "maxPhotos",
        message: "Photos per ad must be a whole number from 0 upward.",
      };
    }
    criteria.maxPhotos = maxPhotos;
  }

  return { ok: true, criteria };
}
