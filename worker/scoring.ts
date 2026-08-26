/**
 * Deterministic scoring engine (plan §4 stages 3 & 7).
 *
 * PURE — no LLM. Score = f(€/km, año, extras, riesgo mecánico) + fixed visual
 * delta tables from the 2026-08-26 reference session. Every score is
 * reconstructable from (normalized listing, scorer version, stored vision
 * results): criterion #2 of plan §10.
 */

export const SCORER_VERSION = "score-1.0.0";

export interface ListingInput {
  adId: string;
  price: number;
  km: number;
  year?: number | null;
  hasWarranty: boolean;
  isPro: boolean;
  dataQualityFlag: "ok" | "corrupt" | "duplicate";
  duplicateOfAdId?: string | null;
}

export interface VisionDeltaInput {
  /** From consensus: bien | regular | mal | no_evaluable */
  resolvedExterior: "bien" | "regular" | "mal" | "no_evaluable";
  /** Any interior visible and in good state (plan §4 stage 4 lesson). */
  interiorGood: boolean;
  /** Suspect stock photos (single isolated part, watermark-heavy set…). */
  suspectStock: boolean;
  /** Listing has zero photos. */
  noPhotos: boolean;
}

export interface ScoreRow {
  adId: string;
  base: number;
  bonuses: number;
  riskFactor: number;
  visDelta: number;
  final: number;
  pricePerKm: number;
  notes: string[];
  included: boolean;
  exclusionReason?: string;
  rank?: number;
}

/** €/km normalization: 10000 €/1000 km = 10 €/1000km. Higher score = better deal. */
const BASE_MAX = 100;

export function pricePerKm(price: number, km: number): number {
  if (km <= 0) return 0;
  return price / (km / 1000);
}

/**
 * Base score from €/km. Inverse-scaled: a car at 2 €/km scores far above one
 * at 8 €/km. Saturated at 0.5 €/km (base = 100) and 10 €/km (base = 0).
 */
export function baseScore(pricePerKmEur: number): number {
  if (pricePerKmEur <= 0) return 0;
  const lo = 0.5;
  const hi = 10;
  const t = Math.min(1, Math.max(0, (hi - pricePerKmEur) / (hi - lo)));
  return BASE_MAX * t;
}

export function bonusPoints(l: ListingInput): { bonuses: number; notes: string[] } {
  const notes: string[] = [];
  let b = 0;
  if (l.hasWarranty) {
    b += 5;
    notes.push("garantía +5");
  }
  if (l.isPro) {
    b += 4;
    notes.push("profesional +4");
  }
  if (l.year && l.year >= 2010) {
    b += 3;
    notes.push("año reciente +3");
  }
  return { bonuses: b, notes };
}

export function riskPenalty(l: ListingInput): { riskFactor: number; notes: string[] } {
  const notes: string[] = [];
  let p = 0;
  if (l.km > 250_000) {
    p += 12;
    notes.push("km>250k −12");
  } else if (l.km > 200_000) {
    p += 6;
    notes.push("km>200k −6");
  }
  if (l.year && l.year < 2005) {
    p += 4;
    notes.push("año<2005 −4");
  }
  return { riskFactor: -p, notes };
}

/**
 * Fixed visual delta tables (plan §4 stage 7, values from the reference
 * session): desgaste −6, sin fotos −5, stock sospechoso −40, interior visto +4.
 */
export function visualDelta(v: VisionDeltaInput): { visDelta: number; notes: string[] } {
  const notes: string[] = [];
  let d = 0;
  switch (v.resolvedExterior) {
    case "bien":
      d += 2;
      notes.push("exterior bien +2");
      break;
    case "regular":
      d += -6;
      notes.push("desgaste/regular −6");
      break;
    case "mal":
      d += -18;
      notes.push("exterior mal −18");
      break;
    case "no_evaluable":
      d += -2;
      notes.push("exterior no evaluable −2");
      break;
  }
  if (v.interiorGood) {
    d += 4;
    notes.push("interior visto bien +4");
  }
  if (v.noPhotos) {
    d += -5;
    notes.push("sin fotos −5");
  }
  if (v.suspectStock) {
    d += -40;
    notes.push("stock sospechoso −40");
  }
  return { visDelta: d, notes };
}

/**
 * Rank v1 (no vision) or v2 (with vision). Corrupt/duplicate listings are
 * excluded from the ranking (plan §4 stage 2) but kept for transparency.
 */
export function scoreAll(
  listings: ListingInput[],
  visionByAd: Map<string, VisionDeltaInput | null>
): ScoreRow[] {
  const rows = listings.map((l) => {
    const ppk = pricePerKm(l.price, l.km);
    const notes: string[] = [];
    if (l.dataQualityFlag === "corrupt") {
      notes.push("datos corruptos (excluido del ranking)");
      return {
        adId: l.adId, base: 0, bonuses: 0, riskFactor: 0, visDelta: 0, final: 0,
        pricePerKm: ppk, notes, included: false,
        exclusionReason: "datos corruptos",
      } as ScoreRow;
    }
    if (l.dataQualityFlag === "duplicate") {
      notes.push(`duplicado de ${l.duplicateOfAdId ?? "?"} (excluido)`);
      return {
        adId: l.adId, base: 0, bonuses: 0, riskFactor: 0, visDelta: 0, final: 0,
        pricePerKm: ppk, notes, included: false,
        exclusionReason: `duplicado de ${l.duplicateOfAdId ?? "?"}`,
      } as ScoreRow;
    }
    const base = baseScore(ppk);
    const { bonuses, notes: bNotes } = bonusPoints(l);
    const { riskFactor, notes: rNotes } = riskPenalty(l);
    notes.push(...bNotes, ...rNotes);
    const vIn = visionByAd.get(l.adId) ?? null;
    const vd = vIn ? visualDelta(vIn) : { visDelta: 0, notes: ["sin inspección visual (0)"] };
    notes.push(...vd.notes);
    const final = Math.max(0, base + bonuses + riskFactor + vd.visDelta);
    return { adId: l.adId, base: round1(base), bonuses, riskFactor, visDelta: vd.visDelta, final: round1(final), pricePerKm: round1(ppk), notes, included: true } as ScoreRow;
  });

  // Rank v2: order included rows by final score desc.
  const included = rows.filter((r) => r.included).sort((a, b) => b.final - a.final || a.pricePerKm - b.pricePerKm);
  included.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/** Assign ranks to the (already scored) rows. */
export function assignRanks(rows: ScoreRow[]): void {
  const included = rows.filter((r) => r.included).sort((a, b) => b.final - a.final || a.pricePerKm - b.pricePerKm);
  for (const r of rows) r.rank = undefined;
  included.forEach((r, i) => { r.rank = i + 1; });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
