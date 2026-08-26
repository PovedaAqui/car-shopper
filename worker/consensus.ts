/**
 * Deterministic consensus (plan §4 stage 6).
 *
 * Cross-checks two independent vision passes per car. Discrepancy -> severe
 * criterion (never invent). Pure function: `resolve(ext_a, ext_b) ->
 * (estado, badge consenso/discrepancia)`.
 */

export const CONSENSUS_VERSION = "consensus-1.0.0";

export type ExtState = "bien" | "regular" | "mal" | "no_evaluable";

const SEVERITY: Record<ExtState, number> = {
  bien: 0,
  regular: 1,
  mal: 2,
  no_evaluable: -1,
};

export interface ConsensusRow {
  adId: string;
  extA: string;
  extB: string;
  agreed: boolean;
  resolvedState: ExtState;
  badge: "consenso" | "discrepancia" | "no_evaluable";
  flags: string[];
}

/**
 * Resolution rule:
 * - both evaluable and equal  -> consenso, that state
 * - both evaluable, different -> discrepancia, take the SEVERE state (criterio
 *   severo)
 * - one or both no_evaluable  -> no_evaluable badge, resolved state is the
 *   evaluable one (or no_evaluable)
 */
export function resolve(adId: string, extA: ExtState, extB: ExtState): ConsensusRow {
  const flags: string[] = [];
  const aEval = extA !== "no_evaluable";
  const bEval = extB !== "no_evaluable";

  if (!aEval && !bEval) {
    return { adId, extA, extB, agreed: true, resolvedState: "no_evaluable", badge: "no_evaluable", flags: ["ambas pasadas no evaluables"] };
  }
  if (aEval && bEval) {
    if (extA === extB) {
      return { adId, extA, extB, agreed: true, resolvedState: extA, badge: "consenso", flags: [] };
    }
    const resolved = SEVERITY[extA] >= SEVERITY[extB] ? extA : extB;
    flags.push(`discrepancia (${extA} vs ${extB}) -> criterio severo: ${resolved}`);
    return { adId, extA, extB, agreed: false, resolvedState: resolved, badge: "discrepancia", flags };
  }
  // Exactly one evaluable.
  const resolved = aEval ? extA : extB;
  flags.push(`solo una pasada evaluable (${resolved})`);
  return { adId, extA, extB, agreed: false, resolvedState: resolved, badge: "no_evaluable", flags };
}

/**
 * Full consensus pass over all cars. `primary` and `reverify` are two
 * independent per-car exterior states (the reverify pass never sees the
 * primary output — plan §4 stage 5).
 */
export function consensusAll(
  adIds: string[],
  primary: Map<string, ExtState>,
  reverify: Map<string, ExtState>
): ConsensusRow[] {
  return adIds.map((adId) => {
    const a = primary.get(adId) ?? "no_evaluable";
    const b = reverify.get(adId) ?? "no_evaluable";
    return resolve(adId, a, b);
  });
}
